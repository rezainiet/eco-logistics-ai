/**
 * operational-recommendations — pure-function recommender that turns
 * the merchant-facing evidence available on an order into a stable
 * list of advisory next-steps.
 *
 * Pure — same inputs → same outputs. No DB, no I/O, no side effects.
 *
 * Lives in apps/web because it consumes already-classified server
 * data and produces UI-only output. apps/web has no test runner;
 * the logic is small enough to be exercised by hand with the
 * surrounding component.
 *
 * Hard rules (binding):
 *   - ADVISORY ONLY. Never produces an "auto-block" or "force
 *     reject" recommendation. The merchant remains in the loop.
 *   - Operational tone. Phrases recommendations as suggestions,
 *     never accusations.
 *   - Defensive: tolerates null / undefined / partial inputs;
 *     returns an empty list when nothing is actionable.
 */

export type RecommendationTone = "good" | "watch" | "muted";

export const OPERATIONAL_RECOMMENDATION_KEYS = [
  "low_friction_order",
  "confirm_by_phone",
  "consider_partial_advance",
  "monitor_retry_outcomes",
  "use_strong_courier_lane",
  "address_clarification",
] as const;
export type OperationalRecommendationKey =
  (typeof OPERATIONAL_RECOMMENDATION_KEYS)[number];

export interface OperationalRecommendation {
  key: OperationalRecommendationKey;
  /** Short merchant-facing label (≤60 chars). */
  label: string;
  /** Operator-readable description (≤200 chars). */
  description: string;
  tone: RecommendationTone;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

export interface RecommendationInputs {
  /** From `order.networkEvidence` (Phase 4A.5). */
  networkEvidence?: {
    label?: "strong" | "caution" | "neutral" | "no_data";
  } | null;
  /** From `order.externalDelivery.signals` (Phase 4A). */
  externalSignals?: {
    strong_delivery_history?: boolean;
    elevated_return_pattern?: boolean;
    sparse_history?: boolean;
    mixed_delivery_history?: boolean;
  } | null;
  /** From `order.deliveryReliability.tier`. */
  reliabilityTier?: "verified" | "implicit" | "unverified" | "no_data";
  /** From `order.operationalHint.code`. */
  operationalHintCode?: string | null;
  /** From `order.automation.state`. */
  automationState?: string | null;
  /** From `order.order.cod` — Bangladesh BDT. */
  codAmount?: number | null;
  /** Computed merchant threshold for "extreme COD" — passed in by
   *  the caller from the existing `risk.dynamicThresholds` field if
   *  present. Default 10000 BDT matches the platform default. */
  extremeCodBdt?: number;
}

/* -------------------------------------------------------------------------- */
/* Pure classifier                                                            */
/* -------------------------------------------------------------------------- */

const DEFAULT_EXTREME_COD_BDT = 10_000;

function isUnconfirmed(state: string | null | undefined): boolean {
  if (!state) return false;
  return (
    state === "pending_confirmation" ||
    state === "requires_review" ||
    state === "not_evaluated"
  );
}

/**
 * Build the advisory recommendation list. Empty list = render
 * nothing.
 */
export function buildOperationalRecommendations(
  inputs: RecommendationInputs | null | undefined,
): OperationalRecommendation[] {
  if (!inputs) return [];
  const out: OperationalRecommendation[] = [];

  const networkLabel = inputs.networkEvidence?.label ?? null;
  const ext = inputs.externalSignals ?? null;
  const reliabilityTier = inputs.reliabilityTier;
  const hint = inputs.operationalHintCode ?? null;
  const unconfirmed = isUnconfirmed(inputs.automationState);
  const cod = typeof inputs.codAmount === "number" ? inputs.codAmount : 0;
  const extremeCod =
    typeof inputs.extremeCodBdt === "number" && inputs.extremeCodBdt > 0
      ? inputs.extremeCodBdt
      : DEFAULT_EXTREME_COD_BDT;

  // 1. low_friction_order — strongest positive signal.
  //    Both reliability AND network agree this buyer is reliable.
  //    Surface as a calm "no extra work needed" line.
  if (
    networkLabel === "strong" ||
    reliabilityTier === "verified" ||
    ext?.strong_delivery_history === true
  ) {
    out.push({
      key: "low_friction_order",
      label: "Low-friction order",
      description:
        "Strong delivery evidence available — this order is a good candidate for the standard automation path.",
      tone: "good",
    });
  }

  // 2. confirm_by_phone — surface when network OR external evidence
  //    is in the cautious band AND the order hasn't yet been
  //    confirmed.
  const flaggedCaution =
    networkLabel === "caution" || ext?.elevated_return_pattern === true;
  if (flaggedCaution && unconfirmed) {
    out.push({
      key: "confirm_by_phone",
      label: "Verify by phone",
      description:
        "Some history suggests an elevated return pattern. A quick verification call before booking lowers wasted-shipment risk.",
      tone: "watch",
    });
  }

  // 3. consider_partial_advance — only when COD is genuinely large
  //    AND we have caution signals AND not yet confirmed. Conservative
  //    to avoid false-positive friction on low-value orders.
  if (flaggedCaution && unconfirmed && cod >= extremeCod) {
    out.push({
      key: "consider_partial_advance",
      label: "Consider partial advance",
      description:
        "For high-value COD with cautious history, a partial advance can de-risk the shipment. Optional — merchant judgement applies.",
      tone: "watch",
    });
  }

  // 4. monitor_retry_outcomes — surface only when a delivery has
  //    already failed and the order is back in flight.
  if (
    hint === "delivery_failed_attempt" ||
    hint === "stuck_in_transit" ||
    hint === "stuck_pending_pickup"
  ) {
    out.push({
      key: "monitor_retry_outcomes",
      label: "Monitor retry attempts",
      description:
        "Delivery encountered an issue. Watch the next attempt — second attempts often succeed; intervene only if it stalls again.",
      tone: "muted",
    });
  }

  // 5. use_strong_courier_lane — surface when the reliability tier
  //    suggests the buyer side is fine but courier-lane evidence is
  //    weak (operationalHint or reliability classifier hint).
  if (reliabilityTier === "implicit" && !flaggedCaution && unconfirmed) {
    out.push({
      key: "use_strong_courier_lane",
      label: "Pick the strongest courier lane",
      description:
        "Mixed signals overall. Routing through the courier with the strongest local history reduces uncertainty.",
      tone: "muted",
    });
  }

  // 6. address_clarification — only when the operational-hint
  //    classifier already flagged it. We don't re-derive the
  //    address-quality call here; we trust the upstream hint.
  if (hint === "address_clarification_needed") {
    out.push({
      key: "address_clarification",
      label: "Confirm the delivery address",
      description:
        "Address looks incomplete. A quick check with the buyer for a landmark or road number reduces failed-attempt risk.",
      tone: "watch",
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Internal exports                                                           */
/* -------------------------------------------------------------------------- */

export const __INTERNAL = {
  isUnconfirmed,
  DEFAULT_EXTREME_COD_BDT,
};
