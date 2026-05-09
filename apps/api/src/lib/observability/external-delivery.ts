import { env } from "../../env.js";

/**
 * Phase 4A — observability for the external-delivery orchestrator.
 *
 * Sibling of `lib/observability/lane-intelligence.ts`. Closed event
 * enum, in-process counters, structured-log emit, snapshot helper.
 *
 * Hard rules (binding):
 *   - NEVER throws back to the caller.
 *   - NEVER reads or writes Mongo. NEVER hits Redis.
 *   - Bounded scalar metadata; no PII; truncate long strings to 200 chars.
 *   - Gracefully no-ops when DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED=0
 *     (reuses the existing observability flag — no new env knob).
 *
 * Per-merchant safety:
 *   - phoneHash is the buyer's hashed identifier; merchantId is a hex
 *     string. Both are safe to log; neither is PII.
 */

export type ExternalDeliveryObservabilityEvent =
  | "external_profile_fetch_started"
  | "external_profile_fetch_completed"
  | "external_profile_fetch_failed"
  | "external_provider_timeout"
  | "external_provider_partial_failure"
  | "external_profile_cache_hit"
  | "external_profile_cache_miss";

const COUNTER_KEYS: ReadonlyArray<ExternalDeliveryObservabilityEvent> = [
  "external_profile_fetch_started",
  "external_profile_fetch_completed",
  "external_profile_fetch_failed",
  "external_provider_timeout",
  "external_provider_partial_failure",
  "external_profile_cache_hit",
  "external_profile_cache_miss",
];

const counters: Record<ExternalDeliveryObservabilityEvent, number> = {
  external_profile_fetch_started: 0,
  external_profile_fetch_completed: 0,
  external_profile_fetch_failed: 0,
  external_provider_timeout: 0,
  external_provider_partial_failure: 0,
  external_profile_cache_hit: 0,
  external_profile_cache_miss: 0,
};

const ERROR_EVENTS: ReadonlySet<ExternalDeliveryObservabilityEvent> = new Set([
  "external_profile_fetch_failed",
  "external_provider_timeout",
  "external_provider_partial_failure",
]);

/* -------------------------------------------------------------------------- */
/* Per-provider latency aggregator                                            */
/* -------------------------------------------------------------------------- */

interface ProviderLatencyBucket {
  count: number;
  totalMs: number;
  maxMs: number;
  timeoutCount: number;
  failureCount: number;
}

const providerLatency = new Map<string, ProviderLatencyBucket>();

function ensureBucket(provider: string): ProviderLatencyBucket {
  let b = providerLatency.get(provider);
  if (!b) {
    b = { count: 0, totalMs: 0, maxMs: 0, timeoutCount: 0, failureCount: 0 };
    providerLatency.set(provider, b);
  }
  return b;
}

export function recordProviderLatency(args: {
  provider: string;
  durationMs: number;
  ok: boolean;
  timedOut: boolean;
}): void {
  if (typeof args.provider !== "string" || args.provider.length === 0) return;
  if (typeof args.durationMs !== "number" || !Number.isFinite(args.durationMs)) return;
  const b = ensureBucket(args.provider);
  b.count += 1;
  b.totalMs += Math.max(0, args.durationMs);
  if (args.durationMs > b.maxMs) b.maxMs = args.durationMs;
  if (args.timedOut) b.timeoutCount += 1;
  if (!args.ok && !args.timedOut) b.failureCount += 1;
}

/* -------------------------------------------------------------------------- */
/* Public emit + snapshot                                                     */
/* -------------------------------------------------------------------------- */

export interface RecordExternalDeliveryObservabilityInput {
  event: ExternalDeliveryObservabilityEvent;
  /** Merchant hex string. */
  merchantId?: string;
  /** SHA-256[:32] of the phone — never the raw phone. */
  phoneHash?: string;
  provider?: string;
  durationMs?: number;
  reason?: string;
  error?: string;
  meta?: Record<string, string | number | boolean | null | undefined>;
}

function safeMeta(
  meta: RecordExternalDeliveryObservabilityInput["meta"],
): RecordExternalDeliveryObservabilityInput["meta"] {
  if (!meta) return undefined;
  const out: NonNullable<RecordExternalDeliveryObservabilityInput["meta"]> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof k !== "string" || k.length === 0 || k.length > 60) continue;
    if (
      v === null ||
      v === undefined ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v ?? undefined;
      continue;
    }
    if (typeof v === "string") {
      out[k] = v.length > 200 ? v.slice(0, 200) : v;
    }
  }
  return out;
}

export function recordExternalDeliveryObservability(
  input: RecordExternalDeliveryObservabilityInput,
): void {
  if (!env.DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED) return;
  if (!input || typeof input !== "object") return;
  const { event } = input;
  if (typeof event !== "string" || !(event in counters)) return;
  try {
    counters[event] += 1;
    const line = {
      msg: "external_delivery",
      event,
      merchantId: input.merchantId,
      phoneHash: input.phoneHash,
      provider: input.provider,
      reason: input.reason,
      durationMs:
        typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
          ? Math.round(input.durationMs)
          : undefined,
      error: input.error ? String(input.error).slice(0, 200) : undefined,
      meta: safeMeta(input.meta),
    };
    if (ERROR_EVENTS.has(event)) {
      console.error(JSON.stringify(line));
    } else {
      console.log(JSON.stringify(line));
    }
  } catch (err) {
    try {
      console.error(
        `[external-delivery-observability] emit failed: ${(err as Error)?.message ?? err}`,
      );
    } catch {
      /* nothing */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

export interface ExternalDeliveryCountersSnapshot {
  fetchStarted: number;
  fetchCompleted: number;
  fetchFailed: number;
  providerTimeout: number;
  providerPartialFailure: number;
  cacheHit: number;
  cacheMiss: number;
  /** cacheHit / (cacheHit + cacheMiss). Null when no cache touch yet. */
  cacheHitRatio: number | null;
}

export interface ProviderLatencySnapshot {
  provider: string;
  count: number;
  meanMs: number;
  maxMs: number;
  timeoutCount: number;
  failureCount: number;
}

export function snapshotExternalDeliveryCounters(): ExternalDeliveryCountersSnapshot {
  const hit = counters.external_profile_cache_hit;
  const miss = counters.external_profile_cache_miss;
  const denom = hit + miss;
  const cacheHitRatio = denom > 0 ? hit / denom : null;
  return {
    fetchStarted: counters.external_profile_fetch_started,
    fetchCompleted: counters.external_profile_fetch_completed,
    fetchFailed: counters.external_profile_fetch_failed,
    providerTimeout: counters.external_provider_timeout,
    providerPartialFailure: counters.external_provider_partial_failure,
    cacheHit: hit,
    cacheMiss: miss,
    cacheHitRatio,
  };
}

export function snapshotProviderLatency(): ProviderLatencySnapshot[] {
  const out: ProviderLatencySnapshot[] = [];
  for (const [provider, b] of providerLatency) {
    out.push({
      provider,
      count: b.count,
      meanMs: b.count > 0 ? b.totalMs / b.count : 0,
      maxMs: b.maxMs,
      timeoutCount: b.timeoutCount,
      failureCount: b.failureCount,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export function __resetExternalDeliveryObservability(): void {
  for (const k of COUNTER_KEYS) counters[k] = 0;
  providerLatency.clear();
}

export const __TEST = {
  COUNTER_KEYS,
};
