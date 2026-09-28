import type { Types } from "mongoose";
import { FinanceEntry, Order, financeCategory, type FinanceBucket, type FinanceEntryType } from "@ecom/db";
import type { Period } from "./period.js";

/**
 * Merchant profit & loss.
 *
 * Revenue recognition (cash on delivery): an order is realized revenue ONLY
 * once its status is `delivered`, in the period of its delivery time
 * (`logistics.deliveredAt`; orders delivered before that field was stamped
 * fall back to their last update time and are counted in the notes).
 * Every other status — pending, confirmed, packed, shipped, in_transit,
 * cancelled, rto — is never revenue. Sales revenue is read from orders and
 * never stored as a finance entry, so it cannot be counted twice; a
 * delivered order is one document with one terminal status, so repeated or
 * concurrent "delivered" transitions cannot count it twice either.
 *
 * Costs:
 *   product cost  = Σ items[].unitCost × quantity of delivered orders
 *                   (+ manual "product_cost" entries). Items without a
 *                   recorded unitCost are reported as missing, never as 0.
 *   courier cost  = logistics.courierFee of delivered orders and of returned
 *                   (rto) orders — the courier is paid either way
 *                   (+ manual "courier" entries). Delivered orders without a
 *                   recorded fee are reported as missing.
 *   everything else comes from active finance entries, by category.
 *
 * Net profit = realized revenue + other income − all of the above.
 * BDT only: orders in another currency are excluded and counted.
 */

const OPEN_STATUSES = ["pending", "confirmed", "packed", "shipped", "in_transit"];
const DHAKA_TZ = "+06:00";

type Key = string; // "all" for a period summary, "YYYY-MM" for a monthly row

const round2 = (n: number) => Math.round(n * 100) / 100;

interface OrderAgg {
  revenue: number;
  delivered: number;
  productCost: number;
  missingCost: number;
  fee: number;
  missingFee: number;
  estimatedDate: number;
  nonBdt: number;
  rtoFee: number;
}

const emptyOrderAgg = (): OrderAgg => ({
  revenue: 0, delivered: 0, productCost: 0, missingCost: 0, fee: 0, missingFee: 0, estimatedDate: 0, nonBdt: 0, rtoFee: 0,
});

/** Group key expression: one bucket, or the Dhaka month of `dateExpr`. */
const keyOf = (monthly: boolean, dateExpr: string) =>
  monthly ? { $dateToString: { format: "%Y-%m", date: dateExpr, timezone: DHAKA_TZ } } : "all";

const isBdt = { $in: [{ $toUpper: { $ifNull: ["$order.currency", "BDT"] } }, ["BDT"]] };

async function deliveredOrders(merchantId: Types.ObjectId, p: Period, monthly: boolean) {
  const rows = await Order.aggregate<{ _id: { k: Key; bdt: boolean } } & Omit<OrderAgg, "nonBdt" | "rtoFee">>([
    { $match: { merchantId, "order.status": "delivered" } },
    { $addFields: { _at: { $ifNull: ["$logistics.deliveredAt", "$updatedAt"] } } },
    { $match: { _at: { $gte: p.start, $lt: p.end } } },
    {
      $project: {
        k: keyOf(monthly, "$_at"),
        bdt: isBdt,
        total: { $ifNull: ["$order.total", 0] },
        estimated: { $eq: [{ $ifNull: ["$logistics.deliveredAt", null] }, null] },
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
        fee: { $cond: [{ $isNumber: "$logistics.courierFee" }, "$logistics.courierFee", 0] },
        feeMissing: { $not: [{ $isNumber: "$logistics.courierFee" }] },
      },
    },
    {
      $group: {
        _id: { k: "$k", bdt: "$bdt" },
        revenue: { $sum: "$total" },
        delivered: { $sum: 1 },
        productCost: { $sum: "$cost" },
        missingCost: { $sum: { $cond: ["$costMissing", 1, 0] } },
        fee: { $sum: "$fee" },
        missingFee: { $sum: { $cond: ["$feeMissing", 1, 0] } },
        estimatedDate: { $sum: { $cond: ["$estimated", 1, 0] } },
      },
    },
  ]);
  const out = new Map<Key, OrderAgg>();
  for (const r of rows) {
    const agg = out.get(r._id.k) ?? emptyOrderAgg();
    if (r._id.bdt) {
      Object.assign(agg, {
        revenue: agg.revenue + r.revenue,
        delivered: agg.delivered + r.delivered,
        productCost: agg.productCost + r.productCost,
        missingCost: agg.missingCost + r.missingCost,
        fee: agg.fee + r.fee,
        missingFee: agg.missingFee + r.missingFee,
        estimatedDate: agg.estimatedDate + r.estimatedDate,
      });
    } else {
      agg.nonBdt += r.delivered;
    }
    out.set(r._id.k, agg);
  }
  return out;
}

/** Courier fees paid on parcels that came back (rto), by return time. */
async function returnedOrderFees(merchantId: Types.ObjectId, p: Period, monthly: boolean) {
  const rows = await Order.aggregate<{ _id: Key; fee: number }>([
    { $match: { merchantId, "order.status": "rto", "logistics.courierFee": { $type: "number" } } },
    { $addFields: { _at: { $ifNull: ["$logistics.returnedAt", "$updatedAt"] } } },
    { $match: { _at: { $gte: p.start, $lt: p.end } } },
    { $match: { $expr: isBdt } },
    { $group: { _id: keyOf(monthly, "$_at"), fee: { $sum: "$logistics.courierFee" } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.fee]));
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
        pendingOrders: { $sum: { $cond: [{ $in: ["$order.status", OPEN_STATUSES] }, 1, 0] } },
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

interface PnL {
  revenue: number;
  deliveredOrders: number;
  otherIncome: number;
  productCostOrders: number;
  productCostManual: number;
  courierOrders: number;
  courierManual: number;
  advertising: number;
  office: number;
  salary: number;
  otherExpenses: number;
  ordersMissingCost: number;
  ordersMissingFee: number;
  estimatedDeliveryDates: number;
  nonBdtOrdersExcluded: number;
}

function pnlFor(orders: OrderAgg | undefined, rtoFee: number, entries: EntryRow[]): PnL {
  const o = orders ?? emptyOrderAgg();
  const sum = (bucket: FinanceBucket) =>
    entries.filter((e) => bucketOf(e.type, e.category) === bucket).reduce((s, e) => s + e.total, 0);
  return {
    revenue: o.revenue,
    deliveredOrders: o.delivered,
    otherIncome: sum("other_income"),
    productCostOrders: o.productCost,
    productCostManual: sum("product_cost"),
    courierOrders: o.fee + rtoFee,
    courierManual: sum("courier"),
    advertising: sum("advertising"),
    office: sum("office"),
    salary: sum("salary"),
    otherExpenses: sum("other_expense"),
    ordersMissingCost: o.missingCost,
    ordersMissingFee: o.missingFee,
    estimatedDeliveryDates: o.estimatedDate,
    nonBdtOrdersExcluded: o.nonBdt,
  };
}

function totals(p: PnL) {
  const productCost = p.productCostOrders + p.productCostManual;
  const courierCost = p.courierOrders + p.courierManual;
  const totalExpenses = productCost + courierCost + p.advertising + p.office + p.salary + p.otherExpenses;
  return { productCost, courierCost, totalExpenses, netProfit: p.revenue + p.otherIncome - totalExpenses };
}

export async function financeSummary(merchantId: Types.ObjectId, period: Period) {
  const [orders, rto, placed, entries] = await Promise.all([
    deliveredOrders(merchantId, period, false),
    returnedOrderFees(merchantId, period, false),
    placedOrders(merchantId, period),
    entryTotals(merchantId, period, false),
  ]);
  const p = pnlFor(orders.get("all"), rto.get("all") ?? 0, entries);
  const t = totals(p);

  const warnings: string[] = [];
  if (p.ordersMissingCost > 0) {
    warnings.push(`Product cost not recorded for ${p.ordersMissingCost} delivered order(s) — net profit does not include their cost.`);
  }
  if (p.ordersMissingFee > 0) {
    warnings.push(`Courier cost not recorded for ${p.ordersMissingFee} delivered order(s) — add it as a Courier expense if you know it.`);
  }
  if (p.nonBdtOrdersExcluded > 0) {
    warnings.push(`${p.nonBdtOrdersExcluded} delivered order(s) in another currency are not included (accounting is BDT only).`);
  }
  if (p.estimatedDeliveryDates > 0) {
    warnings.push(`${p.estimatedDeliveryDates} delivered order(s) have no recorded delivery time; their last update time is used.`);
  }

  return {
    period: { from: period.fromDay, to: period.toDay },
    currency: "BDT" as const,
    revenue: {
      realized: round2(p.revenue),
      deliveredOrders: p.deliveredOrders,
      pendingOrderValue: round2(placed.pending),
      pendingOrders: placed.pendingOrders,
      grossOrderValue: round2(placed.gross),
      grossOrders: placed.grossOrders,
    },
    otherIncome: round2(p.otherIncome),
    productCost: {
      fromOrders: round2(p.productCostOrders),
      manual: round2(p.productCostManual),
      total: round2(t.productCost),
      ordersMissingCost: p.ordersMissingCost,
      complete: p.ordersMissingCost === 0,
    },
    courierCost: {
      fromOrders: round2(p.courierOrders),
      manual: round2(p.courierManual),
      total: round2(t.courierCost),
      ordersMissingFee: p.ordersMissingFee,
      complete: p.ordersMissingFee === 0,
    },
    advertising: round2(p.advertising),
    office: round2(p.office),
    salary: round2(p.salary),
    otherExpenses: round2(p.otherExpenses),
    totalExpenses: round2(t.totalExpenses),
    netProfit: round2(t.netProfit),
    costComplete: p.ordersMissingCost === 0 && p.ordersMissingFee === 0,
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
    notes: { nonBdtOrdersExcluded: p.nonBdtOrdersExcluded, estimatedDeliveryDates: p.estimatedDeliveryDates },
  };
}

export async function financeMonthly(merchantId: Types.ObjectId, year: number, period: Period) {
  const [orders, rto, entries] = await Promise.all([
    deliveredOrders(merchantId, period, true),
    returnedOrderFees(merchantId, period, true),
    entryTotals(merchantId, period, true),
  ]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, "0")}`;
    const p = pnlFor(orders.get(month), rto.get(month) ?? 0, entries.filter((e) => e.k === month));
    const t = totals(p);
    return {
      month,
      revenue: round2(p.revenue),
      otherIncome: round2(p.otherIncome),
      productCost: round2(t.productCost),
      courierCost: round2(t.courierCost),
      advertising: round2(p.advertising),
      office: round2(p.office),
      salary: round2(p.salary),
      otherExpenses: round2(p.otherExpenses),
      expenses: round2(t.totalExpenses),
      netProfit: round2(t.netProfit),
      costComplete: p.ordersMissingCost === 0 && p.ordersMissingFee === 0,
    };
  });
  return { year, currency: "BDT" as const, months };
}
