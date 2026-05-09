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
  /** successRate >= 0.90 AND total >= 15. Strong cumulative delivery
   *  history relative to volume. */
  strong_delivery_history: boolean;
  /** (rto + cancelled) / total >= 0.25 AND total >= 10. Operational
   *  evidence that returns are elevated; NOT a fraud verdict. May
   *  reflect buyer-side or merchant-side cancellations, RTOs, or
   *  upstream-data ambiguity (some providers conflate the categories). */
  elevated_return_pattern: boolean;
  /** total < 5 — too few observations to draw a conclusion. */
  sparse_history: boolean;
  /** Per-provider successRate σ > 0.20 across ≥2 contributing
   *  providers. Operational evidence — different providers see
   *  materially different histories, which may indicate provider
   *  data-quality variance OR a phone reassignment. NOT a verdict. */
  mixed_delivery_history: boolean;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const ELEVATED_RETURN_RATE = 0.25;
const ELEVATED_RETURN_MIN_OBSERVATIONS = 10;
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
  const cancelled = aggregate.cancelled ?? 0;
  const successRate = aggregate.successRate ?? 0;

  // Elevated-return-rate uses (rto + cancelled) / total. Some providers
  // (notably BDCourier-style aggregators) lump RTOs into cancelled
  // counters; this denominator captures the worst-case interpretation
  // honestly without exaggerating either category.
  const returnish = rto + cancelled;
  const elevatedRate = total > 0 ? returnish / total : 0;

  const sparse_history = total < SPARSE_HISTORY_THRESHOLD;
  // Sparse history short-circuits both positive AND negative
  // classifications — we don't have enough data to draw conclusions.
  const elevated_return_pattern =
    !sparse_history &&
    total >= ELEVATED_RETURN_MIN_OBSERVATIONS &&
    elevatedRate >= ELEVATED_RETURN_RATE;
  const strong_delivery_history =
    !sparse_history &&
    total >= STRONG_MIN_OBSERVATIONS &&
    successRate >= STRONG_SUCCESS_RATE;

  const variance = providerSuccessRateVariance(providers);
  const mixed_delivery_history =
    variance > MIXED_REPUTATION_VARIANCE_THRESHOLD;

  return {
    strong_delivery_history,
    elevated_return_pattern,
    sparse_history,
    mixed_delivery_history,
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  ELEVATED_RETURN_RATE,
  ELEVATED_RETURN_MIN_OBSERVATIONS,
  STRONG_SUCCESS_RATE,
  STRONG_MIN_OBSERVATIONS,
  SPARSE_HISTORY_THRESHOLD,
  MIXED_REPUTATION_VARIANCE_THRESHOLD,
};
