/**
 * Order verification — shared rules for the review gate.
 *
 * The verification state lives on `Order.fraud.reviewStatus` (no separate
 * system): risk scoring proposes a state at ingest, agents/merchants decide
 * in the review queue (`fraud.*` router), and booking refuses anything that
 * is still awaiting a decision or was rejected.
 *
 *   not_required     low risk                → bookable
 *   optional_review  medium risk ("watch")   → bookable; can be sent to verification
 *   pending_call     awaiting verification   → NOT bookable
 *   no_answer        call attempted, no reply→ NOT bookable
 *   verified         verified by a person    → bookable (final)
 *   rejected         rejected (order cancelled) → NOT bookable (final; restorable)
 */

import type { ReviewStatus } from "../server/risk.js";

/** Review states that block courier dispatch. */
export const BOOKING_BLOCKED_REVIEW: readonly ReviewStatus[] = ["pending_call", "no_answer", "rejected"];

/** Review states a person has decided — scoring never changes them. */
export const FINAL_REVIEW: readonly ReviewStatus[] = ["verified", "rejected"];

/** Review states awaiting a person's decision. */
export const AWAITING_REVIEW: readonly ReviewStatus[] = ["pending_call", "no_answer"];

/**
 * Structured reasons for a verification decision. Optional on every
 * action (free-text notes still work); recorded on the order and in the
 * audit trail so decisions can be counted, not just read.
 */
export const VERIFY_REASON_CODES = ["confirmed_by_call", "confirmed_by_sms", "known_customer", "other"] as const;
export const REJECT_REASON_CODES = [
  "fake_order",
  "customer_cancelled",
  "unreachable",
  "duplicate_order",
  "wrong_address",
  "blocklisted",
  "other",
] as const;
export const NO_ANSWER_REASON_CODES = ["no_pickup", "phone_off", "wrong_number", "other"] as const;
export const REQUEST_REASON_CODES = ["high_value", "new_customer", "suspicious_details", "customer_request", "other"] as const;

export type ReviewReasonCode =
  | (typeof VERIFY_REASON_CODES)[number]
  | (typeof REJECT_REASON_CODES)[number]
  | (typeof NO_ANSWER_REASON_CODES)[number]
  | (typeof REQUEST_REASON_CODES)[number];

/**
 * What a rescore may write to `fraud.reviewStatus`:
 *   - a person's decision (verified / rejected) is never changed;
 *   - an order a merchant explicitly sent to verification stays awaiting
 *     review (pending_call / no_answer) until a person decides — a lower
 *     score must not quietly make it bookable again;
 *   - everything else follows the new score.
 */
export function reviewStatusAfterRescore(
  current: ReviewStatus,
  computed: ReviewStatus,
  manualReview: boolean,
): ReviewStatus {
  if (FINAL_REVIEW.includes(current)) return current;
  if (manualReview && AWAITING_REVIEW.includes(current)) return current;
  return computed;
}
