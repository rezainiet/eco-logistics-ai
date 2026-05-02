import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { Merchant, TrackingEvent, TrackingSession } from "@ecom/db";
import { billableProcedure, merchantObjectId, protectedProcedure, publicProcedure, router, type SubscriptionSnapshot } from "../trpc.js";
import { fetchPublicTimeline } from "../../lib/public-tracking.js";
import { cached } from "../../lib/cache.js";
import { ensureTrackingKey, rotateTrackingSecret } from "../tracking/collector.js";
import {
  assertAdvancedBehaviorTables,
  assertBehaviorAnalytics,
  assertBehaviorExports,
  clampBehaviorRetentionDays,
  entitlementsFor,
} from "../../lib/entitlements.js";
import type { PlanTier } from "../../lib/plans.js";

function sinceFor(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Per-IP sliding-window limiter for the public tracking lookup. Defends
// against tracking-code enumeration on an unauthenticated endpoint. Held
// in-process — the global Express rate limiter (Redis-backed) is the
// authoritative bucket; this is a tighter inner ring for one procedure.
const PUBLIC_TRACK_WINDOW_MS = 60_000;
const PUBLIC_TRACK_MAX = 30;
const publicTrackBuckets = new Map<string, number[]>();

function checkPublicTrackingRate(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - PUBLIC_TRACK_WINDOW_MS;
  const hits = (publicTrackBuckets.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= PUBLIC_TRACK_MAX) {
    publicTrackBuckets.set(ip, hits);
    return false;
  }
  hits.push(now);
  publicTrackBuckets.set(ip, hits);
  // Opportunistic cleanup so the map cannot grow unbounded under attack.
  if (publicTrackBuckets.size > 5_000) {
    for (const [k, v] of publicTrackBuckets) {
      const fresh = v.filter((t) => t > cutoff);
      if (fresh.length === 0) publicTrackBuckets.delete(k);
      else publicTrackBuckets.set(k, fresh);
    }
  }
  return true;
}

function tierFromCtx(ctx: { subscription?: SubscriptionSnapshot | null | undefined }): PlanTier {
  return (ctx.subscription?.tier ?? "starter") as PlanTier;
}

/**
 * Behavior procedures all flow through `billableProcedure` so we have the
 * subscription tier on the context. Each gate then asserts the specific
 * entitlement and (where applicable) clamps the requested time window down
 * to the plan's retention cap before the aggregation runs.
 */

export const trackingRouter = router({
  /**
   * Rotate (or first-mint) the merchant's HMAC tracking secret. Plaintext
   * is returned ONCE — the merchant pastes it into the SDK config. After
   * rotation, every previously-issued signature becomes invalid; merchants
   * who flip strict mode on must roll their SDK at the same time.
   */
  rotateSecret: protectedProcedure.mutation(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const secret = await rotateTrackingSecret(merchantId);
    return { secret };
  }),

  /** Toggle strict HMAC enforcement. Once strict, unsigned batches 401. */
  setStrictHmac: protectedProcedure
    .input(z.object({ strict: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await Merchant.updateOne(
        { _id: merchantId },
        { $set: { trackingStrictHmac: input.strict } },
      );
      return { ok: true, strict: input.strict };
    }),

  /** Returns the merchant's storefront tracking key + the SDK snippet to embed. */
  getInstallation: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const key = await ensureTrackingKey(merchantId);
    const collector = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/track/collect`;
    const sdkUrl = `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3001"}/sdk.js`;
    const snippet = `<script async src="${sdkUrl}" data-tracking-key="${key}" data-collector="${collector}"></script>`;

    // Install verification — single round-trip to MongoDB. We rely on the
    // {merchantId, occurredAt} index; latest event wins and indicates the
    // SDK is firing. `firstSeenAt` shows up the moment we see *any* event,
    // even if it was a one-off curl test.
    const [latestEvent, oldestEvent] = await Promise.all([
      TrackingEvent.findOne({ merchantId })
        .sort({ occurredAt: -1 })
        .select("occurredAt type")
        .lean(),
      TrackingEvent.findOne({ merchantId })
        .sort({ occurredAt: 1 })
        .select("occurredAt")
        .lean(),
    ]);
    const sessionCount = latestEvent
      ? await TrackingSession.countDocuments({ merchantId })
      : 0;
    const lastSeenAt = latestEvent?.occurredAt ?? null;
    const ageMs = lastSeenAt ? Date.now() - lastSeenAt.getTime() : null;
    // Healthy = saw an event in the last 7 days. Stale rendering tells the
    // merchant their snippet is silent before they ship a campaign.
    const status: "not_installed" | "stale" | "healthy" = !latestEvent
      ? "not_installed"
      : ageMs !== null && ageMs > 7 * 24 * 60 * 60 * 1000
        ? "stale"
        : "healthy";

    return {
      key,
      collector,
      sdkUrl,
      snippet,
      install: {
        status,
        firstSeenAt: oldestEvent?.occurredAt ?? null,
        lastSeenAt,
        sessionCount,
        latestEventType: latestEvent?.type ?? null,
      },
    };
  }),

  /**
   * Plan-aware entitlements for the behavior surface — UI uses this to gate
   * tabs, hide rows, and render upgrade CTAs without trial-and-error 403s.
   */
  getEntitlements: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const m = await Merchant.findById(merchantId).select("subscription.tier").lean();
    const tier = (m?.subscription?.tier ?? "starter") as PlanTier;
    return entitlementsFor(tier);
  }),

  /** High-level KPIs powering the behavior analytics page. */
  overview: billableProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }).default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      const tier = tierFromCtx(ctx);
      assertBehaviorAnalytics(tier);
      const days = clampBehaviorRetentionDays(tier, input.days);
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(days);
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
  funnel: billableProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }).default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      const tier = tierFromCtx(ctx);
      assertBehaviorAnalytics(tier);
      const days = clampBehaviorRetentionDays(tier, input.days);
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(days);
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
  topProducts: billableProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(365).default(30), limit: z.number().int().min(1).max(50).default(10) })
        .default({ days: 30, limit: 10 }),
    )
    .query(async ({ ctx, input }) => {
      const tier = tierFromCtx(ctx);
      assertBehaviorAnalytics(tier);
      const days = clampBehaviorRetentionDays(tier, input.days);
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(days);
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
   *
   * Gated to Scale+ (advanced behavior tables).
   */
  highIntentSessions: billableProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(180).default(7), limit: z.number().int().min(1).max(50).default(20) })
        .default({ days: 7, limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      const tier = tierFromCtx(ctx);
      assertAdvancedBehaviorTables(tier);
      const days = clampBehaviorRetentionDays(tier, input.days);
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(days);
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

  /**
   * Sessions flagged as suspicious — bot-like behavior, abnormal velocity, etc.
   * Gated to Scale+ (advanced behavior tables).
   */
  suspiciousSessions: billableProcedure
    .input(z.object({ days: z.number().int().min(1).max(180).default(7), limit: z.number().int().min(1).max(50).default(20) }).default({ days: 7, limit: 20 }))
    .query(async ({ ctx, input }) => {
      const tier = tierFromCtx(ctx);
      assertAdvancedBehaviorTables(tier);
      const days = clampBehaviorRetentionDays(tier, input.days);
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(days);
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
  repeatVisitors: billableProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }).default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      const tier = tierFromCtx(ctx);
      assertBehaviorAnalytics(tier);
      const days = clampBehaviorRetentionDays(tier, input.days);
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(days);
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

  /**
   * Public-facing tracking timeline for the customer-share page
   * (`/track/[code]`). No authentication. Returns ONLY safe fields
   * (no phone, no full address, no fraud, no internal ids). Cached
   * in Redis for 30s so a viral order link cannot hammer Mongo.
   *
   * Per-IP rate-limited (30/min) to block tracking-code enumeration —
   * codes can be short and the endpoint distinguishes hit/miss.
   */
  getPublicTimeline: publicProcedure
    .input(z.object({ code: z.string().trim().min(4).max(100) }))
    .query(async ({ ctx, input }) => {
      const ip = ctx.request?.ip ?? "unknown";
      if (!checkPublicTrackingRate(ip)) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many tracking lookups. Try again in a minute.",
        });
      }
      const result = await cached(
        `public-tracking:${input.code}`,
        30,
        () => fetchPublicTimeline(input.code),
      );
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "We could not find that tracking code. Double-check the link or contact the merchant.",
        });
      }
      return result;
    }),

  /** Refresh tracking key (rotate). Audit-logged via Merchant write. */
  rotateKey: protectedProcedure.mutation(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    await Merchant.updateOne({ _id: merchantId }, { $unset: { trackingKey: "" } });
    const key = await ensureTrackingKey(merchantId);
    return { key };
  }),

  /**
   * Behavior data export (Enterprise-only). Returns up to `limit` rows of
   * either sessions or raw events as JSON — the UI wraps the payload into a
   * downloadable file. Capped at 5,000 rows so a click can't OOM the server.
   *
   * Custom retention applies: an enterprise merchant may pull whatever window
   * they ask for, bounded only by the hard MAX_DAYS sanity ceiling.
   */
  exportData: billableProcedure
    .input(
      z.object({
        kind: z.enum(["sessions", "events"]).default("sessions"),
        days: z.number().int().min(1).max(3650).default(30),
        limit: z.number().int().min(1).max(5000).default(1000),
      }),
    )
    .query(async ({ ctx, input }) => {
      const tier = tierFromCtx(ctx);
      assertBehaviorExports(tier);
      const days = clampBehaviorRetentionDays(tier, input.days);
      const merchantId = merchantObjectId(ctx);
      const since = sinceFor(days);
      if (input.kind === "events") {
        const rows = await TrackingEvent.find({
          merchantId,
          occurredAt: { $gte: since },
        })
          .sort({ occurredAt: -1 })
          .limit(input.limit)
          .lean();
        return {
          kind: "events" as const,
          count: rows.length,
          windowDays: days,
          rows: rows.map((r) => ({
            id: String(r._id),
            sessionId: r.sessionId,
            anonId: r.anonId ?? null,
            type: r.type,
            url: r.url ?? null,
            path: r.path ?? null,
            referrer: r.referrer ?? null,
            campaign: r.campaign ?? null,
            device: r.device ?? null,
            properties: r.properties ?? null,
            phone: r.phone ?? null,
            email: r.email ?? null,
            occurredAt: r.occurredAt,
          })),
        };
      }
      const rows = await TrackingSession.find({
        merchantId,
        lastSeenAt: { $gte: since },
      })
        .sort({ lastSeenAt: -1 })
        .limit(input.limit)
        .lean();
      return {
        kind: "sessions" as const,
        count: rows.length,
        windowDays: days,
        rows: rows.map((s) => ({
          id: String(s._id),
          sessionId: s.sessionId,
          anonId: s.anonId ?? null,
          phone: s.phone ?? null,
          email: s.email ?? null,
          firstSeenAt: s.firstSeenAt,
          lastSeenAt: s.lastSeenAt,
          durationMs: s.durationMs,
          pageViews: s.pageViews,
          productViews: s.productViews,
          addToCartCount: s.addToCartCount,
          checkoutStartCount: s.checkoutStartCount,
          checkoutSubmitCount: s.checkoutSubmitCount,
          repeatVisitor: s.repeatVisitor,
          converted: s.converted,
          abandonedCart: s.abandonedCart,
          landingPath: s.landingPath ?? null,
          referrer: s.referrer ?? null,
          campaign: s.campaign ?? null,
          device: s.device ?? null,
          resolvedOrderId: s.resolvedOrderId ? String(s.resolvedOrderId) : null,
        })),
      };
    }),
});
