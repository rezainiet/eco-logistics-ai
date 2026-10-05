import mongoose, { type ClientSession, Types } from "mongoose";
import { InventoryMovement, type InventoryMovementType, Order, Product } from "@ecom/db";
import { alertStockLevels, notifyOrderStockIssue, type StockChange } from "./inventory-alerts.js";

/**
 * Inventory — the only code that changes `Product.inventory`.
 *
 * Every change is ONE conditional atomic update (`findOneAndUpdate` whose
 * filter re-checks the invariants against the live document) plus ONE
 * `InventoryMovement` row, in the same transaction. Stock is never read
 * and then written back, so two buyers racing for the last unit cannot
 * both win: the second update's filter no longer matches (or the
 * transaction hits a write conflict, is retried, and then no longer
 * matches).
 *
 * Invariants enforced by every update:
 *   onHand ≥ 0,  reserved ≥ 0,  onHand − reserved (available) ≥ 0
 *
 * Order-driven movements carry a key "<orderId>:<cycle>:<type>:<productId>"
 * (plus ":<variantId>" for a variant line) that is unique per merchant, so
 * replays (webhook retries, double clicks, a second status write) can never
 * apply the same movement twice.
 *
 * Products with variants keep stock per variant: the same guards and ledger
 * apply to the one variant (`variantId`), updated in place inside the
 * product document.
 *
 * Every committed change is handed to lib/inventory-alerts.ts AFTER its
 * transaction commits (low / out-of-stock alerts); a rolled-back attempt
 * never alerts. Stock movements never touch the finance ledger.
 */

export type InventoryErrorCode = "insufficient_stock" | "product_not_found" | "below_reserved" | "invalid_quantity";

export class InventoryError extends Error {
  constructor(
    readonly code: InventoryErrorCode,
    readonly productId?: string,
  ) {
    super(code);
    this.name = "InventoryError";
  }
}

interface Delta {
  merchantId: Types.ObjectId;
  productId: Types.ObjectId;
  /** Set for a product with variants: the variant whose stock moves. */
  variantId?: Types.ObjectId;
  onHandDelta: number;
  reservedDelta: number;
  type: InventoryMovementType;
  orderId?: Types.ObjectId;
  key?: string;
  reason?: string;
  actorId?: Types.ObjectId;
  actorType?: "merchant" | "system" | "customer";
  /** Reservations: only against an active product. */
  requireActive?: boolean;
}

/**
 * Applies one delta; when `changes` is given, appends what it did to stock
 * availability (exact before/after from the atomic update) for the
 * post-commit alerts.
 */
async function applyDelta(d: Delta, session: ClientSession, changes?: StockChange[]) {
  const after = await applyDeltaOnly(d, session);
  const movement = await recordMovement(d, after, session);
  changes?.push({
    productId: d.productId,
    ...(d.variantId ? { variantId: d.variantId } : {}),
    availableBefore: after.onHand - d.onHandDelta - (after.reserved - d.reservedDelta),
    availableAfter: after.onHand - after.reserved,
    movementId: movement._id,
    at: movement.createdAt,
  });
  return after;
}

async function applyDeltaOnly(d: Delta, session: ClientSession) {
  if (d.variantId) return applyVariantDelta(d as Delta & { variantId: Types.ObjectId }, session);
  const onHand = { $add: ["$inventory.onHand", d.onHandDelta] };
  const reserved = { $add: ["$inventory.reserved", d.reservedDelta] };
  const updated = await Product.findOneAndUpdate(
    {
      _id: d.productId,
      merchantId: d.merchantId,
      ...(d.requireActive ? { status: "active" } : {}),
      $expr: {
        $and: [{ $gte: [onHand, 0] }, { $gte: [reserved, 0] }, { $gte: [{ $subtract: [onHand, reserved] }, 0] }],
      },
    },
    { $inc: { "inventory.onHand": d.onHandDelta, "inventory.reserved": d.reservedDelta } },
    { new: true, session, projection: { inventory: 1 } },
  ).lean();
  if (!updated) {
    const exists = await Product.exists({ _id: d.productId, merchantId: d.merchantId }).session(session);
    if (!exists) throw new InventoryError("product_not_found", String(d.productId));
    throw new InventoryError(d.reservedDelta > 0 ? "insufficient_stock" : "below_reserved", String(d.productId));
  }
  return updated.inventory;
}

/**
 * Same guarantees for one variant: the filter re-checks the invariants on
 * THAT variant (and that it exists, belongs to this merchant's product and —
 * for reservations — that product and variant are active); the update
 * increments only that variant's numbers.
 */
async function applyVariantDelta(d: Delta & { variantId: Types.ObjectId }, session: ClientSession) {
  const v = { $arrayElemAt: [{ $filter: { input: { $ifNull: ["$variants", []] }, as: "x", cond: { $eq: ["$$x._id", d.variantId] } } }, 0] };
  const onHand = { $add: ["$$v.inventory.onHand", d.onHandDelta] };
  const reserved = { $add: ["$$v.inventory.reserved", d.reservedDelta] };
  const updated = await Product.findOneAndUpdate(
    {
      _id: d.productId,
      merchantId: d.merchantId,
      variants: { $elemMatch: { _id: d.variantId, ...(d.requireActive ? { status: "active" } : {}) } },
      ...(d.requireActive ? { status: "active" } : {}),
      $expr: {
        $let: {
          vars: { v },
          in: { $and: [{ $gte: [onHand, 0] }, { $gte: [reserved, 0] }, { $gte: [{ $subtract: [onHand, reserved] }, 0] }] },
        },
      },
    },
    { $inc: { "variants.$[v].inventory.onHand": d.onHandDelta, "variants.$[v].inventory.reserved": d.reservedDelta } },
    { new: true, session, projection: { variants: 1 }, arrayFilters: [{ "v._id": d.variantId }] },
  ).lean();
  const after = updated?.variants?.find((x) => String(x._id) === String(d.variantId))?.inventory;
  if (!updated || !after) {
    const exists = await Product.exists({ _id: d.productId, merchantId: d.merchantId, "variants._id": d.variantId }).session(session);
    if (!exists) throw new InventoryError("product_not_found", String(d.productId));
    throw new InventoryError(d.reservedDelta > 0 ? "insufficient_stock" : "below_reserved", String(d.productId));
  }
  return after;
}

async function recordMovement(d: Delta, after: { onHand: number; reserved: number }, session: ClientSession) {
  const [row] = await InventoryMovement.create(
    [
      {
        merchantId: d.merchantId,
        productId: d.productId,
        type: d.type,
        onHandDelta: d.onHandDelta,
        reservedDelta: d.reservedDelta,
        onHandAfter: after.onHand,
        reservedAfter: after.reserved,
        ...(d.variantId ? { variantId: d.variantId } : {}),
        ...(d.orderId ? { orderId: d.orderId } : {}),
        ...(d.key ? { key: d.key } : {}),
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.actorId ? { actorId: d.actorId } : {}),
        actorType: d.actorType ?? "system",
      },
    ],
    { session },
  );
  return row!;
}

/** Runs `fn` in a transaction (retried by the driver on transient conflicts). */
export async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let out: T | undefined;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out as T;
  } finally {
    await session.endSession();
  }
}

export type StockAdjustmentType = "INITIAL_STOCK" | "RESTOCK" | "MANUAL_ADJUSTMENT" | "RETURNED";

/**
 * Merchant stock change. `delta` is signed; on-hand can never drop below
 * what open orders have reserved.
 */
export async function adjustStock(input: {
  merchantId: Types.ObjectId;
  productId: Types.ObjectId;
  /** Required for a product with variants: the variant to adjust. */
  variantId?: Types.ObjectId;
  type: StockAdjustmentType;
  delta: number;
  reason?: string;
  actorId?: Types.ObjectId;
}) {
  if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 1_000_000) {
    throw new InventoryError("invalid_quantity");
  }
  if (input.type !== "MANUAL_ADJUSTMENT" && input.delta < 0) throw new InventoryError("invalid_quantity");
  const { inventory, changes } = await inTransaction(async (session) => {
    const changes: StockChange[] = [];
    const inventory = await applyDelta(
      {
        merchantId: input.merchantId,
        productId: input.productId,
        ...(input.variantId ? { variantId: input.variantId } : {}),
        onHandDelta: input.delta,
        reservedDelta: 0,
        type: input.type,
        reason: input.reason,
        actorId: input.actorId,
        actorType: input.actorId ? "merchant" : "system",
      },
      session,
      changes,
    );
    return { inventory, changes };
  });
  await alertStockLevels(input.merchantId, changes);
  // New units: orders kept while short of this product get their stock now.
  if (input.delta > 0) await reserveWaitingOrders(input.merchantId, input.productId);
  return inventory;
}

/** Most orders retried per restock (oldest first); the rest wait for the next one. */
const WAITING_RETRY_LIMIT = 25;

/**
 * After a restock: open orders that were kept without stock (inventory
 * released with an "insufficient_stock" note) and hold this product try to
 * reserve again, oldest first, through the normal reconcile path — so each
 * reservation is the same guarded, idempotent move as any other. An order
 * that still does not fit keeps its note.
 */
export async function reserveWaitingOrders(merchantId: Types.ObjectId, productId: Types.ObjectId): Promise<number> {
  let reserved = 0;
  try {
    const waiting = await Order.find({
      merchantId,
      "items.productId": productId,
      "inventory.state": "released",
      "inventory.note": { $regex: /^insufficient_stock/ },
      "order.status": { $nin: [...CLOSED_FOR_STOCK] },
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(WAITING_RETRY_LIMIT)
      .select("_id")
      .lean();
    for (const o of waiting) {
      const r = await reconcileOrderInventory(o._id);
      if (r.changed && r.to === "reserved") reserved += 1;
    }
  } catch (err) {
    console.error(JSON.stringify({ evt: "inventory.waiting_retry_failed", productId: String(productId), error: (err as Error).message?.slice(0, 200) }));
  }
  return reserved;
}

type OrderLine = { productId?: unknown; variantId?: unknown; quantity: number };
export type StockLine = { productId: Types.ObjectId; variantId?: Types.ObjectId; quantity: number };

/**
 * Sums quantities per stock-keeping unit — a catalog product, or one
 * variant of it; lines without a productId hold no stock.
 */
export function stockLines(items: ReadonlyArray<OrderLine>): StockLine[] {
  const byKey = new Map<string, { productId: string; variantId?: string; quantity: number }>();
  for (const it of items) {
    if (!it.productId) continue;
    const productId = String(it.productId);
    const variantId = it.variantId ? String(it.variantId) : undefined;
    const key = variantId ? `${productId}:${variantId}` : productId;
    const cur = byKey.get(key) ?? { productId, variantId, quantity: 0 };
    cur.quantity += it.quantity;
    byKey.set(key, cur);
  }
  return [...byKey.values()].map((l) => ({
    productId: new Types.ObjectId(l.productId),
    ...(l.variantId ? { variantId: new Types.ObjectId(l.variantId) } : {}),
    quantity: l.quantity,
  }));
}

/** Simple-product keys are unchanged from before variants existed; variant lines add ":<variantId>". */
const movementKey = (orderId: Types.ObjectId, cycle: number, type: InventoryMovementType, line: StockLine) =>
  `${orderId}:${cycle}:${type}:${line.productId}${line.variantId ? `:${line.variantId}` : ""}`;

/**
 * Reserve stock for a new order, inside the caller's transaction (the same
 * one that inserts the order). Throws InventoryError("insufficient_stock")
 * naming the product when any line cannot be covered — the caller's
 * transaction then aborts, so nothing is half-reserved.
 *
 * Returns the stock changes; the caller passes them to `alertStockLevels`
 * once its transaction has committed.
 */
export async function reserveOrderStock(
  session: ClientSession,
  args: { merchantId: Types.ObjectId; orderId: Types.ObjectId; items: ReadonlyArray<OrderLine>; cycle?: number },
): Promise<StockChange[]> {
  const cycle = args.cycle ?? 1;
  const changes: StockChange[] = [];
  for (const line of stockLines(args.items)) {
    await applyDelta(
      {
        merchantId: args.merchantId,
        productId: line.productId,
        ...(line.variantId ? { variantId: line.variantId } : {}),
        onHandDelta: 0,
        reservedDelta: line.quantity,
        type: "ORDER_RESERVED",
        orderId: args.orderId,
        key: movementKey(args.orderId, cycle, "ORDER_RESERVED", line),
        requireActive: true,
        actorType: "customer",
      },
      session,
      changes,
    );
  }
  return changes;
}

type InventoryState = "reserved" | "released" | "fulfilled";

/** Statuses whose order holds no reservation (released, or consumed by delivery). */
const CLOSED_FOR_STOCK = ["cancelled", "rto", "delivered"] as const;

/** Where an order's stock should be, given its status. */
export function targetInventoryState(status: string): InventoryState {
  if (status === "cancelled" || status === "rto") return "released";
  if (status === "delivered") return "fulfilled";
  return "reserved";
}

export interface ReserveNewOrderResult {
  /** True when this call reserved the order's stock. */
  reserved: boolean;
  /** Set when stock was short: the order was kept, its inventory released with this note. */
  note?: string;
}

/**
 * First reservation for an order created OUTSIDE a landing page (dashboard,
 * CSV, Shopify, WooCommerce, custom API) — called right after the order is
 * committed, for lines the catalogue link resolved (lib/commerce/catalog-link.ts).
 *
 * Unlike a landing checkout, a short stock never rejects the order (it was
 * already placed elsewhere): the order is kept, its inventory is recorded
 * as released with an "insufficient_stock:<productId>" note, the merchant
 * is notified, and a later restock reserves it (`reserveWaitingOrders`).
 *
 * Idempotent and race-safe: the order's inventory is claimed with a
 * compare-and-set (only an order with no inventory yet, still open) in the
 * same transaction as the guarded stock updates and their unique movement
 * keys, so a retry, replay or concurrent call can never reserve twice, and
 * an order cancelled meanwhile is never reserved. No-op for orders without
 * catalogue lines.
 */
export async function reserveNewOrderStock(orderId: Types.ObjectId | string): Promise<ReserveNewOrderResult> {
  const id = new Types.ObjectId(String(orderId));
  const order = await Order.findById(id).select("merchantId items order.status inventory").lean();
  if (!order || order.inventory) return { reserved: false };
  const lines = stockLines(order.items as OrderLine[]);
  if (lines.length === 0 || targetInventoryState(order.order.status) !== "reserved") return { reserved: false };
  const merchantId = order.merchantId as Types.ObjectId;
  try {
    const changes = await inTransaction(async (session) => {
      const local: StockChange[] = [];
      const claim = await Order.updateOne(
        { _id: id, merchantId, inventory: { $exists: false }, "order.status": { $nin: [...CLOSED_FOR_STOCK] } },
        { $set: { inventory: { state: "reserved", cycle: 1, reservedAt: new Date() } } },
        { session },
      );
      if (claim.modifiedCount !== 1) throw new Superseded();
      for (const line of lines) {
        await applyDelta(
          {
            merchantId,
            productId: line.productId,
            ...(line.variantId ? { variantId: line.variantId } : {}),
            onHandDelta: 0,
            reservedDelta: line.quantity,
            type: "ORDER_RESERVED",
            orderId: id,
            key: movementKey(id, 1, "ORDER_RESERVED", line),
            actorType: "system",
          },
          session,
          local,
        );
      }
      return local;
    });
    await alertStockLevels(merchantId, changes);
    return { reserved: true };
  } catch (err) {
    if (err instanceof Superseded) return { reserved: false };
    if ((err as { code?: number })?.code === 11000) return { reserved: false };
    if (!(err instanceof InventoryError)) throw err;
    // Short (or the product is gone): keep the order, say why, tell the merchant.
    const note = `${err.code}${err.productId ? `:${err.productId}` : ""}`;
    const kept = await Order.updateOne(
      { _id: id, merchantId, inventory: { $exists: false } },
      { $set: { inventory: { state: "released", cycle: 1, note } } },
    );
    if (kept.modifiedCount === 1) await notifyOrderStockIssue({ merchantId, orderId: id, cycle: 1, target: "reserved", note });
    return { reserved: false, note };
  }
}

/** Fire-safe wrapper for order-creation paths: stock never fails an order. */
export async function reserveNewOrdersStock(orderIds: ReadonlyArray<Types.ObjectId | string>): Promise<void> {
  for (const id of orderIds) {
    try {
      await reserveNewOrderStock(id);
    } catch (err) {
      console.error(JSON.stringify({ evt: "inventory.reserve_new_failed", orderId: String(id), error: (err as Error).message?.slice(0, 200) }));
    }
  }
}

export interface ReconcileResult {
  changed: boolean;
  from?: InventoryState;
  to?: InventoryState;
  note?: string;
}

class Superseded extends Error {}

/**
 * Brings an order's stock in line with its status. Idempotent and safe to
 * call from every status writer, any number of times, concurrently:
 *   - the order's inventory state is moved with a compare-and-set in the
 *     same transaction as the stock updates, so only one caller applies a
 *     transition;
 *   - movement keys are unique, so a transition can never be booked twice.
 * No-op for orders without catalog items. A delivered order's stock is
 * final: returns after delivery are booked by the merchant (RETURNED).
 *
 * @param opts.release  force a release (the order is about to be deleted).
 */
export async function reconcileOrderInventory(
  orderId: Types.ObjectId | string,
  opts: { release?: boolean } = {},
): Promise<ReconcileResult> {
  const id = new Types.ObjectId(String(orderId));
  const order = await Order.findById(id).select("merchantId items order.status inventory").lean();
  if (!order?.inventory) return { changed: false };
  const from = order.inventory.state as InventoryState;
  const to: InventoryState = opts.release ? "released" : targetInventoryState(order.order.status);
  if (from === to || from === "fulfilled") return { changed: false, from };

  const lines = stockLines(order.items as OrderLine[]);
  const merchantId = order.merchantId as Types.ObjectId;
  const cycle = order.inventory.cycle ?? 1;
  const nextCycle = from === "released" && to === "reserved" ? cycle + 1 : cycle;
  const now = new Date();
  const stamp = to === "reserved" ? "reservedAt" : to === "released" ? "releasedAt" : "fulfilledAt";

  let changes: StockChange[] = [];
  try {
    changes = await inTransaction(async (session) => {
      const local: StockChange[] = [];
      const cas = await Order.updateOne(
        { _id: id, merchantId, "inventory.state": from, "inventory.cycle": cycle },
        { $set: { "inventory.state": to, "inventory.cycle": nextCycle, [`inventory.${stamp}`]: now }, $unset: { "inventory.note": "" } },
        { session },
      );
      if (cas.modifiedCount !== 1) throw new Superseded();
      for (const line of lines) {
        const base = { merchantId, productId: line.productId, ...(line.variantId ? { variantId: line.variantId } : {}), orderId: id };
        if (to === "released") {
          const type: InventoryMovementType = order.order.status === "rto" ? "RETURNED" : "ORDER_CANCELLED";
          await applyDelta(
            { ...base, onHandDelta: 0, reservedDelta: -line.quantity, type, key: movementKey(id, cycle, "ORDER_CANCELLED", line) },
            session,
            local,
          );
        } else if (to === "fulfilled") {
          // From "reserved": the reservation becomes a shipment. From
          // "released" (delivered after a cancellation): the goods still left.
          await applyDelta(
            {
              ...base,
              onHandDelta: -line.quantity,
              reservedDelta: from === "reserved" ? -line.quantity : 0,
              type: "ORDER_FULFILLED",
              key: movementKey(id, cycle, "ORDER_FULFILLED", line),
            },
            session,
            local,
          );
        } else {
          await applyDelta(
            {
              ...base,
              onHandDelta: 0,
              reservedDelta: line.quantity,
              type: "ORDER_RESERVED",
              key: movementKey(id, nextCycle, "ORDER_RESERVED", line),
            },
            session,
            local,
          );
        }
      }
      return local;
    });
  } catch (err) {
    if (err instanceof Superseded) return { changed: false, from };
    if (err instanceof InventoryError) {
      // Not enough stock to re-reserve / ship: leave the state as it was
      // and record why, for the merchant.
      const note = `${err.code}${err.productId ? `:${err.productId}` : ""}`;
      await Order.updateOne({ _id: id, "inventory.state": from }, { $set: { "inventory.note": note } });
      if (to !== "released") await notifyOrderStockIssue({ merchantId, orderId: id, cycle, target: to, note });
      return { changed: false, from, note };
    }
    if ((err as { code?: number })?.code === 11000) return { changed: false, from };
    throw err;
  }
  await alertStockLevels(merchantId, changes);
  return { changed: true, from, to };
}

/**
 * Fire-and-forget wrapper for status writers: the status change has
 * already happened; stock follows. Failures are logged, never thrown into
 * the caller's response.
 */
export async function syncOrderInventory(orderIds: ReadonlyArray<Types.ObjectId | string>): Promise<void> {
  for (const id of orderIds) {
    try {
      await reconcileOrderInventory(id);
    } catch (err) {
      console.error(
        JSON.stringify({ evt: "inventory.reconcile_failed", orderId: String(id), error: (err as Error).message?.slice(0, 200) }),
      );
    }
  }
}
