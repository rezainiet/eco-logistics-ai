import type { Types } from "mongoose";
import { FinanceEntry, Order, TrackingSession } from "@ecom/db";
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
export type Dimension = "source" | "medium" | "campaign";

export const REPORT_CHANNELS: readonly ReportChannel[] = [...MARKETING_CHANNELS, "untracked"];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Channel of an order as an aggregation expression. */
function channelExpr(touch: Touchpoint) {
  const field = `$attribution.${touch === "first" ? "firstTouch" : "lastTouch"}.channel`;
  return {
    $ifNull: [field, { $cond: [{ $eq: ["$source.channel", "landing_page"] }, "direct", "untracked"] }],
  };
}

const SPEND_CATEGORY: Record<string, ReportChannel> = { ads_meta: "meta", ads_google: "google", ads_tiktok: "tiktok" };

async function placedBy(merchantId: Types.ObjectId, p: Period, key: unknown) {
  return Order.aggregate<{ _id: string | null; orders: number; value: number }>([
    { $match: { merchantId, createdAt: { $gte: p.start, $lt: p.end } } },
    { $match: { $expr: IS_BDT_ORDER } },
    { $group: { _id: key, orders: { $sum: 1 }, value: { $sum: { $ifNull: ["$order.total", 0] } } } },
  ]);
}

async function deliveredBy(merchantId: Types.ObjectId, p: Period, key: unknown) {
  return Order.aggregate<{ _id: string | null; orders: number; revenue: number }>([
    ...deliveredInPeriodStages(merchantId, p),
    { $match: { $expr: IS_BDT_ORDER } },
    { $group: { _id: key, orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$order.total", 0] } } } },
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
    { $match: { merchantId, firstSeenAt: { $gte: p.start, $lt: p.end } } },
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
  const [placed, delivered, spend, funnel] = await Promise.all([
    placedBy(merchantId, period, key),
    deliveredBy(merchantId, period, key),
    spendByChannel(merchantId, period),
    storefrontFunnel(merchantId, period),
  ]);
  const placedMap = new Map(placed.map((r) => [r._id as ReportChannel, r]));
  const deliveredMap = new Map(delivered.map((r) => [r._id as ReportChannel, r]));

  const channels = REPORT_CHANNELS.map((channel) => {
    const pl = placedMap.get(channel);
    const dl = deliveredMap.get(channel);
    const sp = spend.get(channel) ?? 0;
    const ordersPlaced = pl?.orders ?? 0;
    const revenue = dl?.revenue ?? 0;
    return {
      channel,
      ordersPlaced,
      placedValue: round2(pl?.value ?? 0),
      deliveredOrders: dl?.orders ?? 0,
      deliveredRevenue: round2(revenue),
      /** Manually entered ad spend (Accounting); null when none was entered. */
      spend: sp > 0 ? round2(sp) : null,
      costPerOrder: sp > 0 && ordersPlaced > 0 ? round2(sp / ordersPlaced) : null,
      roas: sp > 0 ? round2(revenue / sp) : null,
    };
  }).filter((r) => r.ordersPlaced > 0 || r.deliveredOrders > 0 || r.spend !== null);

  const totals = channels.reduce(
    (a, r) => ({
      ordersPlaced: a.ordersPlaced + r.ordersPlaced,
      deliveredOrders: a.deliveredOrders + r.deliveredOrders,
      deliveredRevenue: round2(a.deliveredRevenue + r.deliveredRevenue),
      spend: round2(a.spend + (r.spend ?? 0)),
    }),
    { ordersPlaced: 0, deliveredOrders: 0, deliveredRevenue: 0, spend: 0 },
  );

  return {
    period: { from: period.fromDay, to: period.toDay },
    currency: "BDT" as const,
    touch,
    channels,
    totals: { ...totals, roas: totals.spend > 0 ? round2(totals.deliveredRevenue / totals.spend) : null },
    spendSource: "manual_accounting_entries" as const,
    funnel,
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
