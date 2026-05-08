/**
 * outcomeMetrics — pure outcome math, decoupled from any specific bucket
 * shape so future result types (per-merchant cohort, per-courier cohort,
 * per-thana cohort) can reuse the same formulas without round-tripping
 * through OutcomeBucket.
 *
 * Single source of truth for:
 *   - which order statuses count as "resolved" (in the rate denominator)
 *   - how `deliveredRate` is computed
 *   - how `rtoRate` is computed
 *
 * FUTURE EXTENSION POINTS — when these statuses ship, add them to
 * `RESOLVED_STATUSES` and to `OutcomeCounts` as optional fields:
 *   - partial_rto       (multi-item return where some delivered)
 *   - exchange          (delivered + exchanged for different SKU)
 *   - refund            (delivered, money returned)
 *   - failed_delivery   (rider attempt failed but recoverable — different
 *                        signal class from "rto" which is terminal)
 *
 * The arithmetic stays the same — `computeResolvedTotal` reads whichever
 * fields are present on `OutcomeCounts`. Callers that don't yet observe
 * the new statuses see a zero contribution; callers that do flow them
 * through automatically pick up the new mass in the denominator.
 *
 * Pure functions. No DB. No clock. Deterministic.
 */

/** Order statuses we treat as "outcome resolved" — included in rate
 *  denominators. Updating this list is the single change required to
 *  introduce a new resolved class (see file-level comment). */
export const RESOLVED_STATUSES = ["delivered", "rto", "cancelled"] as const;
export type ResolvedStatus = (typeof RESOLVED_STATUSES)[number];

/**
 * Minimal structural shape required to compute outcome rates. Decoupled
 * from `OutcomeBucket` so handlers / future cohort types can call the
 * helpers without manufacturing a bucket object. Optional fields are
 * reserved for future statuses; absence is treated as zero by every
 * helper below.
 */
export interface OutcomeCounts {
  delivered: number;
  rto: number;
  cancelled: number;
  // Reserved for future statuses — see file-level comment.
  // partial_rto?: number;
  // exchange?: number;
  // refund?: number;
  // failed_delivery?: number;
}

/**
 * Sum of every resolved-class field on `OutcomeCounts`. The current
 * implementation lists each field explicitly so a reader can see at a
 * glance what counts. When new statuses ship, append the same way.
 */
export function computeResolvedTotal(c: OutcomeCounts): number {
  return c.delivered + c.rto + c.cancelled;
}

/** delivered / resolved when resolved > 0; null otherwise. */
export function computeDeliveredRate(c: OutcomeCounts): number | null {
  const r = computeResolvedTotal(c);
  return r > 0 ? c.delivered / r : null;
}

/** rto / resolved when resolved > 0; null otherwise. */
export function computeRtoRate(c: OutcomeCounts): number | null {
  const r = computeResolvedTotal(c);
  return r > 0 ? c.rto / r : null;
}
