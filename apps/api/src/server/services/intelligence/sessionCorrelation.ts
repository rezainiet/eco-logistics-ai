/**
 * sessionCorrelation — order-to-session join logic for analytics handlers
 * that need TrackingSession attribution alongside Order outcomes.
 *
 * Two-stage strategy: load merchant-scoped, time-bounded orders FIRST,
 * then load only the TrackingSession rows whose `resolvedOrderId` lives
 * in that order set. We deliberately AVOID an in-Mongo `$lookup` because:
 *
 *   1. `$lookup` materialises the joined document on the right side per
 *      left-side row — at 5–10k orders × N sessions per order this gets
 *      expensive on a single primary shard.
 *
 *   2. The aggregation server-side cursor doesn't honour our partial-
 *      filter index on `(merchantId, resolvedOrderId)` as cleanly as a
 *      direct `find({merchantId, resolvedOrderId: {$in: [...]}})` does.
 *      The two-stage form lets the planner pick the narrowest path on
 *      both sides explicitly.
 *
 *   3. Streaming the join through application memory makes the
 *      attribution rule (which campaign wins when there are multiple
 *      sessions) testable in isolation — see the handler tests in
 *      `tests/intelligence-analytics.test.ts`.
 *
 * SCALING CAVEATS
 * ===============
 * The current load is bounded:
 *   - Order side scans up to `days * dailyOrderRate` documents — at
 *     90-day cap × 1k orders/day = 90k worst-case per merchant.
 *   - Session side scans up to `90k orders × ~1.5 sessions/order` =
 *     ~135k sessions per merchant.
 *
 * That stays comfortable on Mongo's working set. PAST ~10k merchants AT
 * 1k orders/day each, the global aggregate footprint is what to watch —
 * but this helper is per-merchant by construction so it never sees
 * cross-tenant volume.
 *
 * FUTURE BATCHING CONSIDERATIONS
 * ==============================
 * If a single merchant ever exceeds the in-memory comfort zone (rare —
 * design partner workload tops at ~5k orders / 30 days today):
 *   - chunk the `$in: orderIds` query into batches of ~5000 ids and
 *     concatenate the maps.
 *   - cache the resulting maps for a short TTL (60s) keyed by
 *     `(merchantId, days)` so consecutive dashboard loads don't repay.
 *   - move to a streaming Mongo cursor pattern for the order side.
 *
 * None of this is needed at v1 scale; comments are here so the next
 * engineer hits the right answer fast.
 *
 * INDEX ASSUMPTIONS
 * =================
 *   - Order: primary listing index `(merchantId, order.status,
 *     createdAt:-1)` covers the merchant + window match.
 *   - TrackingSession: partial-filter index on `(merchantId,
 *     resolvedOrderId)` keeps the second hop narrow. Added in
 *     Milestone 1's schema work.
 *
 * MERCHANT SCOPING
 * ================
 * Every read clauses `merchantId` first — there is no path through this
 * helper that returns rows for a different merchant.
 */

import { Types } from "mongoose";
import { Order, TrackingSession } from "@ecom/db";

/**
 * Subset of TrackingSession fields the intelligence handlers actually
 * read. Keeping it explicit prevents accidental over-fetching when the
 * model gains new behavioral fields.
 */
export interface ResolvedSessionAttribution {
  repeatVisitor?: boolean;
  campaign?: { source?: string | null; medium?: string | null };
}

export interface OrdersAndSessions {
  /** orderId hex → terminal/in-flight status from Order.order.status. */
  orderStatusById: Map<string, string>;
  /** orderId hex → array of attribution-relevant session subsets. */
  sessionsByOrderId: Map<string, ResolvedSessionAttribution[]>;
}

/**
 * Pull (id → status) for orders in the merchant's window, then pull
 * sessions resolving to those orders.
 *
 * Both queries are merchant-scoped and bounded. Returns the
 * `orderStatusById` map even when no sessions exist so callers can
 * branch on "no_session" cohort accounting.
 */
export async function fetchOrdersAndSessions(
  merchantId: Types.ObjectId,
  cutoff: Date,
): Promise<OrdersAndSessions> {
  const orders = await Order.find({
    merchantId,
    createdAt: { $gte: cutoff },
  })
    .select("_id order.status")
    .lean();

  const orderStatusById = new Map<string, string>();
  const orderIds: Types.ObjectId[] = [];
  for (const o of orders) {
    orderStatusById.set(String(o._id), o.order?.status ?? "pending");
    orderIds.push(o._id as Types.ObjectId);
  }

  const sessionsByOrderId = new Map<string, ResolvedSessionAttribution[]>();
  if (orderIds.length === 0) {
    return { orderStatusById, sessionsByOrderId };
  }

  const sessions = await TrackingSession.find({
    merchantId,
    resolvedOrderId: { $in: orderIds },
  })
    .select("resolvedOrderId repeatVisitor campaign")
    .lean();

  for (const s of sessions) {
    const key = String(s.resolvedOrderId);
    const arr = sessionsByOrderId.get(key) ?? [];
    arr.push({
      repeatVisitor: s.repeatVisitor,
      campaign: s.campaign as
        | { source?: string | null; medium?: string | null }
        | undefined,
    });
    sessionsByOrderId.set(key, arr);
  }
  return { orderStatusById, sessionsByOrderId };
}
