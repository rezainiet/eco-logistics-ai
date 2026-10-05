import { Types } from "mongoose";
import { FinanceEntry, LandingPage, Merchant, Order, RecoveryTask, TrackingEvent, TrackingSession } from "@ecom/db";
import { getPlan } from "../plans.js";
import type { Period } from "../finance/period.js";
import { IS_BDT_ORDER, deliveredInPeriodStages } from "../finance/report.js";
import { MARKETING_CHANNELS, type ReportChannel } from "./channel.js";

/**
 * Merchant marketing reports (always one merchant: merchantId comes from
 * the session, never from input).
 *
 *   orders placed      orders CREATED in the period, by channel/source/…
 *   delivered revenue  EXACTLY Accounting's revenue rule — delivered orders
 *                      whose delivery date falls in the period (shared
 *                      pipeline stages, BDT only). Attribution never creates
 *                      revenue; it only labels revenue Accounting recognizes.
 *   ad spend           only what the merchant entered in Accounting
 *                      (Meta / Google / TikTok ads categories). Never
 *                      estimated; cost per order and ROAS stay null without it.
 *
 * Channel of an order = its first- or last-touch channel (server-derived at
 * order creation). Landing-page orders without any attributable signal are
 * "direct"; orders from other channels (dashboard, CSV, integrations) or
 * placed before attribution existed are "untracked".
 */

export type Touchpoint = "first" | "last";
export type Dimension = "source" | "medium" | "campaign" | "content" | "term";

/**
 * Traffic type of an order — the plain-language grouping of its channel:
 *   paid       the touch carried an ad-click id or a paid utm_medium
 *   organic    unpaid search, social or another website
 *   direct     a landing-page order with no attributable signal
 *   other      tagged with UTM, unknown platform, not paid (e.g. email, SMS)
 *   untracked  created outside the landing pages, or before tracking existed
 */
export const TRAFFIC_TYPES = ["paid", "organic", "direct", "other", "untracked"] as const;
export type TrafficType = (typeof TRAFFIC_TYPES)[number];

export const REPORT_CHANNELS: readonly ReportChannel[] = [...MARKETING_CHANNELS, "untracked"];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Channel of an order as an aggregation expression. */
function channelExpr(touch: Touchpoint) {
  const field = `$attribution.${touch === "first" ? "firstTouch" : "lastTouch"}.channel`;
  return {
    $ifNull: [field, { $cond: [{ $eq: ["$source.channel", "landing_page"] }, "direct", "untracked"] }],
  };
}

/** Traffic type of an order as an aggregation expression (see TRAFFIC_TYPES). */
function trafficTypeExpr(touch: Touchpoint) {
  const t = `$attribution.${touch === "first" ? "firstTouch" : "lastTouch"}`;
  return {
    $switch: {
      branches: [
        { case: { $eq: [{ $ifNull: [`${t}.channel`, null] }, null] }, then: { $cond: [{ $eq: ["$source.channel", "landing_page"] }, "direct", "untracked"] } },
        { case: { $eq: [`${t}.paid`, true] }, then: "paid" },
        { case: { $eq: [`${t}.channel`, "direct"] }, then: "direct" },
        { case: { $eq: [`${t}.channel`, "other"] }, then: "other" },
      ],
      default: "organic",
    },
  };
}

const SPEND_CATEGORY: Record<string, ReportChannel> = { ads_meta: "meta", ads_google: "google", ads_tiktok: "tiktok" };

/** Same cost expressions as Accounting (lib/finance/report.ts): a missing cost is "not recorded", never 0. */
const PRODUCT_COST = {
  $sum: { $map: { input: "$items", as: "i", in: { $cond: [{ $isNumber: "$$i.unitCost" }, { $multiply: ["$$i.unitCost", "$$i.quantity"] }, 0] } } },
};
const COST_MISSING = { $anyElementTrue: [{ $map: { input: "$items", as: "i", in: { $not: [{ $isNumber: "$$i.unitCost" }] } } }] };
const HAS_FEE = { $isNumber: "$logistics.courierFee" };

async function placedBy(merchantId: Types.ObjectId, p: Period, key: unknown) {
  return Order.aggregate<{ _id: string | null; orders: number; value: number }>([
    { $match: { merchantId, createdAt: { $gte: p.start, $lt: p.end } } },
    { $match: { $expr: IS_BDT_ORDER } },
    { $group: { _id: key, orders: { $sum: 1 }, value: { $sum: { $ifNull: ["$order.total", 0] } } } },
  ]);
}

async function deliveredBy(merchantId: Types.ObjectId, p: Period, key: unknown) {
  return Order.aggregate<{
    _id: string | null;
    orders: number;
    revenue: number;
    productCost: number;
    missingCost: number;
    courierFee: number;
    missingFee: number;
  }>([
    ...deliveredInPeriodStages(merchantId, p),
    { $match: { $expr: IS_BDT_ORDER } },
    {
      $group: {
        _id: key,
        orders: { $sum: 1 },
        revenue: { $sum: { $ifNull: ["$order.total", 0] } },
        productCost: { $sum: PRODUCT_COST },
        missingCost: { $sum: { $cond: [COST_MISSING, 1, 0] } },
        courierFee: { $sum: { $cond: [HAS_FEE, "$logistics.courierFee", 0] } },
        missingFee: { $sum: { $cond: [HAS_FEE, 0, 1] } },
      },
    },
  ]);
}

/** Returned (rto) parcels in the period: their courier fee is a cost, as in Accounting. */
async function returnedBy(merchantId: Types.ObjectId, p: Period, key: unknown) {
  return Order.aggregate<{ _id: string | null; orders: number; courierFee: number; missingFee: number }>([
    { $match: { merchantId, "order.status": "rto" } },
    { $addFields: { _at: { $ifNull: ["$logistics.returnedAt", "$updatedAt"] } } },
    { $match: { _at: { $gte: p.start, $lt: p.end } } },
    { $match: { $expr: IS_BDT_ORDER } },
    {
      $group: {
        _id: key,
        orders: { $sum: 1 },
        courierFee: { $sum: { $cond: [HAS_FEE, "$logistics.courierFee", 0] } },
        missingFee: { $sum: { $cond: [HAS_FEE, 0, 1] } },
      },
    },
  ]);
}

async function spendByChannel(merchantId: Types.ObjectId, p: Period): Promise<Map<ReportChannel, number>> {
  const rows = await FinanceEntry.aggregate<{ _id: string; total: number }>([
    {
      $match: {
        merchantId,
        status: "active",
        type: "expense",
        currency: "BDT",
        category: { $in: Object.keys(SPEND_CATEGORY) },
        occurredOn: { $gte: p.fromDay, $lte: p.toDay },
      },
    },
    { $group: { _id: "$category", total: { $sum: "$amount" } } },
  ]);
  return new Map(rows.map((r) => [SPEND_CATEGORY[r._id]!, r.total]));
}

/** Funnel from the storefront tracker (sessions), when this merchant uses it. */
async function storefrontFunnel(merchantId: Types.ObjectId, p: Period) {
  const [row] = await TrackingSession.aggregate<{
    sessions: number;
    productViews: number;
    addToCart: number;
    checkoutStarted: number;
    converted: number;
  }>([
    // Storefront-SDK sessions only (the SDK always sends an anonymous visitor
    // id); hosted landing pages have their own funnel (landingFunnel).
    { $match: { merchantId, firstSeenAt: { $gte: p.start, $lt: p.end }, anonId: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: null,
        sessions: { $sum: 1 },
        productViews: { $sum: { $cond: [{ $gt: ["$productViews", 0] }, 1, 0] } },
        addToCart: { $sum: { $cond: [{ $gt: ["$addToCartCount", 0] }, 1, 0] } },
        checkoutStarted: { $sum: { $cond: [{ $gt: ["$checkoutStartCount", 0] }, 1, 0] } },
        converted: { $sum: { $cond: ["$converted", 1, 0] } },
      },
    },
  ]);
  if (!row || row.sessions === 0) return null;
  const { sessions, productViews, addToCart, checkoutStarted, converted } = row;
  return { source: "storefront_tracker" as const, sessions, productViews, addToCart, checkoutStarted, converted };
}

export async function marketingOverview(merchantId: Types.ObjectId, period: Period, touch: Touchpoint) {
  const key = channelExpr(touch);
  const tkey = trafficTypeExpr(touch);
  const [placed, delivered, returned, spend, funnel, placedTraffic, deliveredTraffic, recovery] = await Promise.all([
    placedBy(merchantId, period, key),
    deliveredBy(merchantId, period, key),
    returnedBy(merchantId, period, key),
    spendByChannel(merchantId, period),
    storefrontFunnel(merchantId, period),
    placedBy(merchantId, period, tkey),
    deliveredBy(merchantId, period, tkey),
    recoveryAttribution(merchantId, period),
  ]);
  const placedMap = new Map(placed.map((r) => [r._id as ReportChannel, r]));
  const deliveredMap = new Map(delivered.map((r) => [r._id as ReportChannel, r]));
  const returnedMap = new Map(returned.map((r) => [r._id as ReportChannel, r]));

  const channels = REPORT_CHANNELS.map((channel) => {
    const pl = placedMap.get(channel);
    const dl = deliveredMap.get(channel);
    const sp = spend.get(channel) ?? 0;
    const rt = returnedMap.get(channel);
    const ordersPlaced = pl?.orders ?? 0;
    const revenue = dl?.revenue ?? 0;
    const deliveredOrders = dl?.orders ?? 0;
    const productCost = dl?.productCost ?? 0;
    const courierCost = (dl?.courierFee ?? 0) + (rt?.courierFee ?? 0);
    const missingCost = dl?.missingCost ?? 0;
    const missingFee = (dl?.missingFee ?? 0) + (rt?.missingFee ?? 0);
    // Profit is shown only when every delivered/returned order of the channel
    // has its product cost and courier fee recorded — never estimated.
    const profitComplete = missingCost === 0 && missingFee === 0;
    return {
      channel,
      ordersPlaced,
      placedValue: round2(pl?.value ?? 0),
      deliveredOrders,
      deliveredRevenue: round2(revenue),
      returnedOrders: rt?.orders ?? 0,
      /** Manually entered ad spend (Accounting); null when none was entered. */
      spend: sp > 0 ? round2(sp) : null,
      costPerOrder: sp > 0 && ordersPlaced > 0 ? round2(sp / ordersPlaced) : null,
      costPerDeliveredOrder: sp > 0 && deliveredOrders > 0 ? round2(sp / deliveredOrders) : null,
      roas: sp > 0 ? round2(revenue / sp) : null,
      productCost: round2(productCost),
      courierCost: round2(courierCost),
      missingCostOrders: missingCost,
      missingFeeOrders: missingFee,
      /** Delivered revenue − product cost − courier fees − ad spend; null unless all costs are recorded. */
      profit: profitComplete && (deliveredOrders > 0 || (rt?.orders ?? 0) > 0 || sp > 0) ? round2(revenue - productCost - courierCost - sp) : null,
    };
  }).filter((r) => r.ordersPlaced > 0 || r.deliveredOrders > 0 || r.returnedOrders > 0 || r.spend !== null);

  const totals = channels.reduce(
    (a, r) => ({
      ordersPlaced: a.ordersPlaced + r.ordersPlaced,
      deliveredOrders: a.deliveredOrders + r.deliveredOrders,
      deliveredRevenue: round2(a.deliveredRevenue + r.deliveredRevenue),
      spend: round2(a.spend + (r.spend ?? 0)),
    }),
    { ordersPlaced: 0, deliveredOrders: 0, deliveredRevenue: 0, spend: 0 },
  );

  const tPlaced = new Map(placedTraffic.map((r) => [r._id as TrafficType, r]));
  const tDelivered = new Map(deliveredTraffic.map((r) => [r._id as TrafficType, r]));
  const trafficTypes = TRAFFIC_TYPES.map((type) => ({
    type,
    ordersPlaced: tPlaced.get(type)?.orders ?? 0,
    deliveredOrders: tDelivered.get(type)?.orders ?? 0,
    deliveredRevenue: round2(tDelivered.get(type)?.revenue ?? 0),
  })).filter((r) => r.ordersPlaced > 0 || r.deliveredOrders > 0);

  const allProfitKnown = channels.length > 0 && channels.every((c) => c.missingCostOrders === 0 && c.missingFeeOrders === 0);
  return {
    period: { from: period.fromDay, to: period.toDay },
    currency: "BDT" as const,
    touch,
    channels,
    totals: {
      ...totals,
      roas: totals.spend > 0 ? round2(totals.deliveredRevenue / totals.spend) : null,
      profit: allProfitKnown ? round2(channels.reduce((a, c) => a + (c.profit ?? 0), 0)) : null,
    },
    trafficTypes,
    recovery,
    warnings: marketingWarnings(channels, totals.ordersPlaced),
    spendSource: "manual_accounting_entries" as const,
    funnel,
  };
}

export type MarketingWarningCode = "paid_without_spend" | "spend_without_orders" | "cost_missing" | "courier_fee_missing" | "untracked_share";

/** Where the numbers are incomplete — said plainly instead of filled in. */
function marketingWarnings(
  channels: Array<{ channel: ReportChannel; ordersPlaced: number; deliveredOrders: number; spend: number | null; missingCostOrders: number; missingFeeOrders: number }>,
  ordersPlaced: number,
): Array<{ code: MarketingWarningCode; channel?: ReportChannel; count?: number }> {
  const out: Array<{ code: MarketingWarningCode; channel?: ReportChannel; count?: number }> = [];
  for (const c of channels) {
    const adChannel = c.channel === "meta" || c.channel === "google" || c.channel === "tiktok";
    if (adChannel && c.spend === null && c.ordersPlaced > 0) out.push({ code: "paid_without_spend", channel: c.channel, count: c.ordersPlaced });
    if (c.spend !== null && c.ordersPlaced === 0 && c.deliveredOrders === 0) out.push({ code: "spend_without_orders", channel: c.channel });
  }
  const missingCost = channels.reduce((a, c) => a + c.missingCostOrders, 0);
  const missingFee = channels.reduce((a, c) => a + c.missingFeeOrders, 0);
  if (missingCost > 0) out.push({ code: "cost_missing", count: missingCost });
  if (missingFee > 0) out.push({ code: "courier_fee_missing", count: missingFee });
  const untracked = channels.find((c) => c.channel === "untracked")?.ordersPlaced ?? 0;
  if (ordersPlaced > 0 && untracked / ordersPlaced >= 0.5) out.push({ code: "untracked_share", count: untracked });
  return out;
}

/**
 * Orders won back by Cart Recovery (a RecoveryTask linked to the order).
 * The order keeps its normal attribution — first touch is still the ad that
 * brought the buyer; the recovery link adds a last touch of
 * confirmx / email / cart_recovery. Revenue follows the same delivered rule.
 */
async function recoveryAttribution(merchantId: Types.ObjectId, p: Period) {
  const tasks = await RecoveryTask.find({ merchantId, status: "recovered", recoveredOrderId: { $exists: true } })
    .select("recoveredOrderId recoveredAt")
    .lean();
  if (tasks.length === 0) return { recoveredOrders: 0, deliveredOrders: 0, deliveredRevenue: 0 };
  const ids = tasks.map((t) => t.recoveredOrderId as Types.ObjectId);
  const [placed] = await Order.aggregate<{ n: number }>([
    { $match: { merchantId, _id: { $in: ids }, createdAt: { $gte: p.start, $lt: p.end } } },
    { $count: "n" },
  ]);
  const [delivered] = await Order.aggregate<{ orders: number; revenue: number }>([
    ...deliveredInPeriodStages(merchantId, p),
    { $match: { _id: { $in: ids } } },
    { $match: { $expr: IS_BDT_ORDER } },
    { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$order.total", 0] } } } },
  ]);
  return { recoveredOrders: placed?.n ?? 0, deliveredOrders: delivered?.orders ?? 0, deliveredRevenue: round2(delivered?.revenue ?? 0) };
}

/**
 * Landing-page funnel: visit → added to cart → started checkout → ordered →
 * delivered. Visits and cart steps come from the landing pages' own
 * first-party activity (TrackingEvent, counted per visitor session, so a
 * reload or a retried event never counts twice); orders and delivered
 * revenue come from the orders themselves (same delivered rule as
 * Accounting). Visit capture is part of the Growth+ behavior tracking — on
 * other plans `collecting` is false and only the order steps are filled.
 */
export async function landingFunnel(merchantId: Types.ObjectId, period: Period, landingPageId?: string | null) {
  const pageFilter = landingPageId && Types.ObjectId.isValid(landingPageId) ? landingPageId : null;
  const merchant = await Merchant.findById(merchantId).select("subscription.tier").lean();
  const collecting = !!getPlan(merchant?.subscription?.tier ?? "starter").features.behaviorAnalytics;

  // One row per visitor session: its page, its entry channel and how far it got.
  // Index {merchantId, type, occurredAt}.
  const sessions = await TrackingEvent.aggregate<{
    _id: { page: string | null; channel: string };
    visits: number;
    addedToCart: number;
    checkoutStarted: number;
    ordered: number;
  }>([
    {
      $match: {
        merchantId,
        type: { $in: ["page_view", "add_to_cart", "checkout_start", "checkout_submit"] },
        occurredAt: { $gte: period.start, $lt: period.end },
        "properties.source": "landing_page",
        ...(pageFilter ? { "properties.landing.pageId": pageFilter } : {}),
      },
    },
    { $sort: { occurredAt: 1 } },
    {
      $group: {
        _id: "$sessionId",
        page: { $first: "$properties.landing.pageId" },
        channel: { $first: { $cond: [{ $eq: ["$type", "page_view"] }, "$properties.touch.channel", null] } },
        viewed: { $max: { $cond: [{ $eq: ["$type", "page_view"] }, 1, 0] } },
        cart: { $max: { $cond: [{ $eq: ["$type", "add_to_cart"] }, 1, 0] } },
        checkout: { $max: { $cond: [{ $eq: ["$type", "checkout_start"] }, 1, 0] } },
        submitted: { $max: { $cond: [{ $eq: ["$type", "checkout_submit"] }, 1, 0] } },
      },
    },
    {
      $group: {
        _id: { page: "$page", channel: { $ifNull: ["$channel", "direct"] } },
        visits: { $sum: { $max: ["$viewed", "$cart", "$checkout", "$submitted"] } },
        addedToCart: { $sum: "$cart" },
        checkoutStarted: { $sum: "$checkout" },
        ordered: { $sum: "$submitted" },
      },
    },
  ]);

  const orderMatch = {
    merchantId,
    "source.channel": "landing_page",
    ...(pageFilter ? { "source.landingPageId": new Types.ObjectId(pageFilter) } : {}),
  };
  const [placed, delivered] = await Promise.all([
    Order.aggregate<{ _id: string | null; orders: number }>([
      { $match: { ...orderMatch, createdAt: { $gte: period.start, $lt: period.end } } },
      { $match: { $expr: IS_BDT_ORDER } },
      { $group: { _id: { $toString: "$source.landingPageId" }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: string | null; orders: number; revenue: number }>([
      ...deliveredInPeriodStages(merchantId, period),
      { $match: orderMatch },
      { $match: { $expr: IS_BDT_ORDER } },
      { $group: { _id: { $toString: "$source.landingPageId" }, orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$order.total", 0] } } } },
    ]),
  ]);

  type Row = { visits: number; addedToCart: number; checkoutStarted: number; ordersPlaced: number; deliveredOrders: number; deliveredRevenue: number };
  const empty = (): Row => ({ visits: 0, addedToCart: 0, checkoutStarted: 0, ordersPlaced: 0, deliveredOrders: 0, deliveredRevenue: 0 });
  const byPage = new Map<string, Row>();
  const byChannel = new Map<string, Pick<Row, "visits" | "addedToCart" | "checkoutStarted"> & { checkoutSubmitted: number }>();
  for (const s of sessions) {
    const page = s._id.page ?? "unknown";
    const r = byPage.get(page) ?? empty();
    r.visits += s.visits;
    r.addedToCart += s.addedToCart;
    r.checkoutStarted += s.checkoutStarted;
    byPage.set(page, r);
    const c = byChannel.get(s._id.channel) ?? { visits: 0, addedToCart: 0, checkoutStarted: 0, checkoutSubmitted: 0 };
    c.visits += s.visits;
    c.addedToCart += s.addedToCart;
    c.checkoutStarted += s.checkoutStarted;
    c.checkoutSubmitted += s.ordered;
    byChannel.set(s._id.channel, c);
  }
  for (const o of placed) {
    const r = byPage.get(o._id ?? "unknown") ?? empty();
    r.ordersPlaced += o.orders;
    byPage.set(o._id ?? "unknown", r);
  }
  for (const o of delivered) {
    const r = byPage.get(o._id ?? "unknown") ?? empty();
    r.deliveredOrders += o.orders;
    r.deliveredRevenue = round2(r.deliveredRevenue + o.revenue);
    byPage.set(o._id ?? "unknown", r);
  }

  const pageIds = [...byPage.keys()].filter((id) => Types.ObjectId.isValid(id));
  const pages = pageIds.length
    ? await LandingPage.find({ _id: { $in: pageIds.map((id) => new Types.ObjectId(id)) }, merchantId }).select("name slug").lean()
    : [];
  const pageName = new Map(pages.map((p) => [String(p._id), p.name]));

  const totals = [...byPage.values()].reduce((a, r) => {
    for (const k of Object.keys(a) as Array<keyof Row>) a[k] = round2(a[k] + r[k]);
    return a;
  }, empty());
  const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

  return {
    period: { from: period.fromDay, to: period.toDay },
    currency: "BDT" as const,
    collecting,
    totals,
    /** Step-to-step conversion in percent; null when the earlier step is 0 (nothing to divide). */
    rates: {
      visitToCart: rate(totals.addedToCart, totals.visits),
      cartToCheckout: rate(totals.checkoutStarted, totals.addedToCart),
      visitToOrder: rate(totals.ordersPlaced, totals.visits),
    },
    pages: [...byPage.entries()]
      // Pages of THIS merchant only (an unknown id can't be named, so it isn't listed).
      .filter(([id]) => pageName.has(id))
      .map(([id, r]) => ({ id, name: pageName.get(id)!, ...r }))
      .sort((a, b) => b.visits - a.visits || b.ordersPlaced - a.ordersPlaced),
    channels: [...byChannel.entries()].map(([channel, r]) => ({ channel, ...r })).sort((a, b) => b.visits - a.visits),
  };
}

export async function marketingBreakdown(merchantId: Types.ObjectId, period: Period, touch: Touchpoint, dimension: Dimension) {
  const path = `$attribution.${touch === "first" ? "firstTouch" : "lastTouch"}`;
  const key = { value: { $ifNull: [`${path}.${dimension}`, null] }, channel: channelExpr(touch) };
  const onlyAttributed = { $match: { [`attribution.${touch === "first" ? "firstTouch" : "lastTouch"}`]: { $exists: true } } };
  const [placed, delivered] = await Promise.all([
    Order.aggregate<{ _id: { value: string | null; channel: ReportChannel }; orders: number }>([
      { $match: { merchantId, createdAt: { $gte: period.start, $lt: period.end } } },
      onlyAttributed,
      { $match: { $expr: IS_BDT_ORDER } },
      { $group: { _id: key, orders: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: { value: string | null; channel: ReportChannel }; orders: number; revenue: number }>([
      ...deliveredInPeriodStages(merchantId, period),
      onlyAttributed,
      { $match: { $expr: IS_BDT_ORDER } },
      { $group: { _id: key, orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$order.total", 0] } } } },
    ]),
  ]);
  const rows = new Map<string, { value: string | null; channel: ReportChannel; ordersPlaced: number; deliveredOrders: number; deliveredRevenue: number }>();
  const k = (id: { value: string | null; channel: ReportChannel }) => `${id.channel}\u0000${id.value ?? ""}`;
  for (const r of placed) {
    rows.set(k(r._id), { value: r._id.value, channel: r._id.channel, ordersPlaced: r.orders, deliveredOrders: 0, deliveredRevenue: 0 });
  }
  for (const r of delivered) {
    const row = rows.get(k(r._id)) ?? { value: r._id.value, channel: r._id.channel, ordersPlaced: 0, deliveredOrders: 0, deliveredRevenue: 0 };
    row.deliveredOrders += r.orders;
    row.deliveredRevenue = round2(row.deliveredRevenue + r.revenue);
    rows.set(k(r._id), row);
  }
  return {
    period: { from: period.fromDay, to: period.toDay },
    currency: "BDT" as const,
    touch,
    dimension,
    rows: [...rows.values()].sort((a, b) => b.deliveredRevenue - a.deliveredRevenue || b.ordersPlaced - a.ordersPlaced),
  };
}
