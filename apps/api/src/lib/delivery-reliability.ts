/**
 * delivery-reliability — pure-function classifier that turns a buyer's
 * historical delivery outcomes (per-customer, per-address, per-courier-lane),
 * plus secondary inputs (cross-merchant network, address quality), into an
 * explainable 0–100 reliability score with a tier label and a list of
 * operator-readable signals.
 *
 * **Visibility only.** This module:
 *   - never writes to the database
 *   - never reads the database
 *   - never enqueues a job
 *   - never modifies fraud / risk / automation state
 *   - never feeds `computeRisk`
 *   - never logs (callers do)
 *   - never reads env / clock except via the injectable `now`
 *
 * Contract: same inputs in → same outputs out. Tests must be runnable
 * without `mongodb-memory-server`.
 *
 * Score model — signed weights summed onto a neutral baseline of 50:
 *   - positive signals reward delivery reliability evidence (clean buyer
 *     history, clean-address history, strong courier lane).
 *   - negative signals reduce the score for prior RTOs, address reuse,
 *     weak courier lanes, network warnings, incomplete address.
 *   - score is clamped to [0, 100]; tier is derived from cutoffs that
 *     mirror `lib/intent.ts`.
 *
 * `tier: "no_data"` short-circuit fires when none of the three primary
 * axes (customer / address / courier) has enough evidence. Secondary
 * signals (network / address quality) DO NOT keep the result out of
 * `no_data` on their own — they only modulate score once at least one
 * primary axis has carried enough observations.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export const DELIVERY_RELIABILITY_TIERS = [
  "verified",
  "implicit",
  "unverified",
  "no_data",
] as const;
export type DeliveryReliabilityTier = (typeof DELIVERY_RELIABILITY_TIERS)[number];

/** Stable signal keys — UI maps these to localized copy. */
export const DELIVERY_RELIABILITY_SIGNAL_KEYS = [
  "no_history_data",
  "customer_repeat_success",
  "customer_repeat_rto",
  "customer_low_success_rate",
  "address_clean_history",
  "address_repeat_rto",
  "address_multi_buyer",
  "courier_lane_strong",
  "courier_lane_weak",
  "courier_lane_unknown",
  "network_warning",
  "address_quality_warning",
] as const;
export type DeliveryReliabilitySignalKey =
  (typeof DELIVERY_RELIABILITY_SIGNAL_KEYS)[number];

export interface DeliveryReliabilitySignal {
  key: DeliveryReliabilitySignalKey;
  /** Signed integer. Positive = reward, negative = penalty. */
  weight: number;
  /** Operator-readable rationale — surfaced verbatim. */
  detail: string;
}

export interface DeliveryReliabilityResult {
  score: number;
  tier: DeliveryReliabilityTier;
  signals: DeliveryReliabilitySignal[];
  samplesConsidered: { customer: number; address: number; courier: number };
  computedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Input shapes — STRUCTURAL, not Mongoose. Keeps the unit-test bundle lean. */
/* -------------------------------------------------------------------------- */

export interface CustomerReliabilityStats {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  lastOutcomeAt?: Date | null;
  firstOutcomeAt?: Date | null;
}

export interface AddressReliabilityStats {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  /** Distinct buyer-phone-hashes that have shipped to this address. */
  distinctPhoneCount?: number;
  lastOutcomeAt?: Date | null;
  firstOutcomeAt?: Date | null;
}

export interface CourierLaneStats {
  /** Fraction in [0, 1]. */
  successRate?: number;
  /** Fraction in [0, 1]. */
  rtoRate?: number;
  avgDeliveryHours?: number | null;
  /** Resolved-order count (delivered + rto + cancelled). */
  observations?: number;
  /** True when the underlying row is below the cold-start floor. */
  coldStart?: boolean;
  /** True when the underlying row is past the staleness cutoff. */
  stale?: boolean;
  /** Where the courier-intelligence engine matched — informational only in v1. */
  matchedOn?: "district" | "global" | "cold_start";
}

export interface AddressQualityHint {
  completeness?: "complete" | "partial" | "incomplete";
  score?: number;
  missingHints?: string[];
}

export interface NetworkReliabilitySignalInput {
  /** Distinct merchants that have observed this fingerprint, excluding caller. */
  merchantCount?: number;
  /** rto / (rto + delivered) — null when no completed history. */
  rtoRate?: number | null;
}

export interface ClassifyDeliveryReliabilityInput {
  customerStats?: CustomerReliabilityStats | null;
  addressStats?: AddressReliabilityStats | null;
  courierStats?: CourierLaneStats | null;
  /** Optional thana — informational; not currently consumed by any signal. */
  thana?: string | null;
  addressQuality?: AddressQualityHint | null;
  networkAggregate?: NetworkReliabilitySignalInput | null;
  /** Reference time — defaults to `new Date()`. Injectable for tests. */
  now?: Date;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const BASELINE_SCORE = 50;
const VERIFIED_THRESHOLD = 70;
const IMPLICIT_THRESHOLD = 40;

const MIN_OBSERVATIONS_FOR_SIGNAL = 3;
const MIN_OBSERVATIONS_FOR_LANE_SIGNAL = 30;
/**
 * Floor on resolved customer outcomes before a low-success penalty fires.
 * Phase 1: bumped from 3→5. Bangladesh COD reality is that early-life
 * cancellations are commonly merchant-side (out of stock) or buyer-life
 * events (changed mind, family conflict) rather than fraud — so a buyer
 * with 0/1/2 (delivered/rto/cancelled) shouldn't carry a permanent penalty
 * until the sample is large enough to be diagnostic.
 */
const MIN_OBSERVATIONS_FOR_LOW_SUCCESS = 5;
/**
 * Distinct phones on the same address before the trust-layer mirror of
 * `duplicate_address` fires. Phase 1: bumped from 3→5 (matches the new
 * `ADDRESS_REUSE_THRESHOLD` in `server/risk.ts`).
 */
const ADDRESS_MULTI_BUYER_THRESHOLD = 5;

const STALE_DAYS = 180;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/** Signed magnitudes — caller-side weights. Stored as positive ints; the
 *  signal builders apply the sign at emit-time so the constant block reads
 *  as the operator does ("how much is this signal worth"). */
const WEIGHTS = {
  customerSuccessMax: 25,
  customerRtoCap: 20,
  customerRtoPerHit: 5,
  customerLowSuccess: 15,
  addressClean: 15,
  addressRtoCap: 15,
  addressRtoPerHit: 5,
  addressMultiBuyer: 10,
  courierStrong: 20,
  courierWeak: 20,
  courierUnknown: 5,
  networkWarning: 10,
  addressQualityWarning: 10,
} as const;

/* -------------------------------------------------------------------------- */
/* Defensive helpers                                                          */
/* -------------------------------------------------------------------------- */

function safeCount(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function safeRate(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function safeNow(input: Date | undefined): Date {
  if (input instanceof Date && Number.isFinite(input.getTime())) return input;
  return new Date();
}

function lastOutcomeMs(value: Date | null | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const t = value.getTime();
  return Number.isFinite(t) ? t : null;
}

function isStaleAxis(
  stats: { lastOutcomeAt?: Date | null } | null | undefined,
  now: Date,
): boolean {
  if (!stats) return false;
  const t = lastOutcomeMs(stats.lastOutcomeAt ?? null);
  if (t === null) return false;
  return now.getTime() - t > STALE_MS;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function classifyTier(score: number): DeliveryReliabilityTier {
  // Defensive — NaN / non-finite collapse to "unverified" via the !>= path.
  if (Number.isFinite(score) && score >= VERIFIED_THRESHOLD) return "verified";
  if (Number.isFinite(score) && score >= IMPLICIT_THRESHOLD) return "implicit";
  return "unverified";
}

/* -------------------------------------------------------------------------- */
/* Per-axis analyzers                                                         */
/* -------------------------------------------------------------------------- */

interface AxisResult {
  signals: DeliveryReliabilitySignal[];
  /** Raw observation count for `samplesConsidered` reporting. */
  samples: number;
  /** True when this axis has enough usable evidence to NOT count toward no_data. */
  evidenced: boolean;
}

function analyzeCustomerAxis(
  stats: CustomerReliabilityStats | null | undefined,
  now: Date,
): AxisResult {
  if (!stats) return { signals: [], samples: 0, evidenced: false };

  const delivered = safeCount(stats.deliveredCount);
  const rto = safeCount(stats.rtoCount);
  const cancelled = safeCount(stats.cancelledCount);
  const samples = delivered + rto + cancelled;

  if (samples < MIN_OBSERVATIONS_FOR_SIGNAL) {
    return { signals: [], samples, evidenced: false };
  }
  if (isStaleAxis(stats, now)) {
    // Stale data is treated as cold-start: signals don't fire and the axis
    // doesn't carry the "evidenced" flag.
    return { signals: [], samples, evidenced: false };
  }

  const signals: DeliveryReliabilitySignal[] = [];
  const deliveredRate = samples > 0 ? delivered / samples : 0;

  // customer_repeat_success — graduated by deliveredRate. Only emit when
  // there's a positive contribution; a 0-weight signal would just be noise.
  const successWeight = Math.round(deliveredRate * WEIGHTS.customerSuccessMax);
  if (successWeight > 0) {
    signals.push({
      key: "customer_repeat_success",
      weight: successWeight,
      detail: `Customer delivered ${delivered} of ${samples} prior order${samples === 1 ? "" : "s"} (${Math.round(deliveredRate * 100)}%).`,
    });
  }

  // customer_repeat_rto — capped per-RTO penalty.
  if (rto > 0) {
    const penalty = Math.min(WEIGHTS.customerRtoCap, rto * WEIGHTS.customerRtoPerHit);
    signals.push({
      key: "customer_repeat_rto",
      weight: -penalty,
      detail: `${rto} prior return${rto === 1 ? "" : "s"} from this customer.`,
    });
  }

  // customer_low_success_rate — flat penalty when the buyer's resolved-order
  // success rate sits below 40%. Requires a meaningful sample
  // (`MIN_OBSERVATIONS_FOR_LOW_SUCCESS`) so a single bad burst on a brand-new
  // buyer doesn't stick a permanent label.
  if (samples >= MIN_OBSERVATIONS_FOR_LOW_SUCCESS && deliveredRate < 0.4) {
    signals.push({
      key: "customer_low_success_rate",
      weight: -WEIGHTS.customerLowSuccess,
      detail: `Only ${Math.round(deliveredRate * 100)}% of past orders delivered (${delivered} of ${samples}).`,
    });
  }

  return { signals, samples, evidenced: true };
}

function analyzeAddressAxis(
  stats: AddressReliabilityStats | null | undefined,
  now: Date,
): AxisResult {
  if (!stats) return { signals: [], samples: 0, evidenced: false };

  const delivered = safeCount(stats.deliveredCount);
  const rto = safeCount(stats.rtoCount);
  const cancelled = safeCount(stats.cancelledCount);
  const distinctPhones = safeCount(stats.distinctPhoneCount);
  const samples = delivered + rto + cancelled;

  if (samples < MIN_OBSERVATIONS_FOR_SIGNAL) {
    return { signals: [], samples, evidenced: false };
  }
  if (isStaleAxis(stats, now)) {
    return { signals: [], samples, evidenced: false };
  }

  const signals: DeliveryReliabilitySignal[] = [];

  // address_clean_history — only fires with at least 2 deliveries AND zero
  // RTOs. A history of (1 delivered, 0 rto) isn't yet a "clean" signal.
  if (delivered >= 2 && rto === 0) {
    signals.push({
      key: "address_clean_history",
      weight: WEIGHTS.addressClean,
      detail: `${delivered} prior delivered orders to this address with no returns.`,
    });
  }

  // address_repeat_rto — capped per-RTO penalty.
  if (rto > 0) {
    const penalty = Math.min(WEIGHTS.addressRtoCap, rto * WEIGHTS.addressRtoPerHit);
    signals.push({
      key: "address_repeat_rto",
      weight: -penalty,
      detail: `${rto} prior return${rto === 1 ? "" : "s"} at this address.`,
    });
  }

  // address_multi_buyer — five-or-more distinct phones at the same address
  // (Phase 1: was three). Sustained-success suppression: an address with
  // delivered ≥ distinctPhones is almost certainly a legitimate shared
  // location (apartment, family, workplace) and gets no penalty.
  if (
    distinctPhones >= ADDRESS_MULTI_BUYER_THRESHOLD &&
    !(distinctPhones > 0 && delivered >= distinctPhones)
  ) {
    signals.push({
      key: "address_multi_buyer",
      weight: -WEIGHTS.addressMultiBuyer,
      detail: `${distinctPhones} distinct buyers have shipped to this address — could be a shared address (apartment / family / workplace).`,
    });
  }

  return { signals, samples, evidenced: true };
}

function analyzeCourierAxis(
  stats: CourierLaneStats | null | undefined,
): AxisResult {
  if (!stats) return { signals: [], samples: 0, evidenced: false };

  const observations = safeCount(stats.observations);
  if (observations < MIN_OBSERVATIONS_FOR_SIGNAL) {
    return { signals: [], samples: observations, evidenced: false };
  }

  const successRate = safeRate(stats.successRate);
  const rtoRate = safeRate(stats.rtoRate);
  const coldStart = stats.coldStart === true;
  const stale = stats.stale === true;
  const matchedOn = stats.matchedOn ?? null;
  const matchedDescriptor =
    matchedOn === "district"
      ? "district"
      : matchedOn === "global"
        ? "merchant"
        : "courier";

  // Cold-start, stale, or below-lane-floor → unknown signal but the axis
  // still counts as "evidenced" (we DO have observations; the signal just
  // says "not enough to be confident"). Mirrors `selectBestCourier`'s
  // posture: stale courier "downweights" via this signal rather than
  // disappearing.
  if (coldStart || stale || observations < MIN_OBSERVATIONS_FOR_LANE_SIGNAL) {
    const detail = stale
      ? "Limited recent delivery history on this courier."
      : `Only ${observations} prior delivery${observations === 1 ? "" : "ies"} on this courier — not enough to score the lane.`;
    return {
      signals: [
        {
          key: "courier_lane_unknown",
          weight: -WEIGHTS.courierUnknown,
          detail,
        },
      ],
      samples: observations,
      evidenced: true,
    };
  }

  // observations >= MIN_OBSERVATIONS_FOR_LANE_SIGNAL, !cold_start, !stale.
  if (successRate >= 0.85) {
    return {
      signals: [
        {
          key: "courier_lane_strong",
          weight: WEIGHTS.courierStrong,
          detail: `Courier delivered ${Math.round(successRate * 100)}% on ${observations} ${matchedDescriptor} orders.`,
        },
      ],
      samples: observations,
      evidenced: true,
    };
  }

  if (rtoRate >= 0.2) {
    return {
      signals: [
        {
          key: "courier_lane_weak",
          weight: -WEIGHTS.courierWeak,
          detail: `Courier RTO rate ${Math.round(rtoRate * 100)}% on ${observations} ${matchedDescriptor} orders.`,
        },
      ],
      samples: observations,
      evidenced: true,
    };
  }

  // Middle ground — evidenced, neither strong nor weak. No signal contributes
  // weight but the axis still counts as "evidenced" so the result isn't
  // collapsed to no_data on this axis alone.
  return { signals: [], samples: observations, evidenced: true };
}

/* -------------------------------------------------------------------------- */
/* Secondary signal builder — runs only when a primary axis is evidenced.     */
/* -------------------------------------------------------------------------- */

function buildSecondarySignals(
  input: ClassifyDeliveryReliabilityInput,
): DeliveryReliabilitySignal[] {
  const signals: DeliveryReliabilitySignal[] = [];

  const network = input.networkAggregate;
  if (network) {
    const merchantCount = safeCount(network.merchantCount);
    const rtoRate =
      network.rtoRate == null || !Number.isFinite(network.rtoRate)
        ? null
        : safeRate(network.rtoRate);
    if (rtoRate !== null && rtoRate >= 0.5 && merchantCount >= 2) {
      signals.push({
        key: "network_warning",
        weight: -WEIGHTS.networkWarning,
        detail: `${Math.round(rtoRate * 100)}% return rate across ${merchantCount} merchants in the cross-merchant network.`,
      });
    }
  }

  const aq = input.addressQuality;
  if (aq?.completeness === "incomplete") {
    signals.push({
      key: "address_quality_warning",
      weight: -WEIGHTS.addressQualityWarning,
      detail: "Address looks incomplete — courier may have trouble locating it.",
    });
  }

  return signals;
}

/* -------------------------------------------------------------------------- */
/* Public classifier                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Classify a buyer / address / courier-lane combination into a delivery-
 * reliability tier with explainable signals.
 *
 * Returns a stable `DeliveryReliabilityResult`. Never throws — every
 * degenerate input degrades to `tier: "no_data"` with a single sentinel
 * signal.
 */
export function classifyDeliveryReliability(
  input: ClassifyDeliveryReliabilityInput | null | undefined,
): DeliveryReliabilityResult {
  const safeInput =
    input && typeof input === "object"
      ? (input as ClassifyDeliveryReliabilityInput)
      : ({} as ClassifyDeliveryReliabilityInput);
  const now = safeNow(safeInput.now);

  const customer = analyzeCustomerAxis(safeInput.customerStats ?? null, now);
  const address = analyzeAddressAxis(safeInput.addressStats ?? null, now);
  const courier = analyzeCourierAxis(safeInput.courierStats ?? null);

  if (!customer.evidenced && !address.evidenced && !courier.evidenced) {
    return {
      score: 0,
      tier: "no_data",
      signals: [
        {
          key: "no_history_data",
          weight: 0,
          detail: "Not enough delivery history yet to score this order.",
        },
      ],
      samplesConsidered: { customer: 0, address: 0, courier: 0 },
      computedAt: now,
    };
  }

  const primary = [
    ...customer.signals,
    ...address.signals,
    ...courier.signals,
  ];
  const secondary = buildSecondarySignals(safeInput);
  const all = [...primary, ...secondary];

  const sum = all.reduce((acc, s) => acc + s.weight, 0);
  const score = clamp(BASELINE_SCORE + sum, 0, 100);
  const tier = classifyTier(score);

  return {
    score,
    tier,
    signals: all,
    samplesConsidered: {
      customer: customer.samples,
      address: address.samples,
      courier: courier.samples,
    },
    computedAt: now,
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface — exposes constants + helpers so the test file can exercise   */
/* boundary cases without re-deriving them.                                   */
/* -------------------------------------------------------------------------- */
export const __TEST = {
  BASELINE_SCORE,
  VERIFIED_THRESHOLD,
  IMPLICIT_THRESHOLD,
  MIN_OBSERVATIONS_FOR_SIGNAL,
  MIN_OBSERVATIONS_FOR_LANE_SIGNAL,
  MIN_OBSERVATIONS_FOR_LOW_SUCCESS,
  ADDRESS_MULTI_BUYER_THRESHOLD,
  STALE_DAYS,
  STALE_MS,
  WEIGHTS,
  classifyTier,
  isStaleAxis,
  safeCount,
  safeRate,
  clamp,
};
