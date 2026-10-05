import type { Types } from "mongoose";
import { DEFAULT_LOW_STOCK_THRESHOLD, InventoryMovement, Order, Product, productAvailableStock } from "@ecom/db";
import { dispatchNotification } from "./notifications.js";

/**
 * Merchant notifications driven by the stock ledger (lib/inventory.ts calls
 * these only AFTER its transaction committed, with the movements it wrote).
 *
 * Low / out of stock — per stock unit (a simple product, or one variant),
 * against the product's `lowStockThreshold`, the same rule as `stockStatusOf`:
 *   out  available went from > 0 to ≤ 0
 *   low  available went from > threshold to ≤ threshold (and is still > 0)
 * Each movement's before/after numbers come from the atomic update itself,
 * so concurrent orders can never both "cross" the same line.
 *
 * Re-arming: an alert fires once per crossing and is re-armed only by a
 * restock — an INITIAL_STOCK / RESTOCK / RETURNED / positive manual
 * adjustment that left available stock above the line. Units coming back
 * from a cancelled order do not re-arm it, so stock bouncing around the
 * threshold does not repeat the alert. The dedupe key names the restock
 * that armed it, so the Notification unique index makes this exactly-once
 * even under races.
 *
 * Best-effort: never throws into the stock change that triggered it.
 */

export interface StockChange {
  productId: Types.ObjectId;
  variantId?: Types.ObjectId;
  availableBefore: number;
  availableAfter: number;
  /** The ledger row that recorded this change. */
  movementId: Types.ObjectId;
  at: Date;
}

const ARMING_TYPES = ["INITIAL_STOCK", "RESTOCK", "RETURNED", "MANUAL_ADJUSTMENT"] as const;

export type StockAlertKind = "stock.low" | "stock.out";

/** Which line (if any) a change crossed. Pure. */
export function stockCrossing(c: Pick<StockChange, "availableBefore" | "availableAfter">, threshold: number): StockAlertKind | null {
  if (c.availableBefore > 0 && c.availableAfter <= 0) return "stock.out";
  if (c.availableBefore > threshold && c.availableAfter <= threshold) return "stock.low";
  return null;
}

export async function alertStockLevels(merchantId: Types.ObjectId, changes: readonly StockChange[]): Promise<void> {
  const falling = changes.filter((c) => c.availableAfter < c.availableBefore);
  if (falling.length === 0) return;
  try {
    const products = await Product.find({ _id: { $in: [...new Set(falling.map((c) => String(c.productId)))] }, merchantId })
      .select("name status lowStockThreshold variants._id variants.optionValues")
      .lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    for (const c of falling) {
      const p = byId.get(String(c.productId));
      if (!p || p.status === "archived") continue;
      const threshold = p.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
      const kind = stockCrossing(c, threshold);
      if (!kind) continue;
      const line = kind === "stock.out" ? 0 : threshold;
      const arming = await InventoryMovement.findOne({
        merchantId,
        productId: c.productId,
        variantId: c.variantId ?? null,
        type: { $in: [...ARMING_TYPES] },
        onHandDelta: { $gt: 0 },
        createdAt: { $lte: c.at },
        $expr: { $gt: [{ $subtract: ["$onHandAfter", "$reservedAfter"] }, line] },
      })
        .sort({ createdAt: -1, _id: -1 })
        .select("_id")
        .lean();
      const variant = c.variantId ? p.variants?.find((v) => String(v._id) === String(c.variantId)) : undefined;
      const label = variant ? (variant.optionValues ?? []).join(" / ") : "";
      const name = `${p.name}${label ? ` — ${label}` : ""}`;
      const unit = `${String(c.productId)}${c.variantId ? `:${String(c.variantId)}` : ""}`;
      const available = Math.max(0, c.availableAfter);
      await dispatchNotification({
        merchantId,
        kind,
        severity: kind === "stock.out" ? "critical" : "warning",
        skipSms: true,
        title: kind === "stock.out" ? `Out of stock: ${name}` : `Low stock: ${name}`,
        body:
          kind === "stock.out"
            ? "No units available to sell. Restock to keep selling."
            : `${available} available — at or below your alert level of ${threshold}. Restock soon.`,
        link: `/dashboard/products?stock=${String(c.productId)}`,
        subjectType: "product",
        subjectId: c.productId,
        dedupeKey: `${kind === "stock.out" ? "stock_out" : "stock_low"}:${unit}:${arming ? String(arming._id) : "none"}`,
        meta: { available, threshold, ...(c.variantId ? { variantId: String(c.variantId) } : {}) },
      });
    }
  } catch (err) {
    console.error(JSON.stringify({ evt: "inventory.stock_alert_failed", error: (err as Error).message?.slice(0, 200) }));
  }
}

/**
 * The order is kept, but its stock could not be reserved (or, for a
 * delivered order, taken off on-hand). `note` is the inventory note
 * ("<code>:<productId>"). One notification per order, reservation cycle and
 * stock target.
 */
export async function notifyOrderStockIssue(args: {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
  cycle: number;
  target: "reserved" | "fulfilled";
  note: string;
}): Promise<void> {
  try {
    const [code, productId] = args.note.split(":");
    const order = await Order.findOne({ _id: args.orderId, merchantId: args.merchantId }).select("orderNumber").lean();
    const product =
      productId && /^[a-f0-9]{24}$/.test(productId)
        ? await Product.findOne({ _id: productId, merchantId: args.merchantId }).select("name inventory variants.inventory variants.status lowStockThreshold").lean()
        : null;
    const number = order?.orderNumber ?? String(args.orderId).slice(-6);
    const what = product ? product.name : "A product on this order";
    let body: string;
    if (code === "product_not_found") {
      body = "A product on this order is no longer in your catalogue, so its stock could not be moved.";
    } else if (args.target === "fulfilled") {
      body = `${what}: the delivered units could not be taken off your stock (not enough units on hand). Check its stock count.`;
    } else {
      const avail = product ? ` (${productAvailableStock(product)} available)` : "";
      body = `${what} does not have enough stock for this order${avail}. The order was kept — restock and it is reserved automatically, or cancel it.`;
    }
    await dispatchNotification({
      merchantId: args.merchantId,
      kind: "order.stock_issue",
      severity: "warning",
      title: args.target === "fulfilled" ? `Stock not deducted for order ${number}` : `Not enough stock for order ${number}`,
      body,
      link: `/dashboard/orders?focus=${String(args.orderId)}`,
      subjectType: "order",
      subjectId: args.orderId,
      dedupeKey: `stock_issue:${String(args.orderId)}:${args.cycle}:${args.target}`,
      meta: { note: args.note },
    });
  } catch (err) {
    console.error(JSON.stringify({ evt: "inventory.stock_issue_notify_failed", orderId: String(args.orderId), error: (err as Error).message?.slice(0, 200) }));
  }
}
