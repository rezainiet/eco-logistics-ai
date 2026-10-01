import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { LRUCache } from "lru-cache";
import {
  Merchant,
  TrackingEvent,
  TrackingSession,
  type TrackingEventType,
} from "@ecom/db";
import { resolveIdentityForOrder } from "../ingest.js";
import { Order } from "@ecom/db";
import { normalizePhoneOrRaw, phoneLookupVariants } from "../../lib/phone.js";
import {
  checkIdenticalPayloads,
  checkRateLimits,
  checkSpike,
  claimSessionOwnership,
  collectorInflight,
  recordAccepted,
  recordFlag,
  recordRejected,
  releaseCollectorSlot,
  signPayload,
  snapshotMetrics,
  tryAcquireCollectorSlot,
  validateBatch,
  verifyHmac,
  type FlagReason,
  type RejectReason,
  type ValidatedEvent,
} from "../../lib/tracking-guard.js";

/**
 * Behavior collector — public endpoint hit by the storefront SDK.
 *
 * Hardening pass adds: multi-tier rate limit (IP / key / merchant / session),
 * strict event validation, optional HMAC signing, identical-payload spam
 * dedupe, cross-merchant session ownership, spike flagging, concurrency
 * cap to isolate the collector from the order/trpc path.
 *
 * Trust boundary: never trusts client-supplied IP/UA — we read them from the
 * request. PII (phone/email) is accepted only on identify/checkout_submit
 * events, lower-cased + size-capped.
 */
export const trackingRouter = express.Router();

const MAX_BATCH = 50;
const MAX_PROPERTY_BYTES = 8 * 1024;
const MAX_SESSION_EVENT_COUNT = 5000;
/** Documented definition: a session with ≥2 add_to_cart events and no checkout. */
export const ABANDONED_CART_MIN_ADDS = 2;

const keyCache = new LRUCache<
  string,
  { merchantId: string; secret: string | null; strict: boolean }
>({ max: 5_000, ttl: 5 * 60_000 });

async function resolveMerchantFromKey(key: string): Promise<{
  merchantId: string;
  secret: string | null;
  strict: boolean;
} | null> {
  if (!key || key.length < 8 || key.length > 80) return null;
  const cached = keyCache.get(key);
  if (cached) return cached;
  const m = await Merchant.findOne({ trackingKey: key })
    .select("_id trackingSecret trackingStrictHmac")
    .lean();
  if (!m) return null;
  const profile = {
    merchantId: String(m._id),
    secret:
      ((m as { trackingSecret?: string | null }).trackingSecret ?? null) || null,
    strict: !!(m as { trackingStrictHmac?: boolean }).trackingStrictHmac,
  };
  keyCache.set(key, profile);
  return profile;
}

/**
 * Cache the per-(merchantId, sessionId) event count so the per-session
 * cap doesn't require a DB count on every batch. The count drifts over
 * the LRU TTL — that's fine, the DB-side check below is authoritative
 * and only runs when the cache says we're getting close to the cap.
 */
const sessionCountCache = new LRUCache<string, number>({
  max: 100_000,
  ttl: 60 * 60_000,
});

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, max);
}

function safeProps(props: unknown): Record<string, unknown> {
  if (!props || typeof props !== "object") return {};
  try {
    const json = JSON.stringify(props);
    if (json.length > MAX_PROPERTY_BYTES) return {};
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function emailHash(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32);
}

interface IncomingEvent {
  type: TrackingEventType;
  clientEventId?: string;
  sessionId: string;
  anonId?: string;
  url?: string;
  path?: string;
  referrer?: string;
  campaign?: { source?: string; medium?: string; name?: string; term?: string; content?: string };
  device?: { type?: string; os?: string; browser?: string; viewport?: string; language?: string };
  properties?: Record<string, unknown>;
  phone?: string;
  email?: string;
  occurredAt?: string;
  repeatVisitor?: boolean;
}

/**
 * Structured drop logger — sampled to 1-in-N at high traffic so we don't
 * fill the log shipper. Uses console.warn so existing telemetry pipelines
 * pick it up without a code change.
 */
let dropLogCounter = 0;
function logDrop(
  reason: RejectReason,
  ctx: { ip: string; merchantId?: string | null; trackingKey?: string },
): void {
  dropLogCounter++;
  if (dropLogCounter % 50 !== 1 && reason.startsWith("rate_limited")) return;
  console.warn(
    JSON.stringify({
      msg: "tracker_drop",
      reason,
      ip: ctx.ip,
      merchantId: ctx.merchantId ?? null,
      trackingKey: ctx.trackingKey ? `${ctx.trackingKey.slice(0, 8)}…` : null,
    }),
  );
}

function logFlag(
  reason: FlagReason,
  ctx: { merchantId: string; sessionId?: string },
): void {
  console.warn(
    JSON.stringify({
      msg: "tracker_flag",
      reason,
      merchantId: ctx.merchantId,
      sessionId: ctx.sessionId ?? null,
    }),
  );
}

/**
 * We need the raw body for HMAC verification. `express.json` consumes the
 * stream — switch to a verify-callback that captures rawBody on the
 * request, then run JSON.parse manually.
 */
const collectorJson = express.raw({
  type: ["application/json", "text/plain"],
  limit: "256kb",
});

trackingRouter.post(
  "/collect",
  collectorJson,
  async (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";

    // Layer F — concurrency cap. Returns 503 immediately when the collector
    // is saturated so we never starve the order/trpc HTTP pool. The SDK
    // should treat 503 as "back off + retry with jitter".
    if (!tryAcquireCollectorSlot()) {
      recordRejected("overload_concurrency", null);
      logDrop("overload_concurrency", { ip });
      return res.status(503).json({ ok: false, error: "collector_overloaded" });
    }

    try {
      const rawBody = Buffer.isBuffer(req.body)
        ? (req.body as Buffer).toString("utf8")
        : "";
      let body: { trackingKey?: string; events?: unknown[] };
      try {
        body = JSON.parse(rawBody) as typeof body;
      } catch {
        recordRejected("validation_shape", null);
        return res.status(400).json({ ok: false, error: "invalid_json" });
      }
      if (!body || typeof body !== "object" || typeof body.trackingKey !== "string") {
        recordRejected("validation_shape", null);
        return res.status(400).json({ ok: false, error: "missing_trackingKey" });
      }
      const events = Array.isArray(body.events) ? body.events : [];
      if (events.length === 0) {
        return res.json({ ok: true, accepted: 0 });
      }
      if (events.length > MAX_BATCH) {
        recordRejected("validation_shape", null);
        return res.status(413).json({ ok: false, error: "batch_too_large" });
      }

      // Resolve merchant + secret in one cached lookup. We need the secret
      // before HMAC verification, which has to run before any DB I/O.
      const profile = await resolveMerchantFromKey(body.trackingKey);
      if (!profile) {
        recordRejected("validation_shape", null);
        return res.status(401).json({ ok: false, error: "unknown_tracking_key" });
      }
      const { merchantId, secret, strict } = profile;
      const merchantOid = new Types.ObjectId(merchantId);

      // Layer C — HMAC verification (optional unless strict). Stale-timestamp
      // and signature failures are hard 401s — there is no legitimate cause
      // for a signed batch to fail.
      const sigHeader = (req.headers["x-track-signature"] as string | undefined) ?? null;
      const hmac = verifyHmac({
        rawBody,
        signatureHeader: sigHeader,
        secret,
        strict,
      });
      if (!hmac.ok) {
        recordRejected(hmac.reason, merchantId);
        logDrop(hmac.reason, { ip, merchantId, trackingKey: body.trackingKey });
        return res.status(401).json({ ok: false, error: hmac.reason });
      }
      if (!hmac.signed && (secret || strict)) {
        // Merchant has a secret configured but this batch wasn't signed —
        // flag for observability; in strict mode we'd already have returned.
        recordFlag("unsigned_batch", merchantId);
        logFlag("unsigned_batch", { merchantId });
      }

      // Layer B — strict per-event validation BEFORE consuming rate-limit
      // tokens. Quick-fail on shape errors so a flood of malformed events
      // can't burn the rate-limit budget.
      const validation = validateBatch(events, Date.now());
      if (!validation.ok) {
        recordRejected(validation.reason, merchantId);
        logDrop(validation.reason, { ip, merchantId });
        return res
          .status(400)
          .json({ ok: false, error: validation.reason, detail: validation.detail });
      }
      const validated = validation.events;
      const sessionIds = [...new Set(validated.map((e) => e.sessionId))];

      // Layer E — cross-merchant session ownership. First merchant to claim
      // a sessionId owns it for 24h; reject if any sessionId in this batch
      // is already pinned to a different merchant.
      for (const sid of sessionIds) {
        if (claimSessionOwnership(sid, merchantId) === "cross_merchant") {
          recordRejected("session_cross_merchant", merchantId);
          logDrop("session_cross_merchant", { ip, merchantId });
          return res
            .status(409)
            .json({ ok: false, error: "session_cross_merchant" });
        }
      }

      // Per-session inflation cap — count events already stored for the
      // (merchantId, sessionId) pair, refuse new batches that would push
      // past the cap. The cache is approximate; a DB check enforces the
      // ceiling once the cached count gets close. This kills "fake session"
      // attacks where one bot sends millions of events under one sessionId.
      for (const sid of sessionIds) {
        const k = `${merchantId}:${sid}`;
        const cached = sessionCountCache.get(k) ?? 0;
        const incoming = validated.filter((e) => e.sessionId === sid).length;
        if (cached + incoming >= MAX_SESSION_EVENT_COUNT) {
          // Cache is approximate — confirm against the DB before refusing.
          const actual = await TrackingEvent.countDocuments({
            merchantId: merchantOid,
            sessionId: sid,
          });
          sessionCountCache.set(k, actual);
          if (actual + incoming > MAX_SESSION_EVENT_COUNT) {
            recordRejected("validation_session_cap", merchantId);
            logDrop("validation_session_cap", { ip, merchantId });
            return res
              .status(409)
              .json({ ok: false, error: "session_event_cap" });
          }
        }
      }

      // Layer A — multi-tier rate limit. IP / key / merchant / per-session.
      const rl = checkRateLimits({
        ip,
        trackingKey: body.trackingKey,
        merchantId,
        sessionIds,
        eventCount: validated.length,
      });
      if (!rl.ok) {
        recordRejected(rl.reason, merchantId);
        logDrop(rl.reason, { ip, merchantId, trackingKey: body.trackingKey });
        return res.status(429).json({ ok: false, error: rl.reason });
      }

      // Layer D — anti-spam: identical-payload dedupe + spike flag.
      // Identical payloads dropped silently (the SDK shouldn't be sending
      // them); spike merchants accepted but flagged for review.
      const dedupe = checkIdenticalPayloads({
        merchantId,
        events: validated,
      });
      if (dedupe.duplicates > 0) {
        recordRejected("spam_identical_payload", merchantId, dedupe.duplicates);
        logDrop("spam_identical_payload", { ip, merchantId });
      }
      if (dedupe.uniques.length === 0) {
        return res.json({ ok: true, accepted: 0, dropped: dedupe.duplicates });
      }
      const eventsToWrite = dedupe.uniques;

      if (checkSpike(merchantId, eventsToWrite.length)) {
        recordFlag("spike_merchant", merchantId);
        logFlag("spike_merchant", { merchantId });
      }
      // Rapid-fire flag — separate from spike, and per-session: any session
      // that contributed > 30 events to this single batch is flagged.
      const perSession = new Map<string, number>();
      for (const ev of eventsToWrite) {
        perSession.set(ev.sessionId, (perSession.get(ev.sessionId) ?? 0) + 1);
      }
      for (const [sid, count] of perSession) {
        if (count > 30) {
          recordFlag("rapid_fire_session", merchantId);
          logFlag("rapid_fire_session", { merchantId, sessionId: sid });
        }
      }

      // ---- Persistence ----------------------------------------------------
      // Every event gets its own _id up front so we can tell, exactly, which
      // of THIS request's events were newly stored (vs. duplicate retries of
      // an earlier request, vs. genuine failures). Session counters are then
      // built ONLY from newly stored events, grouped by their own session —
      // a retried batch never inflates counters, and session B's events are
      // never credited to session A.
      const ua = clamp(req.headers["user-agent"], 500);
      const prepared: PreparedEvent[] = eventsToWrite.map((ev) => {
        const raw = ev.raw as IncomingEvent;
        const rawPhone = clamp(raw.phone, 32);
        const phone = rawPhone ? normalizePhoneOrRaw(rawPhone) ?? rawPhone : undefined;
        const email = clamp(raw.email, 200)?.toLowerCase();
        const sessionId = ev.sessionId.slice(0, 64);
        return {
          sessionId,
          occurredAt: ev.occurredAt,
          raw,
          phone,
          email,
          doc: {
            _id: new Types.ObjectId(),
            merchantId: merchantOid,
            sessionId,
            anonId: clamp(raw.anonId, 64),
            type: ev.type,
            clientEventId: ev.clientEventId,
            url: clamp(raw.url, 1000),
            path: clamp(raw.path, 500),
            referrer: clamp(raw.referrer, 1000),
            campaign: raw.campaign
              ? {
                  source: clamp(raw.campaign.source, 80),
                  medium: clamp(raw.campaign.medium, 80),
                  name: clamp(raw.campaign.name, 200),
                  term: clamp(raw.campaign.term, 120),
                  content: clamp(raw.campaign.content, 200),
                }
              : undefined,
            device: raw.device
              ? {
                  type: clamp(raw.device.type, 30),
                  os: clamp(raw.device.os, 60),
                  browser: clamp(raw.device.browser, 60),
                  viewport: clamp(raw.device.viewport, 40),
                  language: clamp(raw.device.language, 20),
                }
              : undefined,
            properties: safeProps(raw.properties),
            phone,
            email,
            ip,
            userAgent: ua,
            occurredAt: ev.occurredAt,
            receivedAt: new Date(),
          },
        };
      });

      let outcome: PersistOutcome;
      try {
        outcome = await persistTrackingEvents(prepared.map((p) => p.doc));
      } catch (err) {
        // Could not even determine what was stored (e.g. DB unreachable).
        // Nothing is counted; the SDK retries and idempotency absorbs it.
        console.error("[tracker] insert failed", (err as Error).message);
        return res.status(500).json({ ok: false, error: "persist_failed" });
      }

      // Group the newly stored events by THEIR session, in request order.
      const stored = new Map<string, PreparedEvent[]>();
      for (const p of prepared) {
        if (!outcome.inserted.has(String(p.doc._id))) continue;
        const list = stored.get(p.sessionId);
        if (list) list.push(p);
        else stored.set(p.sessionId, [p]);
      }

      for (const [sessionId, list] of stored) {
        const cacheKey = `${merchantId}:${sessionId}`;
        sessionCountCache.set(cacheKey, (sessionCountCache.get(cacheKey) ?? 0) + list.length);
        const identity = await updateSessionAggregate(merchantOid, sessionId, list);
        if (identity.phone || identity.email) {
          stitchExistingOrder({
            merchantId: merchantOid,
            sessionId,
            phone: identity.phone,
            email: identity.email,
          }).catch((err) => console.error("[tracker] back-stitch failed", err));
        }
      }

      recordAccepted(merchantId, outcome.inserted.size);
      const accepted = outcome.inserted.size + outcome.duplicates;
      if (outcome.failed > 0) {
        // Partial (or total) storage failure. Whatever WAS stored is counted
        // above; the failed events are not. Answer non-2xx so the SDK retries
        // the batch — the stored events then come back as duplicates and are
        // not counted twice.
        console.error(
          `[tracker] insert failed merchant=${merchantId} failed=${outcome.failed} stored=${outcome.inserted.size}`,
        );
        return res.status(500).json({
          ok: false,
          error: "persist_failed",
          accepted,
          failed: outcome.failed,
        });
      }
      return res.json({
        ok: true,
        accepted,
        duplicates: outcome.duplicates,
        dropped: dedupe.duplicates,
      });
    } finally {
      releaseCollectorSlot();
    }
  },
);

/**
 * Health snapshot for the collector — admin-only stats. Surface counters,
 * top merchants by traffic, current concurrency. Mounted under the
 * collector router so it shares the same isolation lane.
 */
trackingRouter.get("/_metrics", (_req, res) => {
  res.json({ ...snapshotMetrics(25), inflight: collectorInflight() });
});

interface EventCounts {
  page_view: number;
  product_view: number;
  add_to_cart: number;
  checkout_start: number;
  checkout_submit: number;
  click: number;
  maxScroll: number;
}

interface PreparedEvent {
  sessionId: string;
  occurredAt: Date;
  raw: IncomingEvent;
  phone?: string;
  email?: string;
  doc: Record<string, unknown> & { _id: Types.ObjectId };
}

export interface PersistOutcome {
  /** _ids (as strings) of this request's events that were newly stored. */
  inserted: Set<string>;
  /** Events rejected as already stored (same merchant + session + clientEventId). */
  duplicates: number;
  /** Events neither stored nor duplicates — a genuine failure. */
  failed: number;
}

const isDuplicateKey = (e: { code?: number; err?: { code?: number } } | undefined) =>
  (e?.code ?? e?.err?.code) === 11000;

/**
 * Insert a batch of tracking events (unordered) and report exactly which of
 * them were newly stored. The unique (merchantId, sessionId, clientEventId)
 * index turns retries into duplicate-key errors; anything else is a failure.
 * On error we read back our own pre-assigned _ids rather than trusting the
 * shape of the bulk-write error. Throws only when the outcome can't be
 * determined at all.
 */
export async function persistTrackingEvents(
  docs: Array<Record<string, unknown> & { _id: Types.ObjectId }>,
): Promise<PersistOutcome> {
  if (docs.length === 0) return { inserted: new Set(), duplicates: 0, failed: 0 };
  try {
    const res = await TrackingEvent.insertMany(docs, { ordered: false });
    // Unordered insertMany resolves with the docs that passed validation and
    // were written; any doc missing here failed validation.
    const inserted = new Set(res.map((d) => String(d._id)));
    return { inserted, duplicates: 0, failed: docs.length - inserted.size };
  } catch (err) {
    const e = err as { code?: number; writeErrors?: Array<{ code?: number; err?: { code?: number } }> };
    const landed = await TrackingEvent.find({ _id: { $in: docs.map((d) => d._id) } })
      .select("_id")
      .lean();
    const inserted = new Set(landed.map((d) => String(d._id)));
    const notStored = docs.length - inserted.size;
    const writeErrors = e.writeErrors ?? [];
    const duplicates = Math.min(
      notStored,
      writeErrors.length > 0
        ? writeErrors.filter(isDuplicateKey).length
        : isDuplicateKey(e)
          ? notStored
          : 0,
    );
    return { inserted, duplicates, failed: notStored - duplicates };
  }
}

/**
 * Fold one session's NEWLY stored events into its TrackingSession row.
 * Counters only ever move by events that were actually inserted; the
 * abandoned-cart flag is then derived from the session's cumulative
 * counters ("≥2 add_to_cart without a checkout"), not from one request.
 */
async function updateSessionAggregate(
  merchantOid: Types.ObjectId,
  sessionId: string,
  events: PreparedEvent[],
): Promise<{ phone?: string; email?: string }> {
  const first = events[0]!.raw;
  let firstAt = events[0]!.occurredAt;
  let lastAt = events[0]!.occurredAt;
  let phone: string | undefined;
  let email: string | undefined;
  for (const e of events) {
    if (e.occurredAt < firstAt) firstAt = e.occurredAt;
    if (e.occurredAt > lastAt) lastAt = e.occurredAt;
    if (e.phone) phone = e.phone;
    if (e.email) email = e.email;
  }
  const counts = countEvents(events.map((e) => e.raw));
  const repeatVisitor = events.some((e) => e.raw?.repeatVisitor) || false;
  await TrackingSession.updateOne(
    { merchantId: merchantOid, sessionId },
    {
      $setOnInsert: {
        merchantId: merchantOid,
        sessionId,
        firstSeenAt: firstAt,
        landingPath: clamp(first.path, 500),
        referrer: clamp(first.referrer, 1000),
        campaign: first.campaign
          ? {
              source: clamp(first.campaign.source, 80),
              medium: clamp(first.campaign.medium, 80),
              name: clamp(first.campaign.name, 200),
            }
          : undefined,
        device: first.device
          ? {
              type: clamp(first.device.type, 30),
              os: clamp(first.device.os, 60),
              browser: clamp(first.device.browser, 60),
            }
          : undefined,
        anonId: clamp(first.anonId, 64),
      },
      $inc: {
        pageViews: counts.page_view,
        productViews: counts.product_view,
        addToCartCount: counts.add_to_cart,
        checkoutStartCount: counts.checkout_start,
        checkoutSubmitCount: counts.checkout_submit,
        clickCount: counts.click,
      },
      $max: { lastSeenAt: lastAt, maxScrollDepth: counts.maxScroll },
      $set: {
        repeatVisitor,
        ...(phone ? { phone } : {}),
        ...(email ? { email, customerHash: emailHash(email) } : {}),
        ...(counts.checkout_submit > 0 ? { converted: true } : {}),
      },
    },
    { upsert: true },
  );
  // Derived fields, computed from the CUMULATIVE row (after this request's
  // increments and any concurrent ones that landed before it).
  await TrackingSession.updateOne({ merchantId: merchantOid, sessionId }, [
    {
      $set: {
        durationMs: { $max: [0, { $subtract: ["$lastSeenAt", "$firstSeenAt"] }] },
        abandonedCart: {
          $and: [
            { $gte: [{ $ifNull: ["$addToCartCount", 0] }, ABANDONED_CART_MIN_ADDS] },
            { $eq: [{ $ifNull: ["$checkoutSubmitCount", 0] }, 0] },
          ],
        },
      },
    },
  ]);
  return { phone, email };
}

function countEvents(events: IncomingEvent[]): EventCounts {
  const counts: EventCounts = {
    page_view: 0,
    product_view: 0,
    add_to_cart: 0,
    checkout_start: 0,
    checkout_submit: 0,
    click: 0,
    maxScroll: 0,
  };
  for (const ev of events) {
    if (!ev?.type) continue;
    switch (ev.type) {
      case "page_view":
        counts.page_view += 1;
        break;
      case "product_view":
        counts.product_view += 1;
        break;
      case "add_to_cart":
        counts.add_to_cart += 1;
        break;
      case "checkout_start":
        counts.checkout_start += 1;
        break;
      case "checkout_submit":
        counts.checkout_submit += 1;
        break;
      case "click":
        counts.click += 1;
        break;
      case "scroll": {
        const depth = Number((ev.properties as { depth?: number } | undefined)?.depth ?? 0);
        if (depth > counts.maxScroll) counts.maxScroll = Math.min(100, depth);
        break;
      }
    }
  }
  return counts;
}

async function stitchExistingOrder(args: {
  merchantId: Types.ObjectId;
  sessionId: string;
  phone?: string;
  email?: string;
}): Promise<void> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filter: Record<string, unknown> = {
    merchantId: args.merchantId,
    createdAt: { $gte: since },
  };
  if (args.phone) {
    const variants = phoneLookupVariants(args.phone);
    filter["customer.phone"] =
      variants.length > 1 ? { $in: variants } : args.phone;
  } else if (args.email) {
    filter["source.customerEmail"] = args.email;
  } else {
    return;
  }
  const order = await Order.findOne(filter)
    .sort({ createdAt: -1 })
    .select("_id customer.phone source.customerEmail")
    .lean();
  if (!order) return;
  await resolveIdentityForOrder({
    merchantId: args.merchantId,
    orderId: order._id,
    phone: args.phone,
    email: args.email,
  });
}

/**
 * Generate-on-read tracking key for the merchant. Idempotent.
 */
export async function ensureTrackingKey(merchantId: Types.ObjectId): Promise<string> {
  const existing = await Merchant.findById(merchantId).select("trackingKey").lean();
  if (existing?.trackingKey) return existing.trackingKey;
  const key = `pub_${randomBytes(20).toString("base64url")}`;
  await Merchant.updateOne(
    { _id: merchantId, trackingKey: { $exists: false } },
    { $set: { trackingKey: key } },
  );
  const fresh = await Merchant.findById(merchantId).select("trackingKey").lean();
  return fresh?.trackingKey ?? key;
}

/**
 * Mint or rotate the merchant's HMAC tracking secret. Returned in plaintext
 * — the merchant pastes it into the SDK once. Rotating invalidates every
 * previously-issued signature.
 */
export async function rotateTrackingSecret(
  merchantId: Types.ObjectId,
): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  await Merchant.updateOne(
    { _id: merchantId },
    { $set: { trackingSecret: secret } },
  );
  // Invalidate the per-key cache so the next request picks up the new
  // secret immediately. LRUCache<v10>.entries() yields [key, value, ttl] —
  // we only need key/value.
  const targetId = String(merchantId);
  for (const [k, v] of keyCache.entries()) {
    if (v.merchantId === targetId) keyCache.delete(k);
  }
  return secret;
}

/** Helper exported for the SDK + tests — sign a payload with a secret. */
export const signTrackingPayload = signPayload;

/** Helper for tests — clear the per-key resolution cache. */
export function __resetCollectorCache(): void {
  keyCache.clear();
  sessionCountCache.clear();
}

// Re-export so tests can import without reaching into internals.
export type { ValidatedEvent };
