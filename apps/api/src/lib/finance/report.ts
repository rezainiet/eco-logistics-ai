import type { PipelineStage, Types } from "mongoose";
import { FinanceEntry, Order, financeCategory, type FinanceBucket, type FinanceEntryType } from "@ecom/db";
import type { Period } from "./period.js";

/**
 * Merchant profit & loss.
 *
 * REVENUE (cash on delivery): an order is realized revenue ONLY while its
 * status is `delivered`, in the period of its delivery time. Every other
 * status — pending, confirmed, packed, shipped, in_transit, cancelled, rto —
 * is never revenue. Sales revenue is read from orders and never stored as a
 * finance entry, so it cannot be counted twice; an order has one status, so
 * repeated or concurrent "delivered" transitions cannot count it twice.
 *   - exact:          dated by logistics.deliveredAt (stamped by the courier
 *                     path and by a manual "delivered").
 *   - fallback-dated: historical delivered orders that predate deliveredAt
 *                     stamping are dated by their last update time. They are
 *                     reported separately; stored data is never rewritten.
 *
 * PRODUCT COST = Σ items[].unitCost × quantity of delivered orders
 *   (+ manual "product_cost" entries). An item without a recorded unitCost
 *   makes its order "product cost not recorded" — never counted as 0.
 *
 * COURIER COST: logistics.courierFee is written once, by the booking that
 *   gives the order its tracking number (bookSingleShipment's atomic,
 *   tracking-number-guarded update); nothing else writes it. Each order
 *   contributes that one fee exactly once, according to its CURRENT final
 *   state:
 *     - delivered → dated by deliveredAt (same exact/fallback rule as revenue)
 *     - rto       → dated by returnedAt (fallback: last update time) — the
 *                   courier charged for the parcel even though it came back
 *   An order is in exactly one of these states, so a parcel that moved
 *   between them (a late courier "delivered" after a return) is counted once,
 *   in its final state. Orders in any other state (never shipped, cancelled
 *   before shipment, still in transit) contribute no courier cost. A
 *   delivered or returned order without a recorded fee is "courier cost not
 *   recorded" — never 0 (RedX and Steadfast bookings return no fee today).
 *   Manual "courier" entries are added as they are: they cannot be matched
 *   to orders automatically, so the report flags a period that has both.
 *
 * Everything else comes from active finance entries, by category.
 * Net profit = realized revenue + other income − all costs above.
 * BDT only: orders in another currency are excluded and counted.
 */

const OPEN_STATUSES = ["pending", "confirmed", "packed", "shipped", "in_transit"];
const DHAKA_TZ = "+06:00";

type Key = string; // "all" for a period summary, "YYYY-MM" for a monthly row

const round2 = (n: number) => Math.round(n * 100) / 100;

interface DeliveredAgg {
  exactRevenue: number;
  exactOrders: number;
  fallbackRevenue: number;
  fallbackOrders: number;
  /** Part of the revenue above that is delivery charges collected from customers (already inside the order total). */
  deliveryCharges: number;
  productCost: number;
  missingCost: number;
  fee: number;
  missingFee: number;
  nonBdt: number;
}
const emptyDelivered = (): DeliveredAgg => ({
  exactRevenue: 0, exactOrders: 0, fallbackRevenue: 0, fallbackOrders: 0, deliveryCharges: 0, productCost: 0, missingCost: 0, fee: 0, missingFee: 0, nonBdt: 0,
});

interface ReturnedAgg {
  orders: number;
  fee: number;
  missingFee: number;
  fallbackOrders: number;
}
const emptyReturned = (): ReturnedAgg => ({ orders: 0, fee: 0, missingFee: 0, fallbackOrders: 0 });

/** Group key expression: one bucket, or the Dhaka month of `dateExpr`. */
const keyOf = (monthly: boolean, dateExpr: string) =>
  monthly ? { $dateToString: { format: "%Y-%m", date: dateExpr, timezone: DHAKA_TZ } } : "all";

/** BDT-only filter (accounting is BDT only), as an aggregation expression. */
export const IS_BDT_ORDER = { $in: [{ $toUpper: { $ifNull: ["$order.currency", "BDT"] } }, ["BDT"]] };
const isBdt = IS_BDT_ORDER;
const hasFee = { $isNumber: "$logistics.courierFee" };
const feeOrZero = { $cond: [hasFee, "$logistics.courierFee", 0] };
const count = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });

/**
 * THE revenue-recognition stages, shared with marketing reports so both
 * always agree: delivered orders of one merchant whose delivery date
 * (deliveredAt, or the flagged updatedAt fallback) falls in the period.
 * Adds `_exact` (had deliveredAt) and `_at` (the date used).
 */
export function deliveredInPeriodStages(merchantId: Types.ObjectId, p: Period): PipelineStage[] {
  return [
    { $match: { merchantId, "order.status": "delivered" } },
    { $addFields: { _exact: { $ne: [{ $ifNull: ["$logistics.deliveredAt", null] }, null] } } },
    { $addFields: { _at: { $cond: ["$_exact", "$logistics.deliveredAt", "$updatedAt"] } } },
    { $match: { _at: { $gte: p.start, $lt: p.end } } },
  ];
}

async function deliveredOrders(merchantId: Types.ObjectId, p: Period, monthly: boolean) {
  const rows = await Order.aggregate<{ _id: { k: Key; bdt: boolean } } & Omit<DeliveredAgg, "nonBdt"> & { orders: number }>([
    ...deliveredInPeriodStages(merchantId, p),
    {
      $project: {
        k: keyOf(monthly, "$_at"),
        bdt: isBdt,
        exact: "$_exact",
        total: { $ifNull: ["$order.total", 0] },
        // The delivery charge is part of the order total — reported as a split of
        // revenue, never added on top. Clamped to [0, total] for legacy rows.
        deliveryCharge: {
          $max: [0, { $min: [{ $cond: [{ $isNumber: "$order.deliveryCharge" }, "$order.deliveryCharge", 0] }, { $ifNull: ["$order.total", 0] }] }],
        },
        cost: {
          $sum: {
            $map: {
              input: "$items",
              as: "i",
              in: { $cond: [{ $isNumber: "$$i.unitCost" }, { $multiply: ["$$i.unitCost", "$$i.quantity"] }, 0] },
            },
          },
        },
        costMissing: { $anyElementTrue: [{ $map: { input: "$items", as: "i", in: { $not: [{ $isNumber: "$$i.unitCost" }] } } }] },
        fee: feeOrZero,
        feeMissing: { $not: [hasFee] },
      },
    },
    {
      $group: {
        _id: { k: "$k", bdt: "$bdt" },
        orders: { $sum: 1 },
        exactRevenue: { $sum: { $cond: ["$exact", "$total", 0] } },
        exactOrders: count("$exact"),
        fallbackRevenue: { $sum: { $cond: ["$exact", 0, "$total"] } },
        fallbackOrders: count({ $not: ["$exact"] }),
        deliveryCharges: { $sum: "$deliveryCharge" },
        productCost: { $sum: "$cost" },
        missingCost: count("$costMissing"),
        fee: { $sum: "$fee" },
        missingFee: count("$feeMissing"),
      },
    },
  ]);
  const out = new Map<Key, DeliveredAgg>();
  for (const r of rows) {
    const a = out.get(r._id.k) ?? emptyDelivered();
    if (r._id.bdt) {
      a.exactRevenue += r.exactRevenue;
      a.exactOrders += r.exactOrders;
      a.fallbackRevenue += r.fallbackRevenue;
      a.fallbackOrders += r.fallbackOrders;
      a.deliveryCharges += r.deliveryCharges;
      a.productCost += r.productCost;
      a.missingCost += r.missingCost;
      a.fee += r.fee;
      a.missingFee += r.missingFee;
    } else {
      a.nonBdt += r.orders;
    }
    out.set(r._id.k, a);
  }
  return out;
}

/** Returned (rto) parcels: their courier fee, dated by returnedAt. */
async function returnedOrders(merchantId: Types.ObjectId, p: Period, monthly: boolean) {
  const rows = await Order.aggregate<{ _id: Key } & ReturnedAgg>([
    { $match: { merchantId, "order.status": "rto" } },
    { $addFields: { _exact: { $ne: [{ $ifNull: ["$logistics.returnedAt", null] }, null] } } },
    { $addFields: { _at: { $cond: ["$_exact", "$logistics.returnedAt", "$updatedAt"] } } },
    { $match: { _at: { $gte: p.start, $lt: p.end } } },
    { $match: { $expr: isBdt } },
    {
      $group: {
        _id: keyOf(monthly, "$_at"),
        orders: { $sum: 1 },
        fee: { $sum: feeOrZero },
        missingFee: count({ $not: [hasFee] }),
        fallbackOrders: count({ $not: ["$_exact"] }),
      },
    },
  ]);
  return new Map(rows.map((r) => [r._id, { orders: r.orders, fee: r.fee, missingFee: r.missingFee, fallbackOrders: r.fallbackOrders }]));
}

/** Value of orders PLACED in the period: all of them, and those still open. */
async function placedOrders(merchantId: Types.ObjectId, p: Period) {
  const [row] = await Order.aggregate<{ gross: number; grossOrders: number; pending: number; pendingOrders: number }>([
    { $match: { merchantId, createdAt: { $gte: p.start, $lt: p.end } } },
    { $match: { $expr: isBdt } },
    {
      $group: {
        _id: null,
        gross: { $sum: { $ifNull: ["$order.total", 0] } },
        grossOrders: { $sum: 1 },
        pending: { $sum: { $cond: [{ $in: ["$order.status", OPEN_STATUSES] }, { $ifNull: ["$order.total", 0] }, 0] } },
        pendingOrders: count({ $in: ["$order.status", OPEN_STATUSES] }),
      },
    },
  ]);
  return row ?? { gross: 0, grossOrders: 0, pending: 0, pendingOrders: 0 };
}

interface EntryRow {
  k: Key;
  type: FinanceEntryType;
  category: string;
  total: number;
  count: number;
}

async function entryTotals(merchantId: Types.ObjectId, p: Period, monthly: boolean): Promise<EntryRow[]> {
  const rows = await FinanceEntry.aggregate<{ _id: { k: Key; type: FinanceEntryType; category: string }; total: number; count: number }>([
    { $match: { merchantId, status: "active", currency: "BDT", occurredOn: { $gte: p.fromDay, $lte: p.toDay } } },
    {
      $group: {
        _id: { k: monthly ? { $substrBytes: ["$occurredOn", 0, 7] } : "all", type: "$type", category: "$category" },
        total: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
  ]);
  return rows.map((r) => ({ k: r._id.k, type: r._id.type, category: r._id.category, total: r.total, count: r.count }));
}

function bucketOf(type: FinanceEntryType, category: string): FinanceBucket {
  const c = financeCategory(category);
  if (c && c.type === type) return c.bucket;
  return type === "income" ? "other_income" : "other_expense";
}

function pnlFor(d: DeliveredAgg | undefined, r: ReturnedAgg | undefined, entries: EntryRow[]) {
  const del = d ?? emptyDelivered();
  const ret = r ?? emptyReturned();
  const sum = (bucket: FinanceBucket) =>
    entries.filter((e) => bucketOf(e.type, e.category) === bucket).reduce((s, e) => s + e.total, 0);
  const p = {
    del,
    ret,
    revenue: del.exactRevenue + del.fallbackRevenue,
    otherIncome: sum("other_income"),
    productCostOrders: del.productCost,
    productCostManual: sum("product_cost"),
    courierDelivered: del.fee,
    courierReturned: ret.fee,
    courierManual: sum("courier"),
    advertising: sum("advertising"),
    marketing: sum("marketing"),
    office: sum("office"),
    software: sum("software"),
    salary: sum("salary"),
    otherExpenses: sum("other_expense"),
    refunds: sum("refunds"),
  };
  const productCost = p.productCostOrders + p.productCostManual;
  const courierCost = p.courierDelivered + p.courierReturned + p.courierManual;
  const operatingExpenses = p.office + p.software + p.salary + p.otherExpenses;
  const totalExpenses = p.refunds + productCost + courierCost + p.advertising + p.marketing + operatingExpenses;
  // P&L structure (refunds are contra-revenue):
  //   net revenue  = delivered revenue − refunds
  //   gross profit = net revenue − product cost − courier cost
  //   net profit   = gross profit − advertising − marketing − operating + other income
  // which is exactly revenue + other income − all expenses (the original rule).
  const netRevenue = p.revenue - p.refunds;
  const grossProfit = netRevenue - productCost - courierCost;
  return {
    ...p,
    productCost,
    courierCost,
    operatingExpenses,
    totalExpenses,
    netRevenue,
    grossProfit,
    netProfit: p.revenue + p.otherIncome - totalExpenses,
  };
}

export type FinanceWarningCode =
  | "fallback_dated_revenue"
  | "missing_product_cost"
  | "missing_courier_fee"
  | "fallback_dated_returns"
  | "manual_courier_with_recorded_fees"
  | "non_bdt_excluded";

export async function financeSummary(merchantId: Types.ObjectId, period: Period) {
  const [delivered, returned, placed, entries] = await Promise.all([
    deliveredOrders(merchantId, period, false),
    returnedOrders(merchantId, period, false),
    placedOrders(merchantId, period),
    entryTotals(merchantId, period, false),
  ]);
  const p = pnlFor(delivered.get("all"), returned.get("all"), entries);
  const missingFee = p.del.missingFee + p.ret.missingFee;
  const recordedFees = p.courierDelivered + p.courierReturned;

  const warnings: Array<{ code: FinanceWarningCode; count: number; amount?: number; message: string }> = [];
  if (p.del.fallbackOrders > 0) {
    warnings.push({
      code: "fallback_dated_revenue",
      count: p.del.fallbackOrders,
      amount: round2(p.del.fallbackRevenue),
      message: `${p.del.fallbackOrders} older delivered order(s) (৳${round2(p.del.fallbackRevenue).toLocaleString("en-US")}) have no recorded delivery time; they are dated by their last update.`,
    });
  }
  if (p.del.missingCost > 0) {
    warnings.push({
      code: "missing_product_cost",
      count: p.del.missingCost,
      message: `Product cost not recorded for ${p.del.missingCost} delivered order(s) — net profit does not include their cost.`,
    });
  }
  if (missingFee > 0) {
    warnings.push({
      code: "missing_courier_fee",
      count: missingFee,
      message: `Courier cost not recorded for ${missingFee} delivered or returned order(s) — add it as a Courier expense if you know it.`,
    });
  }
  if (p.ret.fallbackOrders > 0) {
    warnings.push({
      code: "fallback_dated_returns",
      count: p.ret.fallbackOrders,
      message: `${p.ret.fallbackOrders} older returned order(s) have no recorded return time; they are dated by their last update.`,
    });
  }
  if (p.courierManual > 0 && recordedFees > 0) {
    warnings.push({
      code: "manual_courier_with_recorded_fees",
      count: 1,
      message: "This period has courier expenses you entered and courier fees recorded on orders. Make sure your entries don't cover the same parcels.",
    });
  }
  if (p.del.nonBdt > 0) {
    warnings.push({
      code: "non_bdt_excluded",
      count: p.del.nonBdt,
      message: `${p.del.nonBdt} delivered order(s) in another currency are not included (accounting is BDT only).`,
    });
  }

  return {
    period: { from: period.fromDay, to: period.toDay },
    currency: "BDT" as const,
    revenue: {
      realized: round2(p.revenue),
      // realized = productSales + deliveryCharges (a split, not extra income).
      productSales: round2(p.revenue - p.del.deliveryCharges),
      deliveryCharges: round2(p.del.deliveryCharges),
      deliveredOrders: p.del.exactOrders + p.del.fallbackOrders,
      exact: { amount: round2(p.del.exactRevenue), orders: p.del.exactOrders },
      fallbackDated: { amount: round2(p.del.fallbackRevenue), orders: p.del.fallbackOrders },
      pendingOrderValue: round2(placed.pending),
      pendingOrders: placed.pendingOrders,
      grossOrderValue: round2(placed.gross),
      grossOrders: placed.grossOrders,
    },
    otherIncome: round2(p.otherIncome),
    productCost: {
      fromOrders: round2(p.productCostOrders),
      manual: round2(p.productCostManual),
      total: round2(p.productCost),
      ordersMissingCost: p.del.missingCost,
      complete: p.del.missingCost === 0,
    },
    courierCost: {
      fromDelivered: round2(p.courierDelivered),
      fromReturned: round2(p.courierReturned),
      fromOrders: round2(recordedFees),
      manual: round2(p.courierManual),
      total: round2(p.courierCost),
      returnedOrders: p.ret.orders,
      ordersMissingFee: missingFee,
      complete: missingFee === 0,
    },
    refunds: round2(p.refunds),
    netRevenue: round2(p.netRevenue),
    grossProfit: round2(p.grossProfit),
    advertising: round2(p.advertising),
    marketing: round2(p.marketing),
    office: round2(p.office),
    software: round2(p.software),
    salary: round2(p.salary),
    otherExpenses: round2(p.otherExpenses),
    operatingExpenses: round2(p.operatingExpenses),
    totalExpenses: round2(p.totalExpenses),
    netProfit: round2(p.netProfit),
    /** False when a delivered/returned order lacks its product cost or courier fee: profit is then overstated. */
    costComplete: p.del.missingCost === 0 && missingFee === 0,
    byCategory: entries
      .map((e) => ({
        type: e.type,
        category: e.category,
        label: financeCategory(e.category)?.label ?? e.category,
        bucket: bucketOf(e.type, e.category),
        total: round2(e.total),
        count: e.count,
      }))
      .sort((a, b) => b.total - a.total),
    warnings,
    dataQuality: {
      exactDeliveryRevenue: { amount: round2(p.del.exactRevenue), orders: p.del.exactOrders },
      fallbackDatedRevenue: { amount: round2(p.del.fallbackRevenue), orders: p.del.fallbackOrders },
      ordersMissingProductCost: p.del.missingCost,
      ordersMissingCourierFee: missingFee,
      fallbackDatedReturns: p.ret.fallbackOrders,
      nonBdtOrdersExcluded: p.del.nonBdt,
    },
  };
}

export async function financeMonthly(merchantId: Types.ObjectId, year: number, period: Period) {
  const [delivered, returned, entries] = await Promise.all([
    deliveredOrders(merchantId, period, true),
    returnedOrders(merchantId, period, true),
    entryTotals(merchantId, period, true),
  ]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, "0")}`;
    const p = pnlFor(delivered.get(month), returned.get(month), entries.filter((e) => e.k === month));
    return {
      month,
      revenue: round2(p.revenue),
      deliveryCharges: round2(p.del.deliveryCharges),
      deliveredOrders: p.del.exactOrders + p.del.fallbackOrders,
      refunds: round2(p.refunds),
      netRevenue: round2(p.netRevenue),
      otherIncome: round2(p.otherIncome),
      productCost: round2(p.productCost),
      courierCost: round2(p.courierCost),
      grossProfit: round2(p.grossProfit),
      advertising: round2(p.advertising),
      marketing: round2(p.marketing),
      office: round2(p.office),
      software: round2(p.software),
      salary: round2(p.salary),
      otherExpenses: round2(p.otherExpenses),
      operatingExpenses: round2(p.operatingExpenses),
      expenses: round2(p.totalExpenses),
      netProfit: round2(p.netProfit),
      costComplete: p.del.missingCost === 0 && p.del.missingFee + p.ret.missingFee === 0,
      fallbackDatedOrders: p.del.fallbackOrders + p.ret.fallbackOrders,
    };
  });
  // Year summary = the sum of its months (same rules, no separate computation).
  type Num = Exclude<keyof (typeof months)[number], "month" | "costComplete">;
  const keys = Object.keys(months[0]!).filter((k) => k !== "month" && k !== "costComplete") as Num[];
  const totals = Object.fromEntries(keys.map((k) => [k, round2(months.reduce((s, m) => s + (m[k] as number), 0))])) as Record<Num, number>;
  return { year, currency: "BDT" as const, months, totals: { ...totals, costComplete: months.every((m) => m.costComplete) } };
}
