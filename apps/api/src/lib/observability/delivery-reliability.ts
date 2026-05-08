import { env } from "../../env.js";

/**
 * Observability for the Delivery Reliability v1 chokepoint fan-out + writer
 * helpers.
 *
 * Mirrors the in-process counter + structured-log pattern used by
 * `lib/observability/fraud-network.ts` and `lib/observability/courier-webhook.ts`.
 * No external metric system is wired up yet; counters are exposed via
 * `snapshotReliabilityCounters()` for the admin observability surface.
 *
 * Hard rules (binding):
 *   - Never throws back to the caller. Internal try/catch wraps log emission.
 *   - Never reads or writes Mongo. No I/O beyond `console.log` / `console.error`.
 *   - Never logs raw PII. The chokepoint already passes hashed phone +
 *     hashed address; this module never accepts raw values.
 *   - Gracefully no-ops when `DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED=0`.
 */

export type DeliveryReliabilityObservabilityEvent =
  /** Successful CustomerReliability upsert from `recordCustomerOutcome`. */
  | "customer_updated"
  /** Successful AddressReliability upsert from `recordAddressOutcome`. */
  | "address_updated"
  /** Caught throw inside either helper's Mongo write. */
  | "write_failed"
  /** Chokepoint reached the gated fan-out but skipped (flag off OR hash absent). */
  | "aggregate_skipped"
  /** Chokepoint observed a no-op terminal-status replay (newEvents=0, status unchanged). */
  | "replay_suppressed"
  /** Sampled aggregate row drifted from the comparison source. */
  | "drift_detected"
  /** Chokepoint fired the fan-out but the atomic Order.updateOne was rejected (§6.2 caveat). */
  | "invalid_transition"
  /** Integrity check on an aggregate row found a violation. */
  | "integrity_warning";

export interface RecordReliabilityOutcomeInput {
  event: DeliveryReliabilityObservabilityEvent;
  /** Merchant id (hex string). Optional — system-level emissions may omit. */
  merchantId?: string | null;
  /** Which axis fired this event, when applicable. */
  axis?: "customer" | "address";
  /** Stable code describing why; surfaced in logs + admin snapshots. */
  reason?: string;
  /** Helper round-trip latency (ms), when measured. */
  durationMs?: number;
  /** Truncated error message — never raw stack traces. */
  error?: string;
  /**
   * Bounded scalar metadata. Numbers, booleans, short strings only.
   * No buyer-identifying fields. No raw addresses / phones / emails.
   */
  meta?: Record<string, string | number | boolean | null | undefined>;
}

const COUNTER_KEYS = [
  "customer_updated",
  "address_updated",
  "write_failed",
  "aggregate_skipped",
  "replay_suppressed",
  "drift_detected",
  "invalid_transition",
  "integrity_warning",
] as const;

const counters: Record<DeliveryReliabilityObservabilityEvent, number> = {
  customer_updated: 0,
  address_updated: 0,
  write_failed: 0,
  aggregate_skipped: 0,
  replay_suppressed: 0,
  drift_detected: 0,
  invalid_transition: 0,
  integrity_warning: 0,
};

/** Events that warrant `console.error` instead of `console.log` (still no throw). */
const ERROR_EVENTS: ReadonlySet<DeliveryReliabilityObservabilityEvent> = new Set([
  "write_failed",
  "drift_detected",
  "invalid_transition",
  "integrity_warning",
]);

function safeMeta(
  meta: Record<string, string | number | boolean | null | undefined> | undefined,
): Record<string, string | number | boolean | null | undefined> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string | number | boolean | null | undefined> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string" && v.length > 200) {
      out[k] = v.slice(0, 200);
    } else if (typeof v === "number" && !Number.isFinite(v)) {
      out[k] = null;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Single emission point for delivery-reliability observability. Bumps the
 * in-process counter and emits a single-line JSON log. Never throws — log
 * emission failures are logged via console.error to avoid silent loss
 * but do NOT propagate.
 *
 * Gated on `DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED`. When the flag is
 * off, this is a constant-time no-op.
 */
export function recordReliabilityOutcome(
  input: RecordReliabilityOutcomeInput,
): void {
  if (!env.DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED) return;
  if (!input || typeof input !== "object") return;

  const { event } = input;
  if (typeof event !== "string" || !(event in counters)) return;

  try {
    counters[event] += 1;
    const line = {
      msg: "delivery_reliability",
      event,
      merchantId: input.merchantId ?? undefined,
      axis: input.axis,
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
    // Defence-in-depth — the emitter must never throw back. If something
    // pathological happens (e.g. a circular reference snuck into meta),
    // record the failure in stderr and walk away.
    try {
      console.error(
        `[delivery-reliability-observability] emit failed: ${(err as Error)?.message ?? err}`,
      );
    } catch {
      /* truly nothing we can do */
    }
  }
}

export interface ReliabilityCountersSnapshot {
  customerUpdated: number;
  addressUpdated: number;
  writeFailed: number;
  aggregateSkipped: number;
  replaySuppressed: number;
  driftDetected: number;
  invalidTransition: number;
  integrityWarning: number;
}

export function snapshotReliabilityCounters(): ReliabilityCountersSnapshot {
  return {
    customerUpdated: counters.customer_updated,
    addressUpdated: counters.address_updated,
    writeFailed: counters.write_failed,
    aggregateSkipped: counters.aggregate_skipped,
    replaySuppressed: counters.replay_suppressed,
    driftDetected: counters.drift_detected,
    invalidTransition: counters.invalid_transition,
    integrityWarning: counters.integrity_warning,
  };
}

/** Test-only — clear all counters. */
export function __resetReliabilityCounters(): void {
  for (const k of COUNTER_KEYS) counters[k] = 0;
}
