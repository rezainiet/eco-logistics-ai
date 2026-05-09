/**
 * external-delivery / signals — pure-function classifier that turns an
 * aggregated profile into stable boolean signal flags.
 *
 * Same shape as `lib/delivery-reliability.ts` and
 * `lib/lane-intelligence.ts`. Signals are ADVISORY ONLY — no
 * auto-blocking, no autonomous decisions. A future risk-scoring
 * integration may consume these as additive evidence weights.
 *
 * Each signal carries a documented threshold; the operator UI maps
 * the boolean flag to localised copy.
 */

import {
  providerSuccessRateVariance,
  type AggregateResult,
  type ProviderResultLike,
} from "./aggregation.js";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface ExternalDeliverySignals {
  /** rtoRate >= 0.25 AND total >= 10. */
  high_rto_customer: boolean;
  /** successRate >= 0.90 AND total >= 15. */
  strong_delivery_history: boolean;
  /** total < 5. */
  sparse_history: boolean;
  /** Per-provider successRate σ > 0.20 across ≥2 contributing providers. */
  mixed_provider_reputation: boolean;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const HIGH_RTO_RATE = 0.25;
const HIGH_RTO_MIN_OBSERVATIONS = 10;
const STRONG_SUCCESS_RATE = 0.9;
const STRONG_MIN_OBSERVATIONS = 15;
const SPARSE_HISTORY_THRESHOLD = 5;
const MIXED_REPUTATION_VARIANCE_THRESHOLD = 0.2;

/* -------------------------------------------------------------------------- */
/* Public classifier                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Classify a profile into stable signal flags. Pure — same inputs →
 * same outputs.
 *
 * `aggregate` is the rollup from `aggregateProviders`.
 * `providers` is the original list of per-provider results, used for
 * the variance computation behind `mixed_provider_reputation`.
 */
export function classifyExternalDeliverySignals(
  aggregate: AggregateResult,
  providers: ReadonlyArray<ProviderResultLike>,
): ExternalDeliverySignals {
  const total = aggregate.total ?? 0;
  const delivered = aggregate.delivered ?? 0;
  const rto = aggregate.rto ?? 0;
  const decided = delivered + rto;
  const rtoRate = decided > 0 ? rto / decided : 0;
  const successRate = aggregate.successRate ?? 0;

  const sparse_history = total < SPARSE_HISTORY_THRESHOLD;
  // sparse history short-circuits the positive/negative classifications —
  // we don't have enough data to make a verdict.
  const high_rto_customer =
    !sparse_history &&
    total >= HIGH_RTO_MIN_OBSERVATIONS &&
    rtoRate >= HIGH_RTO_RATE;
  const strong_delivery_history =
    !sparse_history &&
    total >= STRONG_MIN_OBSERVATIONS &&
    successRate >= STRONG_SUCCESS_RATE;

  const variance = providerSuccessRateVariance(providers);
  const mixed_provider_reputation =
    variance > MIXED_REPUTATION_VARIANCE_THRESHOLD;

  return {
    high_rto_customer,
    strong_delivery_history,
    sparse_history,
    mixed_provider_reputation,
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  HIGH_RTO_RATE,
  HIGH_RTO_MIN_OBSERVATIONS,
  STRONG_SUCCESS_RATE,
  STRONG_MIN_OBSERVATIONS,
  SPARSE_HISTORY_THRESHOLD,
  MIXED_REPUTATION_VARIANCE_THRESHOLD,
};
