import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { Merchant, TrackingEvent, TrackingSession } from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";
import { ensureTrackingKey } from "../tracking/collector.js";

function merchantObjectId(ctx: { user: { id: string } }): Types.ObjectId {
  return new Types.ObjectId(ctx.user.id);
}

function sinceFor(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export const trackingRouter = router({
  /** Returns the merchant's storefront tracking key + the SDK snippet to embed. */
  getInstallation: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const key = await ensureTrackingKey(merchantId);
    const collector = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/track/collect`;
    const sdkUrl = `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/sdk.js`;
    const snippet = `<script async src="${sdkUrl}" data-tracking-key="${key}" data-collector="${collector}"></script>`;
    return { key, collector, sdkUrl, snippet };
  }),

  /** High-level KPIs powering the behavior analytics page. */
  overview: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }).default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(input.days);
      const [agg] = await TrackingSession.aggregate<{
        sessions: number;
        repeatSessions: number;
        converted: number;
        abandoned: number;
        identified: number;
        avgDurationMs: number;
        pageViews: number;
        productViews: number;
      }>([
        { $match: { merchantId, lastSeenAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            sessions: { $sum: 1 },
            repeatSessions: { $sum: { $cond: ["$repeatVisitor", 1, 0] } },
            converted: { $sum: { $cond: ["$converted", 1, 0] } },
            abandoned: { $sum: { $cond: ["$abandonedCart", 1, 0] } },
            identified: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $ifNull: ["$phone", false] },
                      { $ifNull: ["$email", false] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            avgDurationMs: { $avg: "$durationMs" },
            pageViews: { $sum: "$pageViews" },
            productViews: { $sum: "$productViews" },
          },
        },
      ]);
      const result = agg ?? {
        sessions: 0,
        repeatSessions: 0,
        converted: 0,
        abandoned: 0,
        identified: 0,
        avgDurationMs: 0,
        pageViews: 0,
        productViews: 0,
      };
      const conversionRate = result.sessions > 0 ? result.converted / result.sessions : 0;
      const abandonRate =
        result.sessions > 0 ? result.abandoned / result.sessions : 0;
      const repeatRate =
        result.sessions > 0 ? result.repeatSessions / result.sessions : 0;
      return {
        ...result,
        conversionRate,
        abandonRate,
        repeatRate,
      };
    }),

  /** Event-funnel: page_view → product_view → add_to_cart → checkout_start → checkout_submit. */
  funnel: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }).default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(input.days);
      const rows = await TrackingEvent.aggregate<{ _id: string; sessions: number }>([
        { $match: { merchantId, occurredAt: { $gte: since } } },
        { $group: { _id: { type: "$type", session: "$sessionId" } } },
        { $group: { _id: "$_id.type", sessions: { $sum: 1 } } },
      ]);
      const map = new Map(rows.map((r) => [r._id, r.sessions]));
      const stages = [
        "page_view",
        "product_view",
        "add_to_cart",
        "checkout_start",
        "checkout_submit",
      ] as const;
      const top = map.get(stages[0]) ?? 0;
      return stages.map((stage) => ({
        stage,
        sessions: map.get(stage) ?? 0,
        rate: top === 0 ? 0 : (map.get(stage) ?? 0) / top,
      }));
    }),

  /** Top viewed products, ranked by distinct sessions. */
  topProducts: protectedProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(90).default(30), limit: z.number().int().min(1).max(50).default(10) })
        .default({ days: 30, limit: 10 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(input.days);
      const rows = await TrackingEvent.aggregate<{
        _id: string;
        sessions: number;
        views: number;
        addToCart: number;
        name: string;
      }>([
        { $match: { merchantId, type: "product_view", occurredAt: { $gte: since } } },
        {
          $group: {
            _id: {
              productId: { $ifNull: ["$properties.productId", "$properties.sku"] },
              sessionId: "$sessionId",
            },
            name: { $first: "$properties.name" },
          },
        },
        {
          $group: {
            _id: "$_id.productId",
            sessions: { $sum: 1 },
            name: { $first: "$name" },
          },
        },
        { $sort: { sessions: -1 } },
        { $limit: input.limit },
      ]);
      const productIds = rows.map((r) => r._id).filter(Boolean);
      const cartRows = productIds.length
        ? await TrackingEvent.aggregate<{ _id: string; carts: number }>([
            {
              $match: {
                merchantId,
                type: "add_to_cart",
                occurredAt: { $gte: since },
                $or: [
                  { "properties.productId": { $in: productIds } },
                  { "properties.sku": { $in: productIds } },
                ],
              },
            },
            {
              $group: {
                _id: {
                  $ifNull: ["$properties.productId", "$properties.sku"],
                },
                carts: { $sum: 1 },
              },
            },
          ])
        : [];
      const cartMap = new Map(cartRows.map((c) => [c._id, c.carts]));
      return rows
        .filter((r) => r._id)
        .map((r) => ({
          productId: r._id,
          name: r.name ?? "Unknown",
          sessions: r.sessions,
          addToCart: cartMap.get(r._id) ?? 0,
          conversionRate:
            r.sessions > 0 ? (cartMap.get(r._id) ?? 0) / r.sessions : 0,
        }));
    }),

  /**
   * Sessions sorted by descending intent score:
   *   intent = 4*checkout_start + 3*add_to_cart + 1*product_view (decayed)
   * Returns up to `limit` rows. UI pages /dashboard/analytics/behavior.
   */
  highIntentSessions: protectedProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(30).default(7), limit: z.number().int().min(1).max(50).default(20) })
        .default({ days: 7, limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(input.days);
      const rows = await TrackingSession.aggregate<{
        _id: Types.ObjectId;
        sessionId: string;
        phone: string | null;
        email: string | null;
        productViews: number;
        addToCartCount: number;
        checkoutStartCount: number;
        checkoutSubmitCount: number;
        durationMs: number;
        firstSeenAt: Date;
        lastSeenAt: Date;
        device: { type?: string };
        landingPath: string | null;
        intent: number;
        repeatVisitor: boolean;
      }>([
        { $match: { merchantId, lastSeenAt: { $gte: since } } },
        {
          $addFields: {
            intent: {
              $add: [
                { $multiply: ["$checkoutSubmitCount", 5] },
                { $multiply: ["$checkoutStartCount", 4] },
                { $multiply: ["$addToCartCount", 3] },
                "$productViews",
              ],
            },
          },
        },
        { $sort: { intent: -1, lastSeenAt: -1 } },
        { $limit: input.limit },
      ]);
      return rows.map((r) => ({
        id: String(r._id),
        sessionId: r.sessionId,
        phone: r.phone ?? null,
        email: r.email ?? null,
        productViews: r.productViews,
        addToCartCount: r.addToCartCount,
        checkoutStartCount: r.checkoutStartCount,
        checkoutSubmitCount: r.checkoutSubmitCount,
        durationMs: r.durationMs,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        device: r.device?.type ?? null,
        landingPath: r.landingPath,
        intent: r.intent,
        repeatVisitor: r.repeatVisitor,
      }));
    }),

  /** Sessions flagged as suspicious — bot-like behavior, abnormal velocity, etc. */
  suspiciousSessions: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(30).default(7), limit: z.number().int().min(1).max(50).default(20) }).default({ days: 7, limit: 20 }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(input.days);
      const rows = await TrackingSession.aggregate<{
        _id: Types.ObjectId;
        sessionId: string;
        phone: string | null;
        productViews: number;
        addToCartCount: number;
        checkoutStartCount: number;
        durationMs: number;
        firstSeenAt: Date;
        lastSeenAt: Date;
        device: { type?: string; browser?: string };
        suspiciousScore: number;
        flags: string[];
      }>([
        { $match: { merchantId, lastSeenAt: { $gte: since } } },
        {
          $addFields: {
            // bot proxy: viewed many products in <2 minutes, never added to cart
            burstNoCart: {
              $and: [
                { $gte: ["$productViews", 8] },
                { $lt: ["$durationMs", 120000] },
                { $eq: ["$addToCartCount", 0] },
              ],
            },
            // multi-cart, no checkout
            cartHoarding: {
              $and: [
                { $gte: ["$addToCartCount", 5] },
                { $eq: ["$checkoutStartCount", 0] },
              ],
            },
            // missing/empty UA
            missingUa: { $eq: [{ $ifNull: ["$device.browser", null] }, null] },
          },
        },
        {
          $addFields: {
            suspiciousScore: {
              $add: [
                { $cond: ["$burstNoCart", 40, 0] },
                { $cond: ["$cartHoarding", 30, 0] },
                { $cond: ["$missingUa", 20, 0] },
              ],
            },
            flags: {
              $concatArrays: [
                { $cond: ["$burstNoCart", ["burst_no_cart"], []] },
                { $cond: ["$cartHoarding", ["cart_hoarding"], []] },
                { $cond: ["$missingUa", ["missing_ua"], []] },
              ],
            },
          },
        },
        { $match: { suspiciousScore: { $gt: 0 } } },
        { $sort: { suspiciousScore: -1, lastSeenAt: -1 } },
        { $limit: input.limit },
      ]);
      return rows.map((r) => ({
        id: String(r._id),
        sessionId: r.sessionId,
        phone: r.phone ?? null,
        productViews: r.productViews,
        addToCartCount: r.addToCartCount,
        checkoutStartCount: r.checkoutStartCount,
        durationMs: r.durationMs,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        device: { type: r.device?.type ?? null, browser: r.device?.browser ?? null },
        suspiciousScore: r.suspiciousScore,
        flags: r.flags,
      }));
    }),

  /** Unique repeat visitors over the window. */
  repeatVisitors: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }).default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(input.days);
      const [agg] = await TrackingSession.aggregate<{
        repeatAnonIds: number;
        totalAnonIds: number;
      }>([
        { $match: { merchantId, lastSeenAt: { $gte: since } } },
        {
          $group: {
            _id: "$anonId",
            sessions: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: null,
            repeatAnonIds: { $sum: { $cond: [{ $gt: ["$sessions", 1] }, 1, 0] } },
            totalAnonIds: { $sum: 1 },
          },
        },
      ]);
      const total = agg?.totalAnonIds ?? 0;
      const repeat = agg?.repeatAnonIds ?? 0;
      return {
        total,
        repeat,
        share: total > 0 ? repeat / total : 0,
      };
    }),

  /**
   * Get behavioral history for a single order — joins sessions stitched to
   * the order via identity-resolution. Powers the "session timeline" tab on
   * the order detail page (pre-purchase intent context for fraud review).
   */
  sessionsForOrder: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.orderId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
      }
      const merchantId = merchantObjectId(ctx);
      const sessions = await TrackingSession.find({
        merchantId,
        resolvedOrderId: new Types.ObjectId(input.orderId),
      })
        .sort({ lastSeenAt: -1 })
        .limit(20)
        .lean();
      return sessions.map((s) => ({
        id: String(s._id),
        sessionId: s.sessionId,
        firstSeenAt: s.firstSeenAt,
        lastSeenAt: s.lastSeenAt,
        durationMs: s.durationMs,
        productViews: s.productViews,
        addToCartCount: s.addToCartCount,
        checkoutStartCount: s.checkoutStartCount,
        device: s.device ?? null,
        landingPath: s.landingPath,
        repeatVisitor: s.repeatVisitor,
        converted: s.converted,
      }));
    }),

  /** Refresh tracking key (rotate). Audit-logged via Merchant write. */
  rotateKey: protectedProcedure.mutation(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    await Merchant.updateOne({ _id: merchantId }, { $unset: { trackingKey: "" } });
    const key = await ensureTrackingKey(merchantId);
    return { key };
  }),
});
