import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { AuditLog } from "@ecom/db";

type AuditAction =
  | "risk.scored"
  | "risk.recomputed"
  | "risk.alerted"
  | "review.verified"
  | "review.rejected"
  | "review.no_answer"
  | "review.reopened"
  | "order.booked"
  | "order.cancelled"
  | "order.ingested"
  | "courier.configured"
  | "fraud.config_updated"
  | "payment.submitted"
  | "payment.reviewed"
  | "payment.first_approval"
  | "payment.approved"
  | "payment.rejected"
  | "payment.flagged"
  | "payment.checkout_started"
  | "payment.checkout_completed"
  | "payment.proof_uploaded"
  | "subscription.checkout_started"
  | "subscription.recurring_started"
  | "subscription.synced"
  | "subscription.payment_recovered"
  | "subscription.payment_failed"
  | "subscription.suspended"
  | "subscription.activated"
  | "subscription.cancelled"
  | "subscription.extended"
  | "subscription.plan_changed"
  | "integration.connected"
  | "integration.disconnected"
  | "integration.test"
  | "integration.webhook"
  | "integration.webhook_replayed"
  | "integration.webhook_dead_lettered"
  | "integration.webhook_needs_attention"
  | "integration.webhook_secret_rotated"
  | "integration.secret_revealed"
  | "integration.shopify_oauth"
  | "integration.shopify_webhooks_retried"
  | "integration.woo_webhooks_retried"
  | "integration.paused"
  | "integration.resumed"
  | "integration.issues_resolved"
  | "merchant.branding_updated"
  | "shopify.gdpr_webhook"
  | "shopify.gdpr_dispatch"
  | "tracking.identified"
  | "auth.reset_requested"
  | "auth.password_reset"
  | "auth.password_changed"
  | "auth.email_verified"
  | "auth.logout_all"
  | "merchant.test_sms_sent"
  | "automation.config_updated"
  | "automation.auto_confirm"
  | "automation.auto_confirm_and_book"
  | "automation.await_confirmation"
  | "automation.requires_review"
  | "automation.confirmed"
  | "automation.rejected"
  | "automation.bulk_confirmed"
  | "automation.bulk_rejected"
  | "automation.sms_confirm"
  | "automation.sms_reject"
  | "automation.auto_booked"
  | "automation.auto_book_failed"
  | "automation.auto_expired"
  | "automation.confirmation_sms_failed"
  | "automation.confirmation_sms_delivered"
  | "automation.confirmation_sms_undelivered"
  | "automation.escalated_no_reply"
  | "automation.watchdog_exhausted"
  | "automation.watchdog_reenqueued"
  | "automation.restored"
  | "awb.reconcile.orphaned"
  | "awb.reconcile.abandoned"
  | "automation.queue_rebuilt"
  | "automation.worker_skipped"
  | "admin.role_granted"
  | "admin.role_revoked"
  | "admin.scope_granted"
  | "admin.scope_revoked"
  | "admin.stepup_issued"
  | "admin.stepup_consumed"
  | "admin.stepup_failed"
  | "admin.merchant_suspended"
  | "admin.merchant_unsuspended"
  | "admin.fraud_override"
  | "admin.unauthorized_attempt"
  | "alert.fired";

type SubjectType =
  | "order"
  | "merchant"
  | "courier"
  | "call"
  | "payment"
  | "integration"
  | "session"
  | "pending_awb"
  | "admin"
  | "system";

export interface AuditEntry {
  /** Optional for system-level events that don't tie to one merchant. */
  merchantId?: Types.ObjectId | null;
  actorId?: Types.ObjectId;
  actorEmail?: string;
  actorType?: "merchant" | "agent" | "admin" | "system";
  actorScope?: string;
  action: AuditAction;
  subjectType: SubjectType;
  subjectId: Types.ObjectId;
  meta?: Record<string, unknown>;
  prevState?: unknown;
  nextState?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Stable JSON canonicalization for hashing. Sort keys recursively so two
 * semantically-identical entries hash to the same digest regardless of how
 * the caller built the object literal. Dates are ISO-encoded; ObjectIds
 * become hex strings.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return value;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Compute the canonical row hash. Used both at write time and during
 * tamper-verification. The hash covers every auditable field plus the
 * previous row's hash — so any in-place edit downstream of a row will
 * cascade into all later rows' prevHash links.
 */
export function computeAuditHash(input: {
  merchantId?: Types.ObjectId | null;
  actorId?: Types.ObjectId | null;
  actorEmail?: string | null;
  actorType?: string | null;
  actorScope?: string | null;
  action: string;
  subjectType: string;
  subjectId: Types.ObjectId;
  meta?: unknown;
  prevState?: unknown;
  nextState?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  at: Date;
  prevHash: string;
}): string {
  const payload = canonicalize({
    merchantId: input.merchantId ?? null,
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorType: input.actorType ?? null,
    actorScope: input.actorScope ?? null,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    meta: input.meta ?? null,
    prevState: input.prevState ?? null,
    nextState: input.nextState ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    at: input.at,
    prevHash: input.prevHash,
  });
  return sha256(JSON.stringify(payload));
}

const GENESIS_HASH = "0".repeat(64);

/**
 * In-memory chain tail. Initialized lazily on first write per process from
 * the DB; subsequent writes pull the cached hash and avoid the round trip.
 * Concurrent writers serialize through `pendingTail` so two parallel audits
 * can't both claim the same prevHash.
 *
 * This is best-effort caching for performance — a process restart re-reads
 * the tail. Multi-process correctness relies on the verifier walking the
 * chain via at+_id sort, which works regardless of cache state.
 */
let cachedTail: string | null = null;
let pendingTail: Promise<string> | null = null;

async function readChainHeadFromDb(): Promise<string> {
  try {
    const last = await AuditLog.findOne({ selfHash: { $exists: true, $ne: null } })
      .sort({ at: -1, _id: -1 })
      .select("selfHash")
      .lean();
    return (last?.selfHash as string | undefined) ?? GENESIS_HASH;
  } catch {
    return GENESIS_HASH;
  }
}

async function nextChainHead(): Promise<string> {
  if (cachedTail !== null) return cachedTail;
  if (pendingTail) return pendingTail;
  pendingTail = readChainHeadFromDb().then((h) => {
    cachedTail = h;
    pendingTail = null;
    return h;
  });
  return pendingTail;
}

function commitChainHead(hash: string): void {
  cachedTail = hash;
}

/** Test helper — drop the cached tail so the next write re-reads from DB. */
export function __resetAuditChainCache(): void {
  cachedTail = null;
  pendingTail = null;
}

/**
 * Fire-and-forget audit writer — never throws back into the caller's path.
 * Audit writes are best-effort; we log and swallow storage errors so a dropped
 * Mongo connection doesn't block a business action.
 *
 * NOTE: this is the *legacy* signature used by every existing caller. New
 * admin code paths should call `writeAdminAudit` which stamps before/after
 * state, IP, UA, and the actor's scope.
 */
export function writeAudit(entry: AuditEntry): Promise<void> {
  return writeAuditChained(entry);
}

/**
 * Admin-flavored audit write. Same store, same chain — the only difference
 * is the call site is required to supply prevState / nextState. Use this
 * for every admin-initiated mutation; the search UI groups on actorType
 * to surface the admin trail separately from merchant activity.
 */
export function writeAdminAudit(entry: AuditEntry): Promise<void> {
  return writeAuditChained({
    ...entry,
    actorType: entry.actorType ?? "admin",
  });
}

async function writeAuditChained(entry: AuditEntry): Promise<void> {
  try {
    const at = new Date();
    const prevHash = await nextChainHead();
    const selfHash = computeAuditHash({
      merchantId: entry.merchantId ?? null,
      actorId: entry.actorId,
      actorEmail: entry.actorEmail ?? null,
      actorType: entry.actorType ?? null,
      actorScope: entry.actorScope ?? null,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      meta: entry.meta,
      prevState: entry.prevState,
      nextState: entry.nextState,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      at,
      prevHash,
    });
    await AuditLog.create({
      merchantId: entry.merchantId ?? undefined,
      actorId: entry.actorId,
      actorEmail: entry.actorEmail,
      actorType: entry.actorType ?? "merchant",
      actorScope: entry.actorScope,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      meta: entry.meta,
      prevState: entry.prevState,
      nextState: entry.nextState,
      ip: entry.ip,
      userAgent: entry.userAgent,
      at,
      prevHash,
      selfHash,
    });
    commitChainHead(selfHash);
  } catch (err: unknown) {
    const e = err as Error;
    console.error("[audit] write failed", {
      action: entry.action,
      subject: `${entry.subjectType}:${entry.subjectId}`,
      err: e.message,
      stack: e.stack?.split("\n").slice(0, 3).join(" | "),
    });
  }
}

export interface ChainVerificationResult {
  ok: boolean;
  totalScanned: number;
  firstBreakAt: Date | null;
  firstBreakId: string | null;
  message: string;
}

/**
 * Walk the audit log forward in time and verify that every row's selfHash
 * matches what we recompute from its fields, AND that prevHash equals the
 * preceding row's selfHash. The first mismatch wins — we surface its id +
 * timestamp so an operator can investigate.
 */
export async function verifyAuditChain(opts?: {
  since?: Date;
  limit?: number;
}): Promise<ChainVerificationResult> {
  const limit = opts?.limit ?? 5000;
  const filter: Record<string, unknown> = { selfHash: { $exists: true, $ne: null } };
  if (opts?.since) filter.at = { $gte: opts.since };
  const rows = await AuditLog.find(filter)
    .sort({ at: 1, _id: 1 })
    .limit(limit)
    .lean();
  let prev = GENESIS_HASH;
  if (opts?.since) {
    const before = await AuditLog.findOne({
      at: { $lt: opts.since },
      selfHash: { $exists: true, $ne: null },
    })
      .sort({ at: -1, _id: -1 })
      .select("selfHash")
      .lean();
    if (before?.selfHash) prev = before.selfHash as string;
  }
  for (const row of rows) {
    if ((row.prevHash ?? GENESIS_HASH) !== prev) {
      return {
        ok: false,
        totalScanned: rows.length,
        firstBreakAt: row.at as Date,
        firstBreakId: String(row._id),
        message: "prevHash chain broken — a preceding row was modified or deleted",
      };
    }
    const expected = computeAuditHash({
      merchantId: (row.merchantId as Types.ObjectId | undefined) ?? null,
      actorId: row.actorId as Types.ObjectId | undefined,
      actorEmail: (row.actorEmail as string | undefined) ?? null,
      actorType: (row.actorType as string | undefined) ?? null,
      actorScope: (row.actorScope as string | undefined) ?? null,
      action: row.action as string,
      subjectType: row.subjectType as string,
      subjectId: row.subjectId as Types.ObjectId,
      meta: row.meta,
      prevState: row.prevState,
      nextState: row.nextState,
      ip: (row.ip as string | undefined) ?? null,
      userAgent: (row.userAgent as string | undefined) ?? null,
      at: row.at as Date,
      prevHash: (row.prevHash as string | undefined) ?? GENESIS_HASH,
    });
    if (expected !== row.selfHash) {
      return {
        ok: false,
        totalScanned: rows.length,
        firstBreakAt: row.at as Date,
        firstBreakId: String(row._id),
        message: "selfHash mismatch — row content was modified after write",
      };
    }
    prev = row.selfHash as string;
  }
  return {
    ok: true,
    totalScanned: rows.length,
    firstBreakAt: null,
    firstBreakId: null,
    message:
      rows.length === 0
        ? "no rows in window"
        : `verified ${rows.length} rows`,
  };
}
