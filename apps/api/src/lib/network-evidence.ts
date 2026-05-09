/**
 * network-evidence — pure-function classifier that translates a
 * `lookupNetworkRisk` result (from `lib/fraud-network.ts`) into a
 * merchant-facing operational evidence label.
 *
 * Phase 4A.5 — surfaces the cross-merchant FraudSignal aggregate that
 * already exists in the codebase as the platform's actual moat. Same
 * shape as `lib/delivery-reliability.ts`, `lib/lane-intelligence.ts`,
 * and `lib/external-delivery/signals.ts`: pure function, stable signal
 * keys, integer weights, operator-readable details, no fuzzy/AI/ML.
 *
 * Hard rules (binding):
 *   - Pure function. Same inputs → same outputs.
 *   - VISIBILITY ONLY. Output is an evidence label + a list of signal
 *     keys; the caller decides whether to act on them.
 *   - Operationally framed. Detail strings describe what's been
 *     observed across the platform; never accuse the buyer.
 *   - Privacy-preserving. The classifier never sees a phone number,
 *     order id, or merchant identity — only counters + bounded
 *     metadata.
 */

import { type NetworkRiskAggregate } from "./fraud-network.js";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type NetworkEvidenceLabel =
  | "strong"     // delivers reliably across the network
  | "caution"    // high return rate observed across multiple merchants
  | "neutral"    // sufficient data but neither strongly good nor bad
  | "no_data";   // no network-suppressible signal

export const NETWORK_EVIDENCE_SIGNAL_KEYS = [
  "network_strong_delivery",
  "network_high_return_rate",
  "network_recent_activity",
  "network_sparse",
  "network_disabled_or_missing",
] as const;
export type NetworkEvidenceSignalKey =
  (typeof NETWORK_EVIDENCE_SIGNAL_KEYS)[number];

export interface NetworkEvidenceSignal {
  key: NetworkEvidenceSignalKey;
  /** Operator-readable rationale — surfaced verbatim. */
  detail: string;
}

export interface NetworkEvidenceResult {
  label: NetworkEvidenceLabel;
  /** True when the platform has any matched evidence at all. */
  matched: boolean;
  /** Mirrors `lookupNetworkRisk`'s `matchedOn` so the UI knows which
   *  fingerprint composition produced the match. */
  matchedOn: NetworkRiskAggregate["matchedOn"];
  /** Number of OTHER merchants on the platform that have observed
   *  this fingerprint. Already excludes the caller in the upstream
   *  lookup. */
  merchantCount: number;
  /** Resolved order count across the network: delivered + rto +
   *  cancelled. */
  totalObserved: number;
  /** delivered / (delivered + rto). Null when no decided history. */
  successRate: number | null;
  rtoRate: number | null;
  signals: NetworkEvidenceSignal[];
  /** When the network first observed this fingerprint. */
  firstSeenAt: Date | null;
  /** Most recent observation across the network. */
  lastSeenAt: Date | null;
  /** Locked to the lookup contract — never raw IDs, never PII. */
  source: "fraud_signal_v1";
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const STRONG_SUCCESS_RATE = 0.85;
const STRONG_MIN_MERCHANTS = 2;
const STRONG_MIN_OBSERVATIONS = 5;

const CAUTION_RTO_RATE = 0.5;
const CAUTION_MIN_MERCHANTS = 2;
const CAUTION_MIN_OBSERVATIONS = 4;

const RECENT_ACTIVITY_DAYS = 30;
const RECENT_ACTIVITY_MS = RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Public classifier                                                          */
/* -------------------------------------------------------------------------- */

const EMPTY: NetworkEvidenceResult = {
  label: "no_data",
  matched: false,
  matchedOn: "none",
  merchantCount: 0,
  totalObserved: 0,
  successRate: null,
  rtoRate: null,
  signals: [
    {
      key: "network_disabled_or_missing",
      detail:
        "No cross-merchant evidence available for this customer yet — either the network is still warming up or this is a new fingerprint.",
    },
  ],
  firstSeenAt: null,
  lastSeenAt: null,
  source: "fraud_signal_v1",
};

/**
 * Classify a `lookupNetworkRisk` aggregate into operational evidence.
 *
 * Returns `EMPTY` (label: "no_data") when:
 *   - aggregate is null/undefined
 *   - matchedOn is "none" (no fingerprint hit)
 *   - merchantCount is below the floor for any actionable signal
 *
 * Pure — same input → same output. Tests run without DB.
 */
export function classifyNetworkEvidence(
  aggregate: NetworkRiskAggregate | null | undefined,
  options: { now?: Date } = {},
): NetworkEvidenceResult {
  if (!aggregate || aggregate.matchedOn === "none") return EMPTY;

  const now = options.now ?? new Date();
  const decided = aggregate.deliveredCount + aggregate.rtoCount;
  const total = decided + aggregate.cancelledCount;
  const successRate =
    decided > 0 ? aggregate.deliveredCount / decided : null;
  const rtoRate = aggregate.rtoRate ?? null;

  const signals: NetworkEvidenceSignal[] = [];

  // --- Strong-delivery signal ---
  if (
    successRate !== null &&
    successRate >= STRONG_SUCCESS_RATE &&
    aggregate.merchantCount >= STRONG_MIN_MERCHANTS &&
    decided >= STRONG_MIN_OBSERVATIONS
  ) {
    signals.push({
      key: "network_strong_delivery",
      detail: `Customer delivers reliably across ${aggregate.merchantCount} other merchants on the platform (${Math.round(successRate * 100)}% delivered on ${decided} orders).`,
    });
  }

  // --- High-return signal ---
  if (
    rtoRate !== null &&
    rtoRate >= CAUTION_RTO_RATE &&
    aggregate.merchantCount >= CAUTION_MIN_MERCHANTS &&
    decided >= CAUTION_MIN_OBSERVATIONS
  ) {
    signals.push({
      key: "network_high_return_rate",
      detail: `Customer has ${Math.round(rtoRate * 100)}% return rate across ${aggregate.merchantCount} other merchants — review carefully before booking.`,
    });
  }

  // --- Recent-activity signal ---
  if (aggregate.lastSeenAt) {
    const t = aggregate.lastSeenAt.getTime();
    if (Number.isFinite(t) && now.getTime() - t < RECENT_ACTIVITY_MS) {
      signals.push({
        key: "network_recent_activity",
        detail: `Most recent network activity for this customer was within the last ${RECENT_ACTIVITY_DAYS} days.`,
      });
    }
  }

  // --- Sparse-data signal (fired when matched but below actionable floors) ---
  if (signals.length === 0) {
    signals.push({
      key: "network_sparse",
      detail: `Some cross-merchant evidence exists (${aggregate.merchantCount} other merchants, ${total} orders) but not enough yet to draw a strong conclusion.`,
    });
  }

  // --- Label resolution ---
  let label: NetworkEvidenceLabel = "neutral";
  const hasStrong = signals.some((s) => s.key === "network_strong_delivery");
  const hasCaution = signals.some((s) => s.key === "network_high_return_rate");
  if (hasStrong && !hasCaution) label = "strong";
  else if (hasCaution && !hasStrong) label = "caution";
  else if (hasStrong && hasCaution) label = "neutral"; // mixed signals
  else if (signals.every((s) => s.key === "network_sparse")) label = "no_data";

  return {
    label,
    matched: true,
    matchedOn: aggregate.matchedOn,
    merchantCount: aggregate.merchantCount,
    totalObserved: total,
    successRate,
    rtoRate,
    signals,
    firstSeenAt: aggregate.firstSeenAt ?? null,
    lastSeenAt: aggregate.lastSeenAt ?? null,
    source: "fraud_signal_v1",
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  STRONG_SUCCESS_RATE,
  STRONG_MIN_MERCHANTS,
  STRONG_MIN_OBSERVATIONS,
  CAUTION_RTO_RATE,
  CAUTION_MIN_MERCHANTS,
  CAUTION_MIN_OBSERVATIONS,
  RECENT_ACTIVITY_DAYS,
  RECENT_ACTIVITY_MS,
  EMPTY,
};
