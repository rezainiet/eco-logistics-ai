import mongoose, { type ClientSession, Types } from "mongoose";
import { InventoryMovement, type InventoryMovementType, Order, Product } from "@ecom/db";

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
 * that is unique per merchant, so replays (webhook retries, double
 * clicks, a second status write) can never apply the same movement twice.
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

async function applyDelta(d: Delta, session: ClientSession) {
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
  await InventoryMovement.create(
    [
      {
        merchantId: d.merchantId,
        productId: d.productId,
        type: d.type,
        onHandDelta: d.onHandDelta,
        reservedDelta: d.reservedDelta,
        onHandAfter: updated.inventory.onHand,
        reservedAfter: updated.inventory.reserved,
        ...(d.orderId ? { orderId: d.orderId } : {}),
        ...(d.key ? { key: d.key } : {}),
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.actorId ? { actorId: d.actorId } : {}),
        actorType: d.actorType ?? "system",
      },
    ],
    { session },
  );
  return updated.inventory;
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
  type: StockAdjustmentType;
  delta: number;
  reason?: string;
  actorId?: Types.ObjectId;
}) {
  if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 1_000_000) {
    throw new InventoryError("invalid_quantity");
  }
  if (input.type !== "MANUAL_ADJUSTMENT" && input.delta < 0) throw new InventoryError("invalid_quantity");
  return inTransaction((session) =>
    applyDelta(
      {
        merchantId: input.merchantId,
        productId: input.productId,
        onHandDelta: input.delta,
        reservedDelta: 0,
        type: input.type,
        reason: input.reason,
        actorId: input.actorId,
        actorType: input.actorId ? "merchant" : "system",
      },
      session,
    ),
  );
}

type OrderLine = { productId?: unknown; quantity: number };

/** Sums quantities per catalog product; lines without a productId hold no stock. */
export function stockLines(items: ReadonlyArray<OrderLine>): Array<{ productId: Types.ObjectId; quantity: number }> {
  const byId = new Map<string, number>();
  for (const it of items) {
    if (!it.productId) continue;
    const id = String(it.productId);
    byId.set(id, (byId.get(id) ?? 0) + it.quantity);
  }
  return [...byId].map(([id, quantity]) => ({ productId: new Types.ObjectId(id), quantity }));
}

const movementKey = (orderId: Types.ObjectId, cycle: number, type: InventoryMovementType, productId: Types.ObjectId) =>
  `${orderId}:${cycle}:${type}:${productId}`;

/**
 * Reserve stock for a new order, inside the caller's transaction (the same
 * one that inserts the order). Throws InventoryError("insufficient_stock")
 * naming the product when any line cannot be covered — the caller's
 * transaction then aborts, so nothing is half-reserved.
 */
export async function reserveOrderStock(
  session: ClientSession,
  args: { merchantId: Types.ObjectId; orderId: Types.ObjectId; items: ReadonlyArray<OrderLine>; cycle?: number },
): Promise<void> {
  const cycle = args.cycle ?? 1;
  for (const line of stockLines(args.items)) {
    await applyDelta(
      {
        merchantId: args.merchantId,
        productId: line.productId,
        onHandDelta: 0,
        reservedDelta: line.quantity,
        type: "ORDER_RESERVED",
        orderId: args.orderId,
        key: movementKey(args.orderId, cycle, "ORDER_RESERVED", line.productId),
        requireActive: true,
        actorType: "customer",
      },
      session,
    );
  }
}

type InventoryState = "reserved" | "released" | "fulfilled";

/** Where an order's stock should be, given its status. */
export function targetInventoryState(status: string): InventoryState {
  if (status === "cancelled" || status === "rto") return "released";
  if (status === "delivered") return "fulfilled";
  return "reserved";
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

  try {
    await inTransaction(async (session) => {
      const cas = await Order.updateOne(
        { _id: id, merchantId, "inventory.state": from, "inventory.cycle": cycle },
        { $set: { "inventory.state": to, "inventory.cycle": nextCycle, [`inventory.${stamp}`]: now }, $unset: { "inventory.note": "" } },
        { session },
      );
      if (cas.modifiedCount !== 1) throw new Superseded();
      for (const line of lines) {
        const base = { merchantId, productId: line.productId, orderId: id };
        if (to === "released") {
          const type: InventoryMovementType = order.order.status === "rto" ? "RETURNED" : "ORDER_CANCELLED";
          await applyDelta(
            { ...base, onHandDelta: 0, reservedDelta: -line.quantity, type, key: movementKey(id, cycle, "ORDER_CANCELLED", line.productId) },
            session,
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
              key: movementKey(id, cycle, "ORDER_FULFILLED", line.productId),
            },
            session,
          );
        } else {
          await applyDelta(
            {
              ...base,
              onHandDelta: 0,
              reservedDelta: line.quantity,
              type: "ORDER_RESERVED",
              key: movementKey(id, nextCycle, "ORDER_RESERVED", line.productId),
            },
            session,
          );
        }
      }
    });
  } catch (err) {
    if (err instanceof Superseded) return { changed: false, from };
    if (err instanceof InventoryError) {
      // Not enough stock to re-reserve / ship: leave the state as it was
      // and record why, for the merchant.
      const note = `${err.code}${err.productId ? `:${err.productId}` : ""}`;
      await Order.updateOne({ _id: id, "inventory.state": from }, { $set: { "inventory.note": note } });
      return { changed: false, from, note };
    }
    if ((err as { code?: number })?.code === 11000) return { changed: false, from };
    throw err;
  }
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
