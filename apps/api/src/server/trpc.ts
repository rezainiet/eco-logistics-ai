import { createHash } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import jwt from "jsonwebtoken";
import { LRUCache } from "lru-cache";
import { Types } from "mongoose";
import { Merchant } from "@ecom/db";
import { env } from "../env.js";

export interface AuthUser {
  id: string;
  email: string;
  role: "merchant" | "admin" | "agent";
}

import type { PlanTier } from "../lib/plans.js";

export interface SubscriptionSnapshot {
  status: "trial" | "active" | "past_due" | "paused" | "cancelled";
  tier: PlanTier;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

const tokenCache = new LRUCache<string, AuthUser>({ max: 10_000, ttl: 60_000 });
const subCache = new LRUCache<string, SubscriptionSnapshot>({ max: 10_000, ttl: 30_000 });

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("base64url").slice(0, 22);
}

function extractClientIp(req: CreateExpressContextOptions["req"]): string | null {
  // Express already honours `app.set("trust proxy", 1)` and surfaces the
  // leftmost X-Forwarded-For hop via req.ip. We fall back to the raw socket
  // address if the header is absent (direct LAN hits, tests).
  const fromReq = req.ip;
  if (fromReq && fromReq !== "::1" && fromReq !== "127.0.0.1") return fromReq;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const sock = req.socket?.remoteAddress;
  return sock ?? fromReq ?? null;
}

export interface RequestMetadata {
  ip: string | null;
  userAgent: string | null;
}

export function createContext({ req }: CreateExpressContextOptions): {
  user: AuthUser | null;
  request: RequestMetadata;
} {
  const auth = req.headers.authorization;
  let user: AuthUser | null = null;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const key = fingerprint(token);
    const hit = tokenCache.get(key);
    if (hit) {
      user = hit;
    } else {
      try {
        user = jwt.verify(token, env.JWT_SECRET, {
          algorithms: ["HS256"],
          clockTolerance: 5,
        }) as AuthUser;
        tokenCache.set(key, user);
      } catch {
        user = null;
      }
    }
  }
  const ua = req.headers["user-agent"];
  const request: RequestMetadata = {
    ip: extractClientIp(req),
    userAgent: typeof ua === "string" ? ua.slice(0, 500) : null,
  };
  return { user, request };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({
    ctx: {
      user: ctx.user,
      request: ctx.request ?? { ip: null, userAgent: null },
    },
  });
});

export function invalidateSubscriptionCache(merchantId: string): void {
  subCache.delete(merchantId);
}

async function loadSubscription(userId: string): Promise<SubscriptionSnapshot | null> {
  const cached = subCache.get(userId);
  if (cached) return cached;
  if (!Types.ObjectId.isValid(userId)) return null;
  const m = await Merchant.findById(userId)
    .select(
      "subscription.status subscription.tier subscription.trialEndsAt subscription.currentPeriodEnd",
    )
    .lean();
  if (!m) return null;
  const snap: SubscriptionSnapshot = {
    status: (m.subscription?.status ?? "trial") as SubscriptionSnapshot["status"],
    tier: (m.subscription?.tier ?? "starter") as SubscriptionSnapshot["tier"],
    trialEndsAt: m.subscription?.trialEndsAt ?? null,
    currentPeriodEnd: m.subscription?.currentPeriodEnd ?? null,
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

  if (sub.status === "trial") {
    if (!sub.trialEndsAt || sub.trialEndsAt.getTime() > Date.now()) {
      return next({ ctx: { ...ctx, subscription: sub } });
    }
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "trial_expired",
    });
  }

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
 * Admin-only procedures (role-gated via JWT claim). Used for billing approvals,
 * tenant management, and other back-office flows.
 */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "admin role required" });
  }
  return next({ ctx });
});
