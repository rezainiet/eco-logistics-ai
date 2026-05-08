/**
 * intelligenceHandlers — procedure implementations for every RTO
 * Intelligence v1 dashboard / correlation card.
 *
 * Each handler:
 *   - Accepts `{ ctx, input }` matching the tRPC `protectedProcedure`
 *     resolver signature (typed via `ProtectedHandlerCtx`).
 *   - Reads from Order (and optionally TrackingSession via
 *     `fetchOrdersAndSessions`).
 *   - Never writes.
 *   - Is merchant-scoped via `merchantObjectId(ctx)`.
 *   - Bounds the window via `cutoffFromDays(input.days)`.
 *   - Relies on indexes added in Milestone 1 (see model file comments).
 *
 * Behaviour-equivalent to the inline handlers that previously lived at
 * the bottom of `apps/api/src/server/routers/analytics.ts`. Bodies are
 * identical; only the imports + helper-function call sites changed.
 */

import { Order } from "@ecom/db";
import { merchantObjectId } from "../../trpc.js";

import {
  addToBucket,
  addToBucketWithCount,
  emptyBucket,
  finaliseBucket,
  type OutcomeBucket,
} from "./intelligenceBuckets.js";
import { categoriseCampaign } from "./campaignClassification.js";
import { fetchOrdersAndSessions } from "./sessionCorrelation.js";

import type {
  AddressQualityResult,
  CampaignBucketKey,
  CampaignSourceResult,
  IntentDistributionResult,
  ProtectedHandlerCtx,
  RepeatVisitorKind,
  RepeatVisitorResult,
  TopThanasResult,
} from "./intelligenceTypes.js";

/* -------------------------------------------------------------------------- */
/* Local helpers                                                              */
/* -------------------------------------------------------------------------- */

function cutoffFromDays(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/* -------------------------------------------------------------------------- */
/* Card 1 — Intent Tier Distribution                                          */
/* -------------------------------------------------------------------------- */

/**
 * Single-collection Order aggregate. Index used:
 *   `(merchantId, intent.tier, createdAt:-1)` — partial on
 *   `intent.tier:string`.
 *
 * The partial-filter clause `"intent.tier": { $type: "string" }` matches
 * the index's partialFilterExpression so the planner stays on the narrow
 * path instead of falling back to the full primary index.
 */
export async function intentDistributionHandler({
  ctx,
  input,
}: {
  ctx: ProtectedHandlerCtx;
  input: { days: number };
}): Promise<IntentDistributionResult> {
  const merchantId = merchantObjectId(ctx);
  const cutoff = cutoffFromDays(input.days);

  const rows = await Order.aggregate<{
    _id: { tier: string; status: string };
    count: number;
  }>([
    {
      $match: {
        merchantId,
        createdAt: { $gte: cutoff },
        "intent.tier": { $type: "string" },
      },
    },
    {
      $group: {
        _id: { tier: "$intent.tier", status: "$order.status" },
        count: { $sum: 1 },
      },
    },
  ]);

  const buckets: Record<string, OutcomeBucket> = {
    verified: emptyBucket(),
    implicit: emptyBucket(),
    unverified: emptyBucket(),
    no_data: emptyBucket(),
  };
  let totalOrders = 0;
  for (const r of rows) {
    const b = buckets[r._id.tier];
    if (!b) continue; // unknown tier — defensive against schema drift
    addToBucketWithCount(b, r._id.status, r.count);
    totalOrders += r.count;
  }
  return {
    windowDays: input.days,
    totalOrders,
    buckets: (["verified", "implicit", "unverified", "no_data"] as const).map(
      (tier) => ({ tier, ...finaliseBucket(buckets[tier]!) }),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Card 2 — Address Quality Distribution                                      */
/* -------------------------------------------------------------------------- */

/**
 * Single-collection Order aggregate. Index used:
 *   `(merchantId, address.quality.completeness, createdAt:-1)` — partial.
 */
export async function addressQualityDistributionHandler({
  ctx,
  input,
}: {
  ctx: ProtectedHandlerCtx;
  input: { days: number };
}): Promise<AddressQualityResult> {
  const merchantId = merchantObjectId(ctx);
  const cutoff = cutoffFromDays(input.days);

  const rows = await Order.aggregate<{
    _id: { completeness: string; status: string };
    count: number;
  }>([
    {
      $match: {
        merchantId,
        createdAt: { $gte: cutoff },
        "address.quality.completeness": { $type: "string" },
      },
    },
    {
      $group: {
        _id: {
          completeness: "$address.quality.completeness",
          status: "$order.status",
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const buckets: Record<string, OutcomeBucket> = {
    complete: emptyBucket(),
    partial: emptyBucket(),
    incomplete: emptyBucket(),
  };
  let totalOrders = 0;
  for (const r of rows) {
    const b = buckets[r._id.completeness];
    if (!b) continue;
    addToBucketWithCount(b, r._id.status, r.count);
    totalOrders += r.count;
  }
  return {
    windowDays: input.days,
    totalOrders,
    buckets: (["complete", "partial", "incomplete"] as const).map(
      (completeness) => ({
        completeness,
        ...finaliseBucket(buckets[completeness]!),
      }),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Card 3 — Top Thanas by volume + outcome breakdown                          */
/* -------------------------------------------------------------------------- */

/**
 * Single-collection Order aggregate. Index used:
 *   `(merchantId, customer.thana, createdAt:-1)` — partial on
 *   `customer.thana:string`.
 *
 * Returns the top N thanas by total order count, each with full outcome
 * breakdown so the dashboard can sort by delivered % / RTO % / pending %
 * client-side without a second roundtrip.
 */
export async function topThanasHandler({
  ctx,
  input,
}: {
  ctx: ProtectedHandlerCtx;
  input: { days: number; limit: number };
}): Promise<TopThanasResult> {
  const merchantId = merchantObjectId(ctx);
  const cutoff = cutoffFromDays(input.days);

  const rows = await Order.aggregate<{
    _id: string;
    total: number;
    delivered: number;
    rto: number;
    cancelled: number;
    pending: number;
    confirmed: number;
    packed: number;
    shipped: number;
    in_transit: number;
  }>([
    {
      $match: {
        merchantId,
        createdAt: { $gte: cutoff },
        "customer.thana": { $type: "string" },
      },
    },
    {
      $group: {
        _id: "$customer.thana",
        total: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: ["$order.status", "delivered"] }, 1, 0] } },
        rto: { $sum: { $cond: [{ $eq: ["$order.status", "rto"] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ["$order.status", "cancelled"] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ["$order.status", "pending"] }, 1, 0] } },
        confirmed: { $sum: { $cond: [{ $eq: ["$order.status", "confirmed"] }, 1, 0] } },
        packed: { $sum: { $cond: [{ $eq: ["$order.status", "packed"] }, 1, 0] } },
        shipped: { $sum: { $cond: [{ $eq: ["$order.status", "shipped"] }, 1, 0] } },
        in_transit: { $sum: { $cond: [{ $eq: ["$order.status", "in_transit"] }, 1, 0] } },
      },
    },
    { $sort: { total: -1 } },
    { $limit: input.limit },
  ]);

  return {
    windowDays: input.days,
    thanas: rows.map((r) => {
      const inFlight =
        r.pending + r.confirmed + r.packed + r.shipped + r.in_transit;
      const resolved = r.delivered + r.rto + r.cancelled;
      return {
        thana: r._id,
        total: r.total,
        delivered: r.delivered,
        rto: r.rto,
        cancelled: r.cancelled,
        inFlight,
        resolved,
        deliveredRate: resolved > 0 ? r.delivered / resolved : null,
        rtoRate: resolved > 0 ? r.rto / resolved : null,
        pendingRate: r.total > 0 ? inFlight / r.total : 0,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Card 4 — Campaign Source Outcomes                                          */
/* -------------------------------------------------------------------------- */

/**
 * Two-stage join via `fetchOrdersAndSessions` (avoids `$lookup`) — see
 * that helper's file-level comment for index assumptions and scaling
 * caveats.
 *
 * Buckets: organic / paid_social / direct / unknown.
 * `no_session` is also counted as a 5th bucket so merchants can see how
 * much of their volume isn't reachable for attribution.
 *
 * Multi-session orders are attributed to the FIRST session whose
 * campaign carries any source/medium — matches `lib/intent.ts:aggregate`
 * "first non-null wins" rule.
 */
export async function campaignSourceOutcomesHandler({
  ctx,
  input,
}: {
  ctx: ProtectedHandlerCtx;
  input: { days: number };
}): Promise<CampaignSourceResult> {
  const merchantId = merchantObjectId(ctx);
  const cutoff = cutoffFromDays(input.days);
  const { orderStatusById, sessionsByOrderId } = await fetchOrdersAndSessions(
    merchantId,
    cutoff,
  );

  const buckets: Record<CampaignBucketKey, OutcomeBucket> = {
    organic: emptyBucket(),
    paid_social: emptyBucket(),
    direct: emptyBucket(),
    unknown: emptyBucket(),
    no_session: emptyBucket(),
  };
  let totalOrders = 0;
  for (const [orderId, status] of orderStatusById) {
    const sessions = sessionsByOrderId.get(orderId);
    let category: CampaignBucketKey;
    if (!sessions || sessions.length === 0) {
      category = "no_session";
    } else {
      let firstAttributed: typeof sessions[number] | null = null;
      for (const s of sessions) {
        if (s.campaign?.source || s.campaign?.medium) {
          firstAttributed = s;
          break;
        }
      }
      category = categoriseCampaign(firstAttributed?.campaign);
    }
    addToBucket(buckets[category], status);
    totalOrders += 1;
  }

  return {
    windowDays: input.days,
    totalOrders,
    buckets: (
      ["organic", "paid_social", "direct", "unknown", "no_session"] as const
    ).map((source) => ({ source, ...finaliseBucket(buckets[source]) })),
  };
}

/* -------------------------------------------------------------------------- */
/* Card 5 — Repeat Visitor vs Outcomes                                        */
/* -------------------------------------------------------------------------- */

/**
 * Two-stage join (same shape as campaign-source). Buckets:
 *   - repeat: at least one resolved session was repeatVisitor=true
 *   - first_time: at least one resolved session was repeatVisitor=false
 *   - no_session: no session matched (CSV / dashboard / no SDK)
 *
 * Surfaces the hypothesis "repeat visitors RTO at half the rate of
 * first-timers." Observation-only — never feeds a decision in v1.
 */
export async function repeatVisitorOutcomesHandler({
  ctx,
  input,
}: {
  ctx: ProtectedHandlerCtx;
  input: { days: number };
}): Promise<RepeatVisitorResult> {
  const merchantId = merchantObjectId(ctx);
  const cutoff = cutoffFromDays(input.days);
  const { orderStatusById, sessionsByOrderId } = await fetchOrdersAndSessions(
    merchantId,
    cutoff,
  );

  const buckets: Record<RepeatVisitorKind, OutcomeBucket> = {
    repeat: emptyBucket(),
    first_time: emptyBucket(),
    no_session: emptyBucket(),
  };
  let totalOrders = 0;
  for (const [orderId, status] of orderStatusById) {
    const sessions = sessionsByOrderId.get(orderId);
    let bucket: RepeatVisitorKind;
    if (!sessions || sessions.length === 0) bucket = "no_session";
    else if (sessions.some((s) => s.repeatVisitor === true)) bucket = "repeat";
    else bucket = "first_time";
    addToBucket(buckets[bucket], status);
    totalOrders += 1;
  }

  return {
    windowDays: input.days,
    totalOrders,
    buckets: (["repeat", "first_time", "no_session"] as const).map(
      (kind) => ({ kind, ...finaliseBucket(buckets[kind]) }),
    ),
  };
}
