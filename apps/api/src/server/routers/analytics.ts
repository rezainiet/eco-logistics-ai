import { Types } from "mongoose";
import { TRPCError } from "@trpc/server";
import { CallLog, Merchant, MerchantStats, Order } from "@ecom/db";
import { merchantObjectId, protectedProcedure, router } from "../trpc.js";
import { cached } from "../../lib/cache.js";
import { getPlan, type AnalyticsLevel } from "../../lib/plans.js";

/* -------------------------------------------------------------------------- *
 * RTO Intelligence v1 — every handler + schema + helper lives in
 * `apps/api/src/server/services/intelligence/`. The router below stays
 * declarative: each procedure pins a schema and a handler that the
 * service layer owns. New intelligence cards land in that directory and
 * register here as one-line additions.
 * -------------------------------------------------------------------------- */
import {
  intelligenceDaysInput,
  intelligenceTopThanasInput,
} from "../services/intelligence/intelligenceSchemas.js";
import {
  addressQualityDistributionHandler,
  campaignSourceOutcomesHandler,
  intentDistributionHandler,
  repeatVisitorOutcomesHandler,
  topThanasHandler,
} from "../services/intelligence/intelligenceHandlers.js";

const DASHBOARD_TTL = 120;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

const ANALYTICS_RANK: Record<AnalyticsLevel, number> = {
  basic: 0,
  advanced: 1,
  premium: 2,
};

async function requireAnalyticsLevel(
  merchantId: Types.ObjectId,
  role: "merchant" | "admin" | "agent",
  required: AnalyticsLevel,
): Promise<void> {
  if (role === "admin") return;
  const m = await Merchant.findById(merchantId).select("subscription.tier").lean();
  const plan = getPlan(m?.subscription?.tier);
  if (ANALYTICS_RANK[plan.features.analyticsLevel] < ANALYTICS_RANK[required]) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${required} analytics requires a higher plan — currently on ${plan.name}`,
    });
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export const analyticsRouter = router({
  getDashboard: protectedProcedure.query(async ({ ctx }) => {
    return cached(`dashboard:${ctx.user.id}`, DASHBOARD_TTL, async () => {
      const merchantId = merchantObjectId(ctx);
      const today = startOfToday();

      const [stats, todayAgg] = await Promise.all([
        MerchantStats.findOne({ merchantId }).lean(),
        Order.aggregate<{
          ordersToday: number;
          deliveredToday: number;
          revenueToday: number;
        }>([
          { $match: { merchantId, createdAt: { $gte: today } } },
          {
            $group: {
              _id: null,
              ordersToday: { $sum: 1 },
              deliveredToday: {
                $sum: { $cond: [{ $eq: ["$order.status", "delivered"] }, 1, 0] },
              },
              revenueToday: {
                $sum: {
                  $cond: [{ $eq: ["$order.status", "delivered"] }, "$order.cod", 0],
                },
              },
            },
          },
        ]),
      ]);

      const s = stats ?? { totalOrders: 0, delivered: 0, pending: 0, rto: 0 };
      const t = todayAgg[0] ?? { ordersToday: 0, deliveredToday: 0, revenueToday: 0 };

      return {
        totalOrders: s.totalOrders,
        delivered: s.delivered,
        pending: s.pending,
        rto: s.rto,
        rtoRate: s.totalOrders > 0 ? s.rto / s.totalOrders : 0,
        ordersToday: t.ordersToday,
        deliveredToday: t.deliveredToday,
        revenueToday: t.revenueToday,
        cachedAt: new Date().toISOString(),
      };
    });
  }),

  getBestTimeToCall: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    await requireAnalyticsLevel(merchantId, ctx.user.role, "advanced");
    const since = new Date(Date.now() - NINETY_DAYS_MS);

    const rows = await CallLog.aggregate<{
      _id: number;
      total: number;
      answered: number;
      successful: number;
    }>([
      { $match: { merchantId, timestamp: { $gte: since } } },
      {
        $group: {
          _id: "$hour",
          total: { $sum: 1 },
          answered: { $sum: { $cond: ["$answered", 1, 0] } },
          successful: { $sum: { $cond: [{ $eq: ["$outcome.successful", true] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const heatmap = Array.from({ length: 24 }, (_, hour) => {
      const r = rows.find((row) => row._id === hour);
      const total = r?.total ?? 0;
      const answerRate = total > 0 ? r!.answered / total : 0;
      const successRate = total > 0 ? r!.successful / total : 0;
      const score = answerRate * 0.4 + successRate * 0.6;
      return { hour, total, answerRate, successRate, score };
    });

    const best = [...heatmap]
      .filter((h) => h.total > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return { heatmap, bestHours: best.map((h) => h.hour) };
  }),

  getOrdersLast7Days: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);

    const rows = await Order.aggregate<{
      _id: string;
      total: number;
      delivered: number;
      rto: number;
    }>([
      { $match: { merchantId, createdAt: { $gte: start } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ["$order.status", "delivered"] }, 1, 0] } },
          rto: { $sum: { $cond: [{ $eq: ["$order.status", "rto"] }, 1, 0] } },
        },
      },
    ]);

    const byDay = new Map(rows.map((r) => [r._id, r]));
    const days: Array<{ date: string; total: number; delivered: number; rto: number }> = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const hit = byDay.get(key);
      days.push({
        date: key,
        total: hit?.total ?? 0,
        delivered: hit?.delivered ?? 0,
        rto: hit?.rto ?? 0,
      });
    }
    return days;
  }),

  getCourierPerformance: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const since = new Date(Date.now() - NINETY_DAYS_MS);

    type Row = {
      _id: string | null;
      shipments: number;
      delivered: number;
      rto: number;
      inTransit: number;
      pending: number;
      codSum: number;
      revenueDelivered: number;
      avgTransitDays: number | null;
    };

    const rows = await Order.aggregate<Row>([
      {
        $match: {
          merchantId,
          createdAt: { $gte: since },
          "logistics.courier": { $exists: true, $ne: null, $nin: ["", null] },
        },
      },
      {
        $group: {
          _id: "$logistics.courier",
          shipments: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $eq: ["$order.status", "delivered"] }, 1, 0] },
          },
          rto: { $sum: { $cond: [{ $eq: ["$order.status", "rto"] }, 1, 0] } },
          inTransit: {
            $sum: {
              $cond: [
                { $in: ["$order.status", ["shipped", "in_transit"]] },
                1,
                0,
              ],
            },
          },
          pending: {
            $sum: {
              $cond: [
                { $in: ["$order.status", ["pending", "confirmed", "packed"]] },
                1,
                0,
              ],
            },
          },
          codSum: { $sum: "$order.cod" },
          revenueDelivered: {
            $sum: {
              $cond: [{ $eq: ["$order.status", "delivered"] }, "$order.cod", 0],
            },
          },
          avgTransitDays: {
            $avg: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$order.status", "delivered"] },
                    { $ne: ["$logistics.deliveredAt", null] },
                  ],
                },
                {
                  $divide: [
                    { $subtract: ["$logistics.deliveredAt", "$createdAt"] },
                    1000 * 60 * 60 * 24,
                  ],
                },
                null,
              ],
            },
          },
        },
      },
      { $sort: { shipments: -1 } },
    ]);

    return rows.map((r) => {
      const courier = r._id ?? "unknown";
      const shipments = r.shipments;
      const finished = r.delivered + r.rto;
      return {
        courier,
        shipments,
        delivered: r.delivered,
        rto: r.rto,
        inTransit: r.inTransit,
        pending: r.pending,
        deliveryRate: finished > 0 ? r.delivered / finished : 0,
        rtoRate: finished > 0 ? r.rto / finished : 0,
        avgCod: shipments > 0 ? r.codSum / shipments : 0,
        revenueDelivered: r.revenueDelivered,
        avgTransitDays:
          typeof r.avgTransitDays === "number" && Number.isFinite(r.avgTransitDays)
            ? r.avgTransitDays
            : null,
      };
    });
  }),

  getRTOMetrics: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    await requireAnalyticsLevel(merchantId, ctx.user.role, "advanced");
    const since = new Date(Date.now() - NINETY_DAYS_MS);

    const [stats, byDistrict, byCourier] = await Promise.all([
      MerchantStats.findOne({ merchantId }).lean(),
      Order.aggregate<{ _id: string; count: number }>([
        { $match: { merchantId, "order.status": "rto", createdAt: { $gte: since } } },
        { $group: { _id: "$customer.district", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 25 },
      ]),
      Order.aggregate<{ _id: string | null; count: number }>([
        { $match: { merchantId, "order.status": "rto", createdAt: { $gte: since } } },
        { $group: { _id: "$logistics.courier", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const total = stats?.totalOrders ?? 0;
    const rto = stats?.rto ?? 0;
    return {
      totalOrders: total,
      rtoOrders: rto,
      rtoRate: total > 0 ? rto / total : 0,
      byDistrict: byDistrict.map((d) => ({ district: d._id, count: d.count })),
      byCourier: byCourier.map((c) => ({ courier: c._id ?? "unknown", count: c.count })),
    };
  }),

  /* ======================================================================
   * RTO Intelligence Dashboard v1 — observation + analytics layer.
   *
   * Five aggregation procedures that read from the additive subdocs landed
   * in Milestone 1 (Order.intent, Order.address.quality, customer.thana)
   * and the existing TrackingSession resolved-order linkage.
   *
   * SAFETY CONTRACT for every procedure below:
   *   - Read-only. No writes to any collection.
   *   - Merchant-scoped. Every $match starts with `merchantId` so a
   *     merchant cannot enumerate cross-tenant data.
   *   - Bounded windows. Every query carries `createdAt: { $gte: cutoff }`
   *     so even a misconfigured caller cannot collection-scan.
   *   - Index-aware. Each procedure documents the partial-filter index it
   *     was designed against (added in Milestone 1's schema migration).
   *   - Plan-gate-free in v1. All five are protectedProcedure — observation
   *     is universally available; deep correlations can be entitlement-
   *     gated later if needed.
   *   - Resolved-vs-inflight split. Rates are computed over RESOLVED orders
   *     (delivered + rto + cancelled) only. In-flight orders are counted
   *     but excluded from rate denominators — pending RTOs would inflate
   *     deliveredRate artificially.
   *
   * Helpers (`emptyBucket`, `addToBucket`, `finaliseBucket`,
   * `cutoffFromDays`, `fetchOrdersAndSessions`, `categoriseCampaign`) are
   * defined ABOVE the router declaration in this file — see the top of
   * `analyticsRouter`.
   * ====================================================================== */
  intentDistribution: protectedProcedure
    .input(intelligenceDaysInput)
    .query(intentDistributionHandler),

  addressQualityDistribution: protectedProcedure
    .input(intelligenceDaysInput)
    .query(addressQualityDistributionHandler),

  topThanas: protectedProcedure
    .input(intelligenceTopThanasInput)
    .query(topThanasHandler),

  campaignSourceOutcomes: protectedProcedure
    .input(intelligenceDaysInput)
    .query(campaignSourceOutcomesHandler),

  repeatVisitorOutcomes: protectedProcedure
    .input(intelligenceDaysInput)
    .query(repeatVisitorOutcomesHandler),
});

