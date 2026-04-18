import { Types } from "mongoose";
import { CallLog, MerchantStats, Order } from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";
import { cached } from "../../lib/cache.js";

const DASHBOARD_TTL = 120;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function merchantObjectId(ctx: { user: { id: string } }): Types.ObjectId {
  return new Types.ObjectId(ctx.user.id);
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

  getRTOMetrics: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
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
});
