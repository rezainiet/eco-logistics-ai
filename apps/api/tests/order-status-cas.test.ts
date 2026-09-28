import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { InventoryMovement, MerchantStats, Order, Product } from "@ecom/db";
import { inTransaction, reserveOrderStock, syncOrderInventory } from "../src/lib/inventory.js";
import { applyTrackingEvents } from "../src/server/tracking.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * updateOrder is a compare-and-set on the status it read: two writers that
 * both read the same status cannot both land a transition. The loser gets
 * CONFLICT and runs no side effects (MerchantStats, stock, rescore).
 */

const STATUSES = ["pending", "confirmed", "packed", "shipped", "in_transit", "delivered", "cancelled", "rto"] as const;
type Status = (typeof STATUSES)[number];

async function setup(status: Status) {
  const merchant = await createMerchant();
  const merchantId = merchant._id as Types.ObjectId;
  const product = await Product.create({ merchantId, name: "Premium Achar", price: 1250, inventory: { onHand: 10, reserved: 0 } });
  const orderId = new Types.ObjectId();
  await Order.create({
    _id: orderId,
    merchantId,
    orderNumber: `ORD-${orderId.toHexString().slice(-8)}`,
    customer: { name: "Customer", phone: "+8801711111111", address: "House 1", district: "Dhaka" },
    items: [{ name: "Premium Achar", quantity: 1, price: 1250, productId: product._id }],
    order: { cod: 1330, total: 1330, status },
    inventory: { state: "reserved", cycle: 1, reservedAt: new Date() },
    logistics: { courier: "steadfast", trackingNumber: `SF-${orderId.toHexString().slice(-8)}` },
  });
  await inTransaction((s) => reserveOrderStock(s, { merchantId, orderId, items: [{ productId: product._id as Types.ObjectId, quantity: 1 }] }));
  await syncOrderInventory([orderId]);
  // Exactly one order, counted under its status.
  const counts = Object.fromEntries(STATUSES.map((s) => [s, s === status ? 1 : 0]));
  await MerchantStats.updateOne({ merchantId }, { $set: counts }, { upsert: true });
  return { merchant, merchantId, productId: product._id as Types.ObjectId, orderId, caller: callerFor(authUserFor(merchant)) };
}

async function state(merchantId: Types.ObjectId, orderId: Types.ObjectId, productId: Types.ObjectId) {
  const o = await Order.findById(orderId).lean();
  const p = await Product.findById(productId).lean();
  const moves = await InventoryMovement.find({ orderId }).sort({ createdAt: 1, _id: 1 }).lean();
  const stats = (await MerchantStats.findOne({ merchantId }).lean()) as Record<string, number> | null;
  return {
    status: o!.order.status as Status,
    inventoryState: o!.inventory?.state,
    onHand: p!.inventory.onHand,
    reserved: p!.inventory.reserved,
    moves: moves.map((m) => m.type),
    stats: Object.fromEntries(STATUSES.map((s) => [s, stats?.[s] ?? 0])) as Record<Status, number>,
  };
}

/** The single order is counted exactly once, under its actual status. */
function expectStatsMatch(s: Awaited<ReturnType<typeof state>>) {
  for (const k of STATUSES) expect(s.stats[k], `stats.${k}`).toBe(k === s.status ? 1 : 0);
}

beforeAll(async () => {
  await ensureDb();
  await Product.syncIndexes();
  await InventoryMovement.syncIndexes();
});
afterAll(disconnectDb);
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("updateOrder compare-and-set on the read status", () => {
  it("two simultaneous Returned requests: one transition, one RETURNED movement, one stats update", async () => {
    const { merchantId, orderId, productId, caller } = await setup("in_transit");
    const results = await Promise.allSettled([
      caller.orders.updateOrder({ id: String(orderId), status: "rto" }),
      caller.orders.updateOrder({ id: String(orderId), status: "rto" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "CONFLICT" });

    const s = await state(merchantId, orderId, productId);
    expect(s).toMatchObject({ status: "rto", inventoryState: "released", onHand: 10, reserved: 0 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "RETURNED"]);
    expectStatsMatch(s);
  });

  it("courier 'delivered' racing a manual Returned: no contradictory state, stock and stats consistent", async () => {
    const { merchantId, orderId, productId, caller } = await setup("in_transit");
    const snap = await Order.findById(orderId).select("_id merchantId order logistics").lean();
    const [manual, courier] = await Promise.allSettled([
      caller.orders.updateOrder({ id: String(orderId), status: "rto" }),
      applyTrackingEvents(snap as never, "delivered", [{ at: new Date(), providerStatus: "delivered" }], { source: "webhook" }),
    ]);
    expect(courier.status).toBe("fulfilled");
    if (manual.status === "rejected") expect(manual.reason).toMatchObject({ code: "CONFLICT" });

    // Either the courier won (manual gets CONFLICT) or the return landed
    // first and the courier's "delivered" legitimately overrode it — the
    // one courier fact allowed out of rto. Both end delivered + fulfilled.
    const s = await state(merchantId, orderId, productId);
    expect(s).toMatchObject({ status: "delivered", inventoryState: "fulfilled", onHand: 9, reserved: 0 });
    expect(s.moves.filter((m) => m === "ORDER_FULFILLED")).toHaveLength(1);
    expect(s.moves.filter((m) => m === "RETURNED").length).toBeLessThanOrEqual(1);
    expectStatsMatch(s);
  });

  it("courier 'delivered' landing between the manual read and write: manual gets CONFLICT, nothing overwritten", async () => {
    const { merchantId, orderId, productId, caller } = await setup("in_transit");
    const snap = await Order.findById(orderId).select("_id merchantId order logistics").lean();
    // Deterministic interleaving: updateOrder reads "in_transit", then the
    // courier delivers, then updateOrder tries to write "rto".
    const realFindOne = Order.findOne.bind(Order);
    vi.spyOn(Order, "findOne").mockImplementationOnce(((...args: Parameters<typeof Order.findOne>) =>
      (async () => {
        const doc = await realFindOne(...args);
        await applyTrackingEvents(snap as never, "delivered", [{ at: new Date(), providerStatus: "delivered" }], { source: "webhook" });
        return doc;
      })()) as never);

    await expect(caller.orders.updateOrder({ id: String(orderId), status: "rto" })).rejects.toMatchObject({ code: "CONFLICT" });
    const s = await state(merchantId, orderId, productId);
    expect(s).toMatchObject({ status: "delivered", inventoryState: "fulfilled", onHand: 9, reserved: 0 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
    expectStatsMatch(s);
  });

  it("manual Returned on a stale read after the courier delivered is refused", async () => {
    const { merchantId, orderId, productId, caller } = await setup("in_transit");
    const snap = await Order.findById(orderId).select("_id merchantId order logistics").lean();
    await applyTrackingEvents(snap as never, "delivered", [{ at: new Date(), providerStatus: "delivered" }], { source: "webhook" });
    await expect(caller.orders.updateOrder({ id: String(orderId), status: "rto" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const s = await state(merchantId, orderId, productId);
    expect(s).toMatchObject({ status: "delivered", inventoryState: "fulfilled", onHand: 9, reserved: 0 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
    expectStatsMatch(s);
  });

  it("cancel racing ship from packed: exactly one wins, the loser cannot jump shipped → cancelled", async () => {
    const { merchantId, orderId, productId, caller } = await setup("packed");
    const results = await Promise.allSettled([
      caller.orders.updateOrder({ id: String(orderId), status: "shipped" }),
      caller.orders.updateOrder({ id: String(orderId), status: "cancelled" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(rejected.reason).toMatchObject({ code: "CONFLICT" });

    const s = await state(merchantId, orderId, productId);
    expect(["shipped", "cancelled"]).toContain(s.status);
    if (s.status === "shipped") {
      expect(s).toMatchObject({ inventoryState: "reserved", onHand: 10, reserved: 1, moves: ["ORDER_RESERVED"] });
    } else {
      expect(s).toMatchObject({ inventoryState: "released", onHand: 10, reserved: 0, moves: ["ORDER_RESERVED", "ORDER_CANCELLED"] });
    }
    expectStatsMatch(s);
  });

  it("cancel racing Returned on an in-transit order: transition rules still apply, Returned wins", async () => {
    const { merchantId, orderId, productId, caller } = await setup("in_transit");
    const [cancel, returned] = await Promise.allSettled([
      caller.orders.updateOrder({ id: String(orderId), status: "cancelled" }),
      caller.orders.updateOrder({ id: String(orderId), status: "rto" }),
    ]);
    expect(cancel.status).toBe("rejected");
    expect(returned.status).toBe("fulfilled");
    const s = await state(merchantId, orderId, productId);
    expect(s).toMatchObject({ status: "rto", inventoryState: "released", onHand: 10, reserved: 0 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "RETURNED"]);
    expectStatsMatch(s);
  });

  it("a conflict loser can refresh and retry against the new status", async () => {
    const { merchantId, orderId, productId, caller } = await setup("packed");
    await Promise.allSettled([
      caller.orders.updateOrder({ id: String(orderId), status: "shipped" }),
      caller.orders.updateOrder({ id: String(orderId), status: "shipped" }),
    ]);
    const res = await caller.orders.updateOrder({ id: String(orderId), status: "in_transit" });
    expect(res.status).toBe("in_transit");
    const s = await state(merchantId, orderId, productId);
    expect(s).toMatchObject({ status: "in_transit", inventoryState: "reserved", reserved: 1 });
    expectStatsMatch(s);
  });

  it("duplicate sequential request is idempotent: no stats or stock change", async () => {
    const { merchantId, orderId, productId, caller } = await setup("in_transit");
    await caller.orders.updateOrder({ id: String(orderId), status: "rto" });
    const once = await state(merchantId, orderId, productId);
    const again = await caller.orders.updateOrder({ id: String(orderId), status: "rto" });
    expect(again.status).toBe("rto");
    const twice = await state(merchantId, orderId, productId);
    expect(twice).toEqual(once);
    expectStatsMatch(twice);
  });

  it("non-status edits still save and do not touch stats", async () => {
    const { merchantId, orderId, productId, caller } = await setup("in_transit");
    await caller.orders.updateOrder({ id: String(orderId), rtoReason: "customer refused" });
    const o = await Order.findById(orderId).lean();
    expect(o!.logistics?.rtoReason).toBe("customer refused");
    expectStatsMatch(await state(merchantId, orderId, productId));
  });

  it("cross-merchant update is rejected, even while the owner updates concurrently", async () => {
    const a = await setup("in_transit");
    const b = await createMerchant();
    const intruder = callerFor(authUserFor(b));
    const [owner, foreign] = await Promise.allSettled([
      a.caller.orders.updateOrder({ id: String(a.orderId), status: "rto" }),
      intruder.orders.updateOrder({ id: String(a.orderId), status: "delivered" }),
    ]);
    expect(owner.status).toBe("fulfilled");
    expect(foreign.status).toBe("rejected");
    expect((foreign as PromiseRejectedResult).reason).toMatchObject({ code: "NOT_FOUND" });
    const s = await state(a.merchantId, a.orderId, a.productId);
    expect(s).toMatchObject({ status: "rto", inventoryState: "released", reserved: 0, moves: ["ORDER_RESERVED", "RETURNED"] });
    expectStatsMatch(s);
    expect(await MerchantStats.findOne({ merchantId: b._id }).lean()).toBeNull();
  });
});
