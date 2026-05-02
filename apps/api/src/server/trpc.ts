import { createHash, timingSafeEqual } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { LRUCache } from "lru-cache";
import { Types } from "mongoose";
import { Merchant } from "@ecom/db";
import { env } from "../env.js";
import { sessionExists } from "../lib/sessionStore.js";

export interface AuthUser {
  id: string;
  email: string;
  role: "merchant" | "admin" | "agent";
  /**
   * Session id from the access JWT. Always present for HTTP requests that
   * went through `/auth/login` or `/auth/refresh`; absent for synthetic
   * test users built via `callerFor` (those skip JWT decoding entirely).
   */
  sid?: string;
}

const ACCESS_COOKIE = "access_token";
const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const p of raw.split(";")) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    if (p.slice(0, eq).trim() === name) {
      return decodeURIComponent(p.slice(eq + 1).trim());
    }
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

import type { PlanTier } from "../lib/plans.js";

export interface SubscriptionSnapshot {
  status: "trial" | "active" | "past_due" | "paused" | "suspended" | "cancelled";
  tier: PlanTier;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  gracePeriodEndsAt: Date | null;
}

const tokenCache = new LRUCache<string, AuthUser>({ max: 10_000, ttl: 60_000 });
const subCache = new LRUCache<string, SubscriptionSnapshot>({ max: 10_000, ttl: 30_000 });
/**
 * Cached "this sid is currently valid" decisions. Without this every
 * protected call would round-trip Redis. 30 s TTL trades a brief revocation
 * window (≤30 s) for the request-rate gain — `/auth/logout-all` propagates
 * within half a minute, well inside the threat model.
 */
const sidValidCache = new LRUCache<string, boolean>({ max: 20_000, ttl: 30_000 });

export function invalidateSidCache(merchantId: string, sid: string): void {
  sidValidCache.delete(`${merchantId}:${sid}`);
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("base64url").slice(0, 22);
}

function extractClientIp(req: CreateExpressContextOptions["req"]): string | null {
  // Trust ONLY the value Express derived using `trust proxy` config. We
  // deliberately do NOT fall back to the raw `X-Forwarded-For` header — that
  // path is exactly the spoof vector: a direct caller can set whatever they
  // want there and we'd record it as the client IP. If the request is
  // genuinely behind a trusted edge proxy, Express has already parsed the
  // header for us and surfaced the right hop on `req.ip`. If there's no
  // proxy, the socket address (still on `req.ip`) is the truth.
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

export interface RequestMetadata {
  ip: string | null;
  userAgent: string | null;
  /**
   * True when the auth token came from the HttpOnly cookie (browser
   * session). False when it came from the Authorization header (programmatic
   * call). CSRF enforcement only kicks in for cookie sessions — Bearer
   * callers cannot be CSRF'd because no cookie is auto-attached.
   */
  cookieAuth: boolean;
  csrfHeader: string | null;
  csrfCookie: string | null;
}

export function createContext({ req }: CreateExpressContextOptions): {
  user: AuthUser | null;
  request: RequestMetadata;
} {
  // Cookie-first: a browser session sets the access_token cookie on login
  // and the SPA never has to touch the JWT. Bearer is still accepted for
  // programmatic callers (CLI, tests, partner integrations).
  const cookieToken = readCookie(req, ACCESS_COOKIE);
  let token: string | null = null;
  let cookieAuth = false;
  if (cookieToken) {
    token = cookieToken;
    cookieAuth = true;
  } else {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      token = auth.slice(7);
    }
  }
  let user: AuthUser | null = null;
  if (token) {
    const key = fingerprint(token);
    const hit = tokenCache.get(key);
    if (hit) {
      user = hit;
    } else {
      try {
        const decoded = jwt.verify(token, env.JWT_SECRET, {
          algorithms: ["HS256"],
          clockTolerance: 5,
        }) as AuthUser & { typ?: string; sid?: string };
        // Refresh tokens must never authenticate API calls — they are
        // exclusively for /auth/refresh.
        if (decoded.typ === "refresh") {
          user = null;
        } else {
          user = {
            id: decoded.id,
            email: decoded.email,
            role: decoded.role,
            sid: decoded.sid,
          };
          tokenCache.set(key, user);
        }
      } catch {
        user = null;
      }
    }
  }
  const ua = req.headers["user-agent"];
  const csrfHeaderRaw = req.headers[CSRF_HEADER];
  const csrfHeader = Array.isArray(csrfHeaderRaw) ? csrfHeaderRaw[0] ?? null : csrfHeaderRaw ?? null;
  const request: RequestMetadata = {
    ip: extractClientIp(req),
    userAgent: typeof ua === "string" ? ua.slice(0, 500) : null,
    cookieAuth,
    csrfHeader,
    csrfCookie: readCookie(req, CSRF_COOKIE),
  };
  return { user, request };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error, ctx }) {
    // Forward any unexpected error (5xx-ish — internal server errors,
    // failures inside handlers) to telemetry so we see them in Sentry. We
    // intentionally skip 4xx-class TRPCErrors (UNAUTHORIZED, BAD_REQUEST,
    // NOT_FOUND, FORBIDDEN, CONFLICT) — those are control-flow signals,
    // not bugs.
    const code = error.code;
    const isInternal =
      code === "INTERNAL_SERVER_ERROR" ||
      (error.cause instanceof Error && code !== "BAD_REQUEST");
    if (isInternal) {
      // Lazy import keeps the worker bundle from pulling telemetry at load
      // time when the env DSN is unset and the import is a no-op anyway.
      void import("../lib/telemetry.js").then(({ captureException }) => {
        captureException(error.cause ?? error, {
          tags: { source: "trpc", code },
          user: ctx?.user ? { id: ctx.user.id, email: ctx.user.email } : undefined,
        });
      });
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next, type }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  // CSRF (double-submit cookie) is enforced on mutations from cookie-auth
  // sessions. Bearer-token callers (tests, programmatic API) are exempt
  // because no cookie is auto-attached on cross-origin requests for them.
  if (type === "mutation" && ctx.request?.cookieAuth) {
    const header = ctx.request.csrfHeader;
    const cookie = ctx.request.csrfCookie;
    if (!header || !cookie || !constantTimeEqual(header, cookie)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "csrf token missing or invalid" });
    }
  }
  // Session-id check — the access JWT carries an `sid` claim that has to
  // exist in the server-side store. This is what makes `/auth/logout` and
  // `/auth/logout-all` actually revoke a token rather than just deleting
  // a cookie. Skipped when the JWT didn't carry a sid (synthetic test
  // users via `callerFor`, or legacy bearer tokens issued before this
  // landed — those still authenticate but are flagged as session-less so
  // ops can detect any unexpected callers).
  if (ctx.user.sid) {
    const cacheKey = `${ctx.user.id}:${ctx.user.sid}`;
    let valid = sidValidCache.get(cacheKey);
    if (valid === undefined) {
      valid = await sessionExists(ctx.user.id, ctx.user.sid);
      sidValidCache.set(cacheKey, valid);
    }
    if (!valid) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "session revoked" });
    }
  }
  return next({
    ctx: {
      user: ctx.user,
      request: ctx.request ?? {
        ip: null,
        userAgent: null,
        cookieAuth: false,
        csrfHeader: null,
        csrfCookie: null,
      },
    },
  });
});

/**
 * Convert the authenticated tRPC context's user.id (string) into a Mongo
 * ObjectId. Centralised here so every router gets identical behaviour.
 */
export function merchantObjectId(ctx: { user: { id: string } }): Types.ObjectId {
  return new Types.ObjectId(ctx.user.id);
}

export function invalidateSubscriptionCache(merchantId: string): void {
  subCache.delete(merchantId);
}

async function loadSubscription(userId: string): Promise<SubscriptionSnapshot | null> {
  const cached = subCache.get(userId);
  if (cached) return cached;
  if (!Types.ObjectId.isValid(userId)) return null;
  const m = await Merchant.findById(userId)
    .select(
      "subscription.status subscription.tier subscription.trialEndsAt subscription.currentPeriodEnd subscription.gracePeriodEndsAt",
    )
    .lean();
  if (!m) return null;
  const snap: SubscriptionSnapshot = {
    status: (m.subscription?.status ?? "trial") as SubscriptionSnapshot["status"],
    tier: (m.subscription?.tier ?? "starter") as SubscriptionSnapshot["tier"],
    trialEndsAt: m.subscription?.trialEndsAt ?? null,
    currentPeriodEnd: m.subscription?.currentPeriodEnd ?? null,
    gracePeriodEndsAt:
      (m.subscription as { gracePeriodEndsAt?: Date } | undefined)?.gracePeriodEndsAt ?? null,
  };
  subCache.set(userId, snap);
  return snap;
}

export async function loadSubscriptionSnapshot(
  userId: string,
): Promise<SubscriptionSnapshot | null> {
  return loadSubscription(userId);
}

/**
 * Gate expensive or revenue-adjacent procedures behind an active subscription.
 * Trial counts as active until `trialEndsAt`. Admin role bypasses.
 */
export const billableProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role === "admin") {
    return next({ ctx: { ...ctx, subscription: null } });
  }
  const sub = await loadSubscription(ctx.user.id);
  if (!sub) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "merchant not found" });
  }

  if (sub.status === "active") {
    // If a paid period has lapsed, treat as past_due — Billing page drives recovery.
    if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= Date.now()) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "subscription_past_due",
      });
    }
    return next({ ctx: { ...ctx, subscription: sub } });
  }

  // past_due is a soft state — let the merchant keep working until the grace
  // period closes. The billing UI shows a loud banner with the recovery CTA.
  if (sub.status === "past_due") {
    if (sub.gracePeriodEndsAt && sub.gracePeriodEndsAt.getTime() <= Date.now()) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "subscription_grace_expired",
      });
    }
    return next({ ctx: { ...ctx, subscription: sub } });
  }

  if (sub.status === "trial") {
    if (!sub.trialEndsAt || sub.trialEndsAt.getTime() > Date.now()) {
      return next({ ctx: { ...ctx, subscription: sub } });
    }
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "trial_expired",
    });
  }

  // suspended / paused / cancelled all hard-block billable work.
  throw new TRPCError({
    code: "FORBIDDEN",
    message: `subscription_${sub.status}`,
  });
});

/**
 * Best-effort client-IP reader for procedures that need to persist the hit.
 * Returns `null` when the context didn't include request metadata (unit tests
 * call `createCaller` without an Express req — that's expected).
 */
export function requestIp(ctx: { request?: RequestMetadata }): string | null {
  return ctx.request?.ip ?? null;
}

export function requestUserAgent(ctx: { request?: RequestMetadata }): string | null {
  return ctx.request?.userAgent ?? null;
}

/**
 * Cache of the *DB-confirmed* role per merchant. The JWT carries a role
 * claim but a forged or stale claim must not grant admin — adminProcedure
 * re-validates against the Merchant document. Short TTL so a demoted user
 * loses access within a minute even if their session is still warm.
 */
// LRUCache requires its value type to extend `{}` (no null), so we encode
// "no role" as the literal string "none" and unmap on read.
type CachedRole = AuthUser["role"] | "none";
const dbRoleCache = new LRUCache<string, CachedRole>({
  max: 5_000,
  ttl: 60_000,
});

async function loadDbRole(userId: string): Promise<AuthUser["role"] | null> {
  const cached = dbRoleCache.get(userId);
  if (cached !== undefined) return cached === "none" ? null : cached;
  if (!Types.ObjectId.isValid(userId)) {
    dbRoleCache.set(userId, "none");
    return null;
  }
  const m = await Merchant.findById(userId).select("role").lean();
  const role = (m?.role ?? null) as AuthUser["role"] | null;
  dbRoleCache.set(userId, role ?? "none");
  return role;
}

export function invalidateRoleCache(userId: string): void {
  dbRoleCache.delete(userId);
}

/**
 * Admin-only procedures. The JWT role claim is treated as advisory only —
 * we re-load the role from the Merchant document (cached 60s) before
 * granting admin access. A token forged with `role:"admin"` cannot bypass
 * this because the DB row is the source of truth.
 */
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const dbRole = await loadDbRole(ctx.user.id);
  if (dbRole !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "admin role required" });
  }
  return next({ ctx: { ...ctx, user: { ...ctx.user, role: dbRole } } });
});

import {
  assertPermission,
  loadAdminProfile,
  type AdminScope,
  type Permission,
} from "../lib/admin-rbac.js";
import { writeAdminAudit } from "../lib/audit.js";
import { Types as MongoTypes } from "mongoose";

/**
 * Scope-aware admin procedure factory. `scopedAdminProcedure("payment.approve")`
 * returns a procedure that enforces:
 *   1. authenticated session (protectedProcedure base)
 *   2. role === "admin" (DB-confirmed, JWT advisory)
 *   3. holds a scope that authorizes the named permission
 *
 * The resolved scope (super_admin / finance_admin / support_admin) lands in
 * `ctx.adminScope` so handlers can stamp it into the audit trail without
 * re-deriving it.
 *
 * Unauthorized attempts emit an `admin.unauthorized_attempt` audit row so
 * a security review can surface scope-fishing behavior.
 */
export function scopedAdminProcedure(permission: Permission) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    const profile = await loadAdminProfile(ctx.user.id);
    let scope: AdminScope;
    try {
      scope = assertPermission(profile, permission);
    } catch (err) {
      void writeAdminAudit({
        actorId: new MongoTypes.ObjectId(ctx.user.id),
        actorEmail: ctx.user.email,
        actorType: "admin",
        action: "admin.unauthorized_attempt",
        subjectType: "admin",
        subjectId: new MongoTypes.ObjectId(ctx.user.id),
        meta: {
          permission,
          role: profile?.role ?? null,
          scopes: profile?.scopes ?? [],
        },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });
      throw err;
    }
    return next({
      ctx: {
        ...ctx,
        user: { ...ctx.user, role: "admin" as const },
        adminScope: scope,
        adminScopes: profile?.scopes ?? [],
      },
    });
  });
}
