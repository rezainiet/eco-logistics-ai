/**
 * intelligenceBuckets — single reusable source for outcome-aggregation
 * behavior across every RTO Intelligence handler.
 *
 * `OutcomeBucket` is the canonical row shape consumed by every dashboard
 * card. Constructing one starts with `emptyBucket()`, mutating goes
 * through `addToBucket` / `addToBucketWithCount`, and the rate fields are
 * filled by `finaliseBucket` once mutation stops.
 *
 * Rate math is delegated to `outcomeMetrics` — this module owns the
 * IN-FLIGHT vs resolved bookkeeping and the public bucket surface;
 * `outcomeMetrics` owns the formula. Splitting these two keeps the bucket
 * shape free to evolve (add fields like `noAnswered` per-tier) without
 * forcing every caller through the rate-formula module.
 */

import {
  computeDeliveredRate,
  computeResolvedTotal,
  computeRtoRate,
} from "./outcomeMetrics.js";

/**
 * Canonical outcome shape for every dashboard cohort row.
 *
 * `total` covers all orders in the bucket. `delivered` / `rto` /
 * `cancelled` are the resolved-class counts. `inFlight` is the catch-all
 * for non-resolved statuses (pending / confirmed / packed / shipped /
 * in_transit) — counted but excluded from rate denominators so a busy
 * pending pipeline doesn't make `deliveredRate` look pessimistic.
 *
 * Rate fields default to `null` and are populated by `finaliseBucket`.
 * `null` is the explicit "no resolved orders yet" signal — UI renders
 * this as "—" rather than "0%".
 */
export interface OutcomeBucket {
  total: number;
  delivered: number;
  rto: number;
  cancelled: number;
  inFlight: number;
  resolved: number;
  /** delivered / resolved when resolved > 0; null otherwise. */
  deliveredRate: number | null;
  /** rto / resolved when resolved > 0; null otherwise. */
  rtoRate: number | null;
}

export function emptyBucket(): OutcomeBucket {
  return {
    total: 0,
    delivered: 0,
    rto: 0,
    cancelled: 0,
    inFlight: 0,
    resolved: 0,
    deliveredRate: null,
    rtoRate: null,
  };
}

/** Add one order's status to a bucket. */
export function addToBucket(b: OutcomeBucket, status: string): void {
  b.total += 1;
  if (status === "delivered") b.delivered += 1;
  else if (status === "rto") b.rto += 1;
  else if (status === "cancelled") b.cancelled += 1;
  else b.inFlight += 1;
}

/**
 * Add a pre-aggregated (status, count) pair to a bucket. Used by the
 * single-collection aggregate handlers where Mongo returns
 * `(key, status, count)` triples and we don't want a second pass.
 */
export function addToBucketWithCount(
  b: OutcomeBucket,
  status: string,
  count: number,
): void {
  b.total += count;
  if (status === "delivered") b.delivered += count;
  else if (status === "rto") b.rto += count;
  else if (status === "cancelled") b.cancelled += count;
  else b.inFlight += count;
}

/**
 * Populate the rate fields. Idempotent — safe to call repeatedly. Run
 * exactly once per bucket after every `addToBucket` call has landed.
 *
 * Delegates to `outcomeMetrics` so the formulas stay in one place.
 */
export function finaliseBucket(b: OutcomeBucket): OutcomeBucket {
  b.resolved = computeResolvedTotal(b);
  b.deliveredRate = computeDeliveredRate(b);
  b.rtoRate = computeRtoRate(b);
  return b;
}
