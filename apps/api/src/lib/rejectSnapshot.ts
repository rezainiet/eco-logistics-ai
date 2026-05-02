/**
 * Shared helpers for the three reject paths (fraud.markRejected,
 * orders.rejectOrder, orders.bulkRejectOrders) so each writes the
 * same `preReject*` snapshot fields and `restoreOrder` can round-trip
 * them faithfully.
 *
 * Anything that flips an order to `cancelled` because the merchant
 * (or an agent acting on the merchant's behalf) said so MUST go
 * through these helpers. System-driven cancels (sweeper auto-expire,
 * etc) write a different snapshot — see automationStale.
 */

import type { OrderAutomation } from "@ecom/db";

/**
 * Consolidated pre-action snapshot. Holds everything `restoreOrder`
 * needs to round-trip an order across order / automation / fraud
 * without losing the merchant's prior configuration.
 *
 * The shape is intentionally flat — top-level keys per concern — so
 * a single aggregation-pipeline `$mergeObjects` can splat the right
 * subset back into each subdoc on restore.
 */
export interface PreActionSnapshot {
  /** Snapshotted at reject time. */
  takenAt: Date;
  /** ISO-style action label so we can route restore semantics if we
   *  ever add reject vs cancel etc. Today: "reject". */
  action: "reject";
  order: {
    status: string;
  };
  automation: {
    state: string;
    /** Subset of automation fields that should round-trip on restore.
     *  Excludes meta fields (decidedBy/decidedAt/reason/rejectedAt/
     *  rejectionReason) and the snapshot field itself. */
    subdoc: Record<string, unknown>;
  };
  fraud: {
    reviewStatus: string | null;
    level: string | null;
  };
}

/** Strip meta + recursive-snapshot fields from an automation subdoc. */
export function buildPreRejectAutomationSnapshot(
  automation: OrderAutomation | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!automation) return {};
  const src = automation as Record<string, unknown>;
  const {
    decidedBy: _decidedBy,
    decidedAt: _decidedAt,
    reason: _reason,
    rejectedAt: _rejectedAt,
    rejectionReason: _rejectionReason,
    preRejectState: _preRejectState,
    ...rest
  } = src;
  return rest;
}

/** Compose the full pre-action snapshot from the order's pre-write fields. */
export function buildPreActionSnapshot(input: {
  orderStatus: string;
  automation: OrderAutomation | Record<string, unknown> | null | undefined;
  fraud: { reviewStatus?: string; level?: string } | null | undefined;
}): PreActionSnapshot {
  return {
    takenAt: new Date(),
    action: "reject",
    order: { status: input.orderStatus },
    automation: {
      state: (input.automation as { state?: string } | null | undefined)?.state ?? "not_evaluated",
      subdoc: buildPreRejectAutomationSnapshot(input.automation),
    },
    fraud: {
      reviewStatus: input.fraud?.reviewStatus ?? null,
      level: input.fraud?.level ?? null,
    },
  };
}

/**
 * Legacy compat — the prior reject paths used these two values
 * directly. Kept exported so callers that needed only the fraud bits
 * (e.g. partial reads) still work, and so the helper function names
 * map cleanly onto what the spec asks for.
 */
export interface FraudRejectSnapshot {
  preRejectReviewStatus: string | null;
  preRejectLevel: string | null;
}

export function buildFraudRejectSnapshot(
  fraud: { reviewStatus?: string; level?: string } | null | undefined,
): FraudRejectSnapshot {
  return {
    preRejectReviewStatus: fraud?.reviewStatus ?? null,
    preRejectLevel: fraud?.level ?? null,
  };
}
