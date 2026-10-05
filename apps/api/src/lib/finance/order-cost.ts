import { Types } from "mongoose";
import { Order } from "@ecom/db";
import { findSkuCandidates, lineSku } from "../commerce/sku-match.js";
import type { Period } from "./period.js";
import { IS_BDT_ORDER } from "./report.js";

/**
 * Order-level cost & profit.
 *
 * COST SNAPSHOT: an order item's `unitCost` is written ONCE, when the order
 * is created, from the product's cost at that moment; nothing rewrites it
 * later (a product cost change applies to new orders only, and existing
 * orders are never back-filled). Landing-page orders snapshot it from the
 * linked product. Orders created from the dashboard or a store integration
 * have their items matched by SKU to the merchant's catalogue
 * (lib/commerce/sku-match.ts), and only an unambiguous match (exactly one
 * product or variant with that SKU, with a recorded cost) is snapshotted.
 * Everything else stays "cost not recorded" — never 0. (The same SKU rule
 * links those lines to the catalogue for stock: lib/commerce/catalog-link.ts.)
 */

interface CostableItem {
  sku?: string | null;
  quantity?: number;
  unitCost?: number | null;
}

/** Fill `unitCost` on items that lack one, from an unambiguous SKU match in this merchant's catalogue. */
export async function snapshotItemCosts<T extends CostableItem>(merchantId: Types.ObjectId, items: T[]): Promise<T[]> {
  const skus = items.filter((i) => typeof i.unitCost !== "number").map(lineSku).filter((s): s is string => s !== null);
  if (skus.length === 0) return items;
  // Shared exact-SKU rule; a variant without its own cost uses the product's.
  const matches = await findSkuCandidates(merchantId, skus);
  return items.map((i) => {
    const sku = lineSku(i);
    if (typeof i.unitCost === "number" || sku === null) return i;
    const found = matches.get(sku);
    // Ambiguous (several products/variants share the SKU) or no recorded cost: leave unrecorded.
    if (!found || found.length !== 1 || found[0]!.cost === null) return i;
    return { ...i, unitCost: found[0]!.cost };
  });
}

interface ProfitOrderLike {
  order?: { status?: string | null; total?: number | null; currency?: string | null } | null;
  items?: Array<{ quantity?: number | null; unitCost?: number | null }> | null;
  logistics?: { courierFee?: number | null } | null;
}

/**
 * One order's profit under the Accounting rules:
 *   delivered → revenue (order total) − product cost − courier fee
 *   rto       → − courier fee (no revenue, the product came back)
 *   anything else (open, cancelled) → not realized: no revenue, no cost yet
 * A missing cost makes `profit` null (with the reason) — never computed as 0.
 */
type MissingCost = "product_cost" | "courier_fee";

export function orderProfitOf(o: ProfitOrderLike): {
  realized: boolean;
  status: string;
  revenue: number;
  productCost: number | null;
  courierFee: number | null;
  profit: number | null;
  missing: MissingCost[];
} {
  const status = o.order?.status ?? "pending";
  const items = o.items ?? [];
  const costMissing = items.some((i) => typeof i.unitCost !== "number");
  const productCost = items.reduce((s, i) => s + (typeof i.unitCost === "number" ? i.unitCost * (i.quantity ?? 0) : 0), 0);
  const fee = typeof o.logistics?.courierFee === "number" ? o.logistics.courierFee : null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (status === "delivered") {
    const revenue = o.order?.total ?? 0;
    const missing: MissingCost[] = [...(costMissing ? (["product_cost"] as const) : []), ...(fee === null ? (["courier_fee"] as const) : [])];
    return {
      realized: true,
      status,
      revenue: r2(revenue),
      productCost: costMissing ? null : r2(productCost),
      courierFee: fee,
      profit: missing.length ? null : r2(revenue - productCost - (fee ?? 0)),
      missing,
    };
  }
  if (status === "rto") {
    return {
      realized: true,
      status,
      revenue: 0,
      productCost: 0,
      courierFee: fee,
      profit: fee === null ? null : r2(-fee),
      missing: fee === null ? ["courier_fee"] : [],
    };
  }
  return { realized: false, status, revenue: 0, productCost: null, courierFee: fee, profit: null, missing: [] };
}

/** Cursor over (date DESC, _id DESC): opaque base64url JSON. */
function encodeCursor(at: Date, id: Types.ObjectId): string {
  return Buffer.from(JSON.stringify({ t: at.getTime(), id: String(id) }), "utf8").toString("base64url");
}
function decodeCursor(raw: string): { t: number; id: string } | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    return typeof c.t === "number" && typeof c.id === "string" && /^[a-f0-9]{24}$/.test(c.id) ? { t: c.t, id: c.id } : null;
  } catch {
    return null;
  }
}

/**
 * Orders that are revenue or cost in the period (delivered, dated by
 * delivery; returned, dated by return — the same dating as the P&L), with
 * their profit. `missingOnly` lists those whose profit can't be known yet.
 */
export async function orderProfitList(
  merchantId: Types.ObjectId,
  p: Period,
  opts: { missingOnly?: boolean; limit?: number; cursor?: string | null } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const missingExpr = {
    $or: [
      { $not: [{ $isNumber: "$logistics.courierFee" }] },
      {
        $and: [
          { $eq: ["$order.status", "delivered"] },
          { $anyElementTrue: [{ $map: { input: "$items", as: "i", in: { $not: [{ $isNumber: "$$i.unitCost" }] } } }] },
        ],
      },
    ],
  };
  const rows = await Order.aggregate<{
    _id: Types.ObjectId;
    _at: Date;
    orderNumber: string;
    customer: { name?: string };
    order: { status: string; total?: number; currency?: string };
    items: Array<{ quantity?: number; unitCost?: number }>;
    logistics?: { courierFee?: number };
    attribution?: { lastTouch?: { channel?: string } };
    source?: { channel?: string };
  }>([
    { $match: { merchantId, "order.status": { $in: ["delivered", "rto"] } } },
    {
      $addFields: {
        _at: {
          $cond: [
            { $eq: ["$order.status", "delivered"] },
            { $ifNull: ["$logistics.deliveredAt", "$updatedAt"] },
            { $ifNull: ["$logistics.returnedAt", "$updatedAt"] },
          ],
        },
      },
    },
    { $match: { _at: { $gte: p.start, $lt: p.end } } },
    { $match: { $expr: IS_BDT_ORDER } },
    ...(opts.missingOnly ? [{ $match: { $expr: missingExpr } }] : []),
    ...(cursor
      ? [
          {
            $match: {
              $or: [{ _at: { $lt: new Date(cursor.t) } }, { _at: new Date(cursor.t), _id: { $lt: new Types.ObjectId(cursor.id) } }],
            },
          },
        ]
      : []),
    { $sort: { _at: -1, _id: -1 } },
    { $limit: limit + 1 },
    { $project: { _at: 1, orderNumber: 1, "customer.name": 1, order: 1, items: 1, "logistics.courierFee": 1, "attribution.lastTouch.channel": 1, "source.channel": 1 } },
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((o) => ({
      id: String(o._id),
      orderNumber: o.orderNumber,
      customerName: o.customer?.name ?? "",
      at: o._at,
      channel: o.attribution?.lastTouch?.channel ?? (o.source?.channel === "landing_page" ? "direct" : "untracked"),
      ...orderProfitOf(o),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last._at, last._id) : null,
  };
}
