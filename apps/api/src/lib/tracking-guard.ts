import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";
import { TRACKING_EVENT_TYPES, type TrackingEventType } from "@ecom/db";

/**
 * Hardening for the public behavior collector.
 *
 * Threats we defend against here (in order of likelihood):
 *
 *   1. Bot fan-out from one storefront: a misbehaving SDK or a hostile script
 *      sends thousands of events per minute. Per-IP + per-tracking-key +
 *      per-merchant token buckets each catch a different angle of the attack.
 *
 *   2. Analytics poisoning: an attacker sends fabricated checkout_submit /
 *      add_to_cart events to inflate funnels or train fraud signals.
 *      Validation + identical-payload dedupe + HMAC catch most of these.
 *
 *   3. Cross-merchant session hijack: if sessionIds are guessable, an
 *      attacker on Merchant A's storefront can claim a sessionId that
 *      Merchant B already owns. Session-integrity checks pin the
 *      sessionId to its first owner.
 *
 *   4. Collector-induced API outage: a flood that holds every HTTP worker
 *      starves /trpc / order ingestion. The bounded in-flight semaphore
 *      degrades the collector first while keeping the order path warm.
 *
 * None of these layers throw — every failure is reported back as a `Reject`
 * outcome with a stable code so the metrics surface can count them.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RejectReason =
  | "rate_limited_ip"
  | "rate_limited_key"
  | "rate_limited_merchant"
  | "rate_limited_session"
  | "validation_event_type"
  | "validation_session_id"
  | "validation_session_cap"
  | "validation_payload_size"
  | "validation_timestamp"
  | "validation_shape"
  | "spam_identical_payload"
  | "session_cross_merchant"
  | "signature_missing"
  | "signature_invalid"
  | "signature_stale_timestamp"
  | "overload_concurrency";

export type FlagReason =
  | "rapid_fire_session"
  | "spike_merchant"
  | "unsigned_batch";

export interface AcceptResult {
  ok: true;
  flags: FlagReason[];
}

export interface RejectResult {
  ok: false;
  reason: RejectReason;
  detail?: string;
}

export type GuardResult = AcceptResult | RejectResult;

// ---------------------------------------------------------------------------
// Token-bucket rate limit (sliding 1m window)
//
// We keep three independent caches keyed on IP / trackingKey / merchantId.
// Each entry is a pair (count, resetAt). The cap-arity differs per layer —
// per-IP is the noisiest, per-merchant is the absolute ceiling.
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

function makeBucketCache(maxEntries: number): LRUCache<string, Bucket> {
  return new LRUCache<string, Bucket>({ max: maxEntries, ttl: 5 * 60_000 });
}

// Defaults are conservative for production — most legitimate storefronts
// emit < 10 events/min/visitor; per-merchant 6000/min covers a busy flash
// sale across many concurrent visitors. Tunable via the `withLimits`
// override in tests.
export interface RateLimitsConfig {
  perIpPerMinute: number;
  perKeyPerMinute: number;
  perMerchantPerMinute: number;
  perSessionPerMinute: number;
}

export const DEFAULT_LIMITS: RateLimitsConfig = {
  perIpPerMinute: 250,
  perKeyPerMinute: 600,
  perMerchantPerMinute: 6000,
  perSessionPerMinute: 120,
};

const ipBuckets = makeBucketCache(50_000);
const keyBuckets = makeBucketCache(10_000);
const merchantBuckets = makeBucketCache(10_000);
const sessionBuckets = makeBucketCache(50_000);

function consumeBucket(
  cache: LRUCache<string, Bucket>,
  bucketKey: string,
  cap: number,
  count: number,
  now: number,
): boolean {
  const existing = cache.get(bucketKey);
  if (!existing || existing.resetAt < now) {
    cache.set(bucketKey, { count, resetAt: now + 60_000 });
    return count <= cap;
  }
  existing.count += count;
  return existing.count <= cap;
}

export interface RateLimitInput {
  ip: string;
  trackingKey: string;
  merchantId: string;
  /** sessionIds present in the batch (deduped). */
  sessionIds: string[];
  /** Number of events in the batch. The IP/key/merchant buckets cost N tokens
   *  total; per-session buckets cost 1 token per event for that session. */
  eventCount: number;
  limits?: Partial<RateLimitsConfig>;
}

export function checkRateLimits(input: RateLimitInput): GuardResult {
  const cfg = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const now = Date.now();
  // The order matters — we want the cheapest, broadest layer first so a
  // distributed attack hits IP rate-limits before we burn cycles on
  // merchant-keyed work.
  if (!consumeBucket(ipBuckets, input.ip, cfg.perIpPerMinute, input.eventCount, now)) {
    return { ok: false, reason: "rate_limited_ip" };
  }
  if (
    !consumeBucket(
      keyBuckets,
      input.trackingKey,
      cfg.perKeyPerMinute,
      input.eventCount,
      now,
    )
  ) {
    return { ok: false, reason: "rate_limited_key" };
  }
  if (
    !consumeBucket(
      merchantBuckets,
      input.merchantId,
      cfg.perMerchantPerMinute,
      input.eventCount,
      now,
    )
  ) {
    return { ok: false, reason: "rate_limited_merchant" };
  }
  // Per-session: one bucket per (merchantId, sessionId). Costs eventsForSession
  // tokens. Catches a bot that owns a single session and sends thousands of
  // page_views.
  for (const sid of input.sessionIds) {
    const k = `${input.merchantId}:${sid}`;
    // We can't perfectly attribute the batch's events to each session without
    // a second pass; charge the full batch to every session that participated.
    // Slight over-count, but it makes the rapid-fire signal more sensitive.
    if (
      !consumeBucket(
        sessionBuckets,
        k,
        cfg.perSessionPerMinute,
        input.eventCount,
        now,
      )
    ) {
      return { ok: false, reason: "rate_limited_session" };
    }
  }
  return { ok: true, flags: [] };
}

// ---------------------------------------------------------------------------
// Event validation
//
// Rejects whole batches on shape errors; per-event drops happen in the
// caller's loop and feed back into the metrics. Validation is pure — no
// DB I/O — so it runs before rate limit consumption when we want quick-fail.
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const CLIENT_EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const MAX_EVENT_BYTES = 32 * 1024;
const MAX_PROPERTIES_DEPTH = 6;
const MAX_PROPERTIES_KEYS = 100;

const FUTURE_SKEW_MS = 10 * 60 * 1000; // 10 minutes
const PAST_SKEW_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ValidatedEvent {
  type: TrackingEventType;
  sessionId: string;
  clientEventId?: string;
  occurredAt: Date;
  raw: unknown;
  /** Hash of (sessionId, type, occurredAt, properties) — used for identical-
   *  payload spam dedupe. Computed once in validation so we don't re-stringify
   *  the properties object downstream. */
  fingerprint: string;
}

export interface ValidationOk {
  ok: true;
  events: ValidatedEvent[];
}
export type ValidationResult = ValidationOk | RejectResult;

function depthOf(value: unknown, current = 0): number {
  if (current > MAX_PROPERTIES_DEPTH) return current;
  if (!value || typeof value !== "object") return current;
  if (Array.isArray(value)) {
    let d = current;
    for (const v of value) {
      const di = depthOf(v, current + 1);
      if (di > d) d = di;
      if (d > MAX_PROPERTIES_DEPTH) return d;
    }
    return d;
  }
  let d = current;
  let count = 0;
  for (const key of Object.keys(value as object)) {
    if (++count > MAX_PROPERTIES_KEYS) return MAX_PROPERTIES_DEPTH + 1;
    const di = depthOf((value as Record<string, unknown>)[key], current + 1);
    if (di > d) d = di;
    if (d > MAX_PROPERTIES_DEPTH) return d;
  }
  return d;
}

export function fingerprintEvent(input: {
  sessionId: string;
  type: string;
  occurredAt: Date;
  properties?: unknown;
}): string {
  const propsJson = (() => {
    try {
      return JSON.stringify(input.properties ?? null);
    } catch {
      return "null";
    }
  })();
  return createHash("sha256")
    .update(`${input.sessionId}|${input.type}|${input.occurredAt.getTime()}|${propsJson}`)
    .digest("hex")
    .slice(0, 32);
}

export function validateEvent(ev: unknown, now = Date.now()): ValidationResult {
  if (!ev || typeof ev !== "object") {
    return { ok: false, reason: "validation_shape", detail: "non-object event" };
  }
  const e = ev as Record<string, unknown>;

  // Per-event size cap: defends against multi-megabyte property bombs that
  // each fit inside the 256kb batch limit. Cheap — JSON.stringify the event
  // and bail if it's > 32kb.
  let serialized: string;
  try {
    serialized = JSON.stringify(e);
  } catch {
    return { ok: false, reason: "validation_shape", detail: "non-serializable" };
  }
  if (serialized.length > MAX_EVENT_BYTES) {
    return { ok: false, reason: "validation_payload_size" };
  }

  if (!TRACKING_EVENT_TYPES.includes(e.type as TrackingEventType)) {
    return { ok: false, reason: "validation_event_type" };
  }
  if (typeof e.sessionId !== "string" || !SESSION_ID_RE.test(e.sessionId)) {
    return { ok: false, reason: "validation_session_id" };
  }
  if (
    e.clientEventId !== undefined &&
    e.clientEventId !== null &&
    (typeof e.clientEventId !== "string" || !CLIENT_EVENT_ID_RE.test(e.clientEventId))
  ) {
    return { ok: false, reason: "validation_shape", detail: "clientEventId" };
  }

  const occurredRaw = e.occurredAt;
  const occurredAt = occurredRaw ? new Date(occurredRaw as string) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false, reason: "validation_timestamp" };
  }
  const skew = occurredAt.getTime() - now;
  if (skew > FUTURE_SKEW_MS || skew < -PAST_SKEW_MS) {
    return { ok: false, reason: "validation_timestamp" };
  }

  // Properties depth + key-count cap. Tightens the existing 8KB JSON cap
  // by also rejecting deeply-nested or wide objects designed to slow down
  // downstream consumers.
  if (e.properties !== undefined && depthOf(e.properties) > MAX_PROPERTIES_DEPTH) {
    return { ok: false, reason: "validation_shape", detail: "properties depth" };
  }

  return {
    ok: true,
    events: [
      {
        type: e.type as TrackingEventType,
        sessionId: e.sessionId,
        clientEventId: typeof e.clientEventId === "string" ? e.clientEventId : undefined,
        occurredAt,
        raw: e,
        fingerprint: fingerprintEvent({
          sessionId: e.sessionId,
          type: e.type as string,
          occurredAt,
          properties: e.properties,
        }),
      },
    ],
  };
}

export function validateBatch(
  events: unknown[],
  now = Date.now(),
): ValidationResult {
  const out: ValidatedEvent[] = [];
  for (const ev of events) {
    const r = validateEvent(ev, now);
    if (!r.ok) return r;
    out.push(...r.events);
  }
  return { ok: true, events: out };
}

// ---------------------------------------------------------------------------
// Identical-payload dedupe
//
// `clientEventId` already gives us a 1-of-1 retry guard at the DB layer.
// This is a complementary check for events that DON'T carry a client id —
// a misbehaving script firing the same payload at high rate. We hold the
// last 60s of fingerprints per (merchantId, fingerprint) and refuse repeats.
// ---------------------------------------------------------------------------

const fingerprintCache = new LRUCache<string, number>({
  max: 200_000,
  ttl: 60_000,
});

export interface IdenticalCheckInput {
  merchantId: string;
  events: ValidatedEvent[];
}

export function checkIdenticalPayloads(input: IdenticalCheckInput): {
  duplicates: number;
  uniques: ValidatedEvent[];
} {
  const uniques: ValidatedEvent[] = [];
  let duplicates = 0;
  for (const ev of input.events) {
    const key = `${input.merchantId}:${ev.fingerprint}`;
    if (fingerprintCache.has(key)) {
      duplicates++;
      continue;
    }
    fingerprintCache.set(key, Date.now());
    uniques.push(ev);
  }
  return { duplicates, uniques };
}

// ---------------------------------------------------------------------------
// Spike detection
//
// Per-merchant rolling 1-minute count vs a 10-minute baseline. We don't
// drop on spike — that's the rate-limit's job — we FLAG so observability
// can surface the merchant for a human review. Spikes are sticky: once
// flagged we keep flagging for the next 60s so a single batch doesn't
// flip the flag on/off.
// ---------------------------------------------------------------------------

interface SpikeState {
  shortBucket: number;
  shortResetAt: number;
  longBucket: number;
  longResetAt: number;
  flaggedUntil: number;
}

const spikeCache = new LRUCache<string, SpikeState>({
  max: 10_000,
  ttl: 30 * 60_000,
});

export function checkSpike(merchantId: string, eventCount: number): boolean {
  const now = Date.now();
  let state = spikeCache.get(merchantId);
  if (!state) {
    state = {
      shortBucket: 0,
      shortResetAt: now + 60_000,
      longBucket: 0,
      longResetAt: now + 600_000,
      flaggedUntil: 0,
    };
    spikeCache.set(merchantId, state);
  }
  if (state.shortResetAt < now) {
    state.shortBucket = 0;
    state.shortResetAt = now + 60_000;
  }
  if (state.longResetAt < now) {
    state.longBucket = 0;
    state.longResetAt = now + 600_000;
  }
  state.shortBucket += eventCount;
  state.longBucket += eventCount;

  // The baseline is the 10-minute count averaged across 10 buckets, so the
  // expected per-minute rate is longBucket / 10. A 1-minute spike that's
  // > 5× the baseline AND > 100 absolute events is anomalous.
  const baseline = state.longBucket / 10;
  if (
    state.shortBucket > 100 &&
    (baseline === 0 || state.shortBucket > baseline * 5)
  ) {
    state.flaggedUntil = now + 60_000;
  }
  return state.flaggedUntil > now;
}

// ---------------------------------------------------------------------------
// Cross-merchant session ownership
//
// First merchant that claims a sessionId owns it for 24h. Any other merchant
// trying to push events on the same sessionId is refused — defends against
// a malicious storefront seeding a competitor's session table.
// ---------------------------------------------------------------------------

interface OwnerEntry {
  merchantId: string;
  expiresAt: number;
}

const sessionOwnership = new LRUCache<string, OwnerEntry>({
  max: 200_000,
  ttl: 24 * 60 * 60 * 1000,
});

export type SessionOwnership = "ok" | "cross_merchant";

export function claimSessionOwnership(
  sessionId: string,
  merchantId: string,
): SessionOwnership {
  const now = Date.now();
  const existing = sessionOwnership.get(sessionId);
  if (!existing || existing.expiresAt < now) {
    sessionOwnership.set(sessionId, {
      merchantId,
      expiresAt: now + 24 * 60 * 60 * 1000,
    });
    return "ok";
  }
  if (existing.merchantId !== merchantId) return "cross_merchant";
  return "ok";
}

// ---------------------------------------------------------------------------
// HMAC verification
//
// Signature header format: `t=<unixMs>,s=<base64url-hmac>`. The signed input
// is `${t}.${rawBody}`, mirroring Stripe's pattern. Timestamp must be within
// ±5 minutes of server time to defend against captured-replay attacks.
// ---------------------------------------------------------------------------

const SIGNATURE_SKEW_MS = 5 * 60 * 1000;

export interface HmacInput {
  rawBody: string;
  signatureHeader: string | null;
  secret: string | null;
  strict: boolean;
  now?: number;
}

export type HmacVerification =
  | { ok: true; signed: boolean }
  | { ok: false; reason: "signature_missing" | "signature_invalid" | "signature_stale_timestamp" };

export function verifyHmac(input: HmacInput): HmacVerification {
  const now = input.now ?? Date.now();
  const header = input.signatureHeader?.trim();
  if (!header) {
    if (input.strict) return { ok: false, reason: "signature_missing" };
    return { ok: true, signed: false };
  }
  if (!input.secret) {
    // Caller sent a signature but we have no secret to verify against. In
    // strict mode that's a hard fail; in lax mode we accept-and-flag.
    if (input.strict) return { ok: false, reason: "signature_invalid" };
    return { ok: true, signed: false };
  }
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return ["", ""] as const;
      return [p.slice(0, eq).trim(), p.slice(eq + 1).trim()] as const;
    }),
  );
  const t = Number(parts.t);
  const s = parts.s;
  if (!Number.isFinite(t) || typeof s !== "string" || s.length < 16) {
    return { ok: false, reason: "signature_invalid" };
  }
  if (Math.abs(now - t) > SIGNATURE_SKEW_MS) {
    return { ok: false, reason: "signature_stale_timestamp" };
  }
  const macHex = computeHmacHex(input.secret, `${t}.${input.rawBody}`);
  if (!ctEqHex(macHex, s)) {
    return { ok: false, reason: "signature_invalid" };
  }
  return { ok: true, signed: true };
}

function computeHmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function ctEqHex(a: string, b: string): boolean {
  // Hex strings can vary in case — lower-case both before constant-time compare.
  const aa = Buffer.from(a.toLowerCase(), "hex");
  const bb = Buffer.from(b.toLowerCase(), "hex");
  if (aa.length === 0 || aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

/**
 * Helper for the SDK / tests — compute the signature header for a body.
 * Returned in the same `t=...,s=...` format the verifier consumes.
 */
export function signPayload(secret: string, body: string, now = Date.now()): string {
  return `t=${now},s=${computeHmacHex(secret, `${now}.${body}`)}`;
}

// ---------------------------------------------------------------------------
// Concurrency semaphore
//
// Caps the number of in-flight collector requests so a flood can't hold
// every HTTP worker and starve the order/trpc pool. Exceeding the cap
// returns 503 immediately — the SDK should treat 503 as "back off and
// retry with jitter" so we don't get retry-stormed.
// ---------------------------------------------------------------------------

let inflight = 0;
let semaphoreCap = 200;

export function setCollectorConcurrencyCap(cap: number): void {
  semaphoreCap = cap;
}

export function tryAcquireCollectorSlot(): boolean {
  if (inflight >= semaphoreCap) return false;
  inflight++;
  return true;
}

export function releaseCollectorSlot(): void {
  if (inflight > 0) inflight--;
}

export function collectorInflight(): number {
  return inflight;
}

// ---------------------------------------------------------------------------
// Metrics
//
// In-process counters for accepted / rejected / flagged batches. Process
// memory only — for cross-instance aggregation hook into your existing
// telemetry export. We expose a `snapshot()` for the admin dashboard.
// ---------------------------------------------------------------------------

interface MetricsState {
  acceptedBatches: number;
  acceptedEvents: number;
  rejectedByReason: Map<RejectReason, number>;
  flaggedByReason: Map<FlagReason, number>;
  perMerchant: Map<string, { events: number; rejected: number; flagged: number }>;
  startedAt: number;
}

const metrics: MetricsState = {
  acceptedBatches: 0,
  acceptedEvents: 0,
  rejectedByReason: new Map(),
  flaggedByReason: new Map(),
  perMerchant: new Map(),
  startedAt: Date.now(),
};

export function recordAccepted(merchantId: string, events: number): void {
  metrics.acceptedBatches++;
  metrics.acceptedEvents += events;
  bumpMerchant(merchantId, "events", events);
}

export function recordRejected(
  reason: RejectReason,
  merchantId: string | null,
  count = 1,
): void {
  metrics.rejectedByReason.set(
    reason,
    (metrics.rejectedByReason.get(reason) ?? 0) + count,
  );
  if (merchantId) bumpMerchant(merchantId, "rejected", count);
}

export function recordFlag(
  reason: FlagReason,
  merchantId: string,
  count = 1,
): void {
  metrics.flaggedByReason.set(
    reason,
    (metrics.flaggedByReason.get(reason) ?? 0) + count,
  );
  bumpMerchant(merchantId, "flagged", count);
}

function bumpMerchant(
  merchantId: string,
  key: "events" | "rejected" | "flagged",
  by: number,
): void {
  let m = metrics.perMerchant.get(merchantId);
  if (!m) {
    m = { events: 0, rejected: 0, flagged: 0 };
    metrics.perMerchant.set(merchantId, m);
  }
  m[key] += by;
  // Cap the perMerchant table size by trimming the smallest entries when it
  // gets large. 5k merchants × small struct is a few MB max.
  if (metrics.perMerchant.size > 5_000) {
    const candidates = Array.from(metrics.perMerchant.entries());
    candidates.sort((a, b) => a[1].events - b[1].events);
    for (let i = 0; i < 1_000; i++) {
      const entry = candidates[i];
      if (entry) metrics.perMerchant.delete(entry[0]);
    }
  }
}

export interface MetricsSnapshot {
  uptimeMs: number;
  acceptedBatches: number;
  acceptedEvents: number;
  rejectedByReason: Record<string, number>;
  flaggedByReason: Record<string, number>;
  topMerchantsByEvents: Array<{ merchantId: string; events: number; rejected: number; flagged: number }>;
  inflight: number;
}

export function snapshotMetrics(topN = 25): MetricsSnapshot {
  const top = Array.from(metrics.perMerchant.entries())
    .map(([merchantId, s]) => ({ merchantId, ...s }))
    .sort((a, b) => b.events - a.events)
    .slice(0, topN);
  return {
    uptimeMs: Date.now() - metrics.startedAt,
    acceptedBatches: metrics.acceptedBatches,
    acceptedEvents: metrics.acceptedEvents,
    rejectedByReason: Object.fromEntries(metrics.rejectedByReason),
    flaggedByReason: Object.fromEntries(metrics.flaggedByReason),
    topMerchantsByEvents: top,
    inflight,
  };
}

/** Test helper — wipe every cache so each spec starts from a clean slate. */
export function __resetTrackingGuardForTests(): void {
  ipBuckets.clear();
  keyBuckets.clear();
  merchantBuckets.clear();
  sessionBuckets.clear();
  fingerprintCache.clear();
  spikeCache.clear();
  sessionOwnership.clear();
  metrics.acceptedBatches = 0;
  metrics.acceptedEvents = 0;
  metrics.rejectedByReason.clear();
  metrics.flaggedByReason.clear();
  metrics.perMerchant.clear();
  metrics.startedAt = Date.now();
  inflight = 0;
  semaphoreCap = 200;
}
