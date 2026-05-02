import { captureMessage } from "../telemetry.js";

/**
 * Observability for the cross-merchant fraud network.
 *
 * In-process counters (mirrors the courier-webhook observability shape) plus
 * structured JSON log lines. Replace with Prometheus when one is wired up;
 * the data is already in the right shape.
 *
 * What we never log:
 *  - Raw phone / address values
 *  - The merchantIds list from FraudSignal
 *  - The exact set of signal hashes
 * Only counts, outcomes, and (in DEBUG-tier) the matchedOn dimension.
 */

export type NetworkOutcome =
  | "lookup_hit_applied"   // lookup returned a non-zero bonus
  | "lookup_hit_suppressed"// lookup matched but bonus was 0 (under threshold)
  | "lookup_miss"          // no match in the network
  | "lookup_disabled"      // FRAUD_NETWORK_ENABLED=false
  | "lookup_stale"         // matched signal is older than DECAY_DAYS
  | "lookup_warming_up"    // network too small; bonus damped
  | "contribute_recorded"  // contributeOutcome wrote/upserted
  | "contribute_disabled"  // FRAUD_NETWORK_ENABLED=false on the contribute path
  | "contribute_skipped"   // both hashes absent — no fingerprint
  | "contribute_failed";   // write threw

export interface RecordNetworkOutcomeInput {
  outcome: NetworkOutcome;
  merchantId?: string;
  matchedOn?: "phone+address" | "phone" | "address" | "none";
  bonus?: number;
  rtoRate?: number | null;
  /** Approximate "RTO prevented" estimate when the bonus flipped a decision. */
  estimatedPrevented?: boolean;
  error?: string;
}

const counters: Record<NetworkOutcome, number> = {
  lookup_hit_applied: 0,
  lookup_hit_suppressed: 0,
  lookup_miss: 0,
  lookup_disabled: 0,
  lookup_stale: 0,
  lookup_warming_up: 0,
  contribute_recorded: 0,
  contribute_disabled: 0,
  contribute_skipped: 0,
  contribute_failed: 0,
};

let preventedRtoEstimate = 0;

const SENTRY_OUTCOMES: ReadonlySet<NetworkOutcome> = new Set(["contribute_failed"]);

export function recordNetworkOutcome(input: RecordNetworkOutcomeInput): void {
  counters[input.outcome] += 1;
  if (input.estimatedPrevented) preventedRtoEstimate += 1;

  const line = {
    msg: "fraud_network",
    outcome: input.outcome,
    merchantId: input.merchantId,
    matchedOn: input.matchedOn,
    bonus: input.bonus,
    rtoRate: input.rtoRate,
    estimatedPrevented: input.estimatedPrevented,
    error: input.error?.slice(0, 200),
  };

  if (SENTRY_OUTCOMES.has(input.outcome)) {
    console.error(JSON.stringify(line));
    captureMessage(`fraud_network ${input.outcome}`, {
      tags: { outcome: input.outcome },
      level: "error",
    });
    return;
  }

  // Most outcomes are info-level. lookup_disabled / contribute_disabled are
  // operationally interesting but not noisy when the flag is on, so log them
  // at info too — easier to grep for "lookup_disabled" if rollout drifts.
  console.log(JSON.stringify(line));
}

export interface NetworkCountersSnapshot {
  /** Lookup hits that produced a non-zero bonus. */
  hitsApplied: number;
  /** Lookups that matched but couldn't apply (under threshold / stale). */
  hitsSuppressed: number;
  /** Lookups that found nothing. */
  misses: number;
  /** Times the global flag short-circuited a lookup. */
  disabledLookups: number;
  /** Signals dropped for being older than the decay window. */
  staleLookups: number;
  /** Lookups that hit the warming-up damper. */
  warmingUpLookups: number;
  /** Successful contributions (delivered / rto / cancelled). */
  contributesRecorded: number;
  contributesDisabled: number;
  contributesSkipped: number;
  contributesFailed: number;
  /** Coarse upper bound on how many flagged orders the network may have prevented. */
  estimatedPreventedRto: number;
  /** Hit rate across all (non-disabled) lookups. */
  hitRate: number;
}

export function snapshotNetworkCounters(): NetworkCountersSnapshot {
  const meaningfulLookups =
    counters.lookup_hit_applied +
    counters.lookup_hit_suppressed +
    counters.lookup_miss +
    counters.lookup_stale +
    counters.lookup_warming_up;
  const hitRate =
    meaningfulLookups === 0
      ? 0
      : counters.lookup_hit_applied / meaningfulLookups;
  return {
    hitsApplied: counters.lookup_hit_applied,
    hitsSuppressed: counters.lookup_hit_suppressed,
    misses: counters.lookup_miss,
    disabledLookups: counters.lookup_disabled,
    staleLookups: counters.lookup_stale,
    warmingUpLookups: counters.lookup_warming_up,
    contributesRecorded: counters.contribute_recorded,
    contributesDisabled: counters.contribute_disabled,
    contributesSkipped: counters.contribute_skipped,
    contributesFailed: counters.contribute_failed,
    estimatedPreventedRto: preventedRtoEstimate,
    hitRate,
  };
}

/** For tests — wipe counters. */
export function __resetNetworkCounters(): void {
  for (const k of Object.keys(counters) as NetworkOutcome[]) counters[k] = 0;
  preventedRtoEstimate = 0;
}
