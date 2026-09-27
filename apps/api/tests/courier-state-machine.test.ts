import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { InventoryMovement, MerchantStats, Order, Product } from "@ecom/db";
import { inTransaction, reserveOrderStock } from "../src/lib/inventory.js";
import { parsePathaoWebhook } from "../src/lib/couriers/pathao.js";
import { parseRedxWebhook } from "../src/lib/couriers/redx.js";
import { parseSteadfastWebhook } from "../src/lib/couriers/steadfast.js";
import { applyTrackingEvents, courierOrderTransition } from "../src/server/tracking.js";
import { courierWebhookRouter } from "../src/server/webhooks/courier.js";
import { createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Courier status → order status → inventory, end to end on a real Mongo
 * (replica set, so the ledger transactions run for real). Covers the
 * failure modes found in the launch audit: terminal orders moving
 * backwards, failed delivery attempts releasing stock, substring
 * mis-mapping, duplicate / out-of-order / foreign-merchant webhooks.
 */

type Status = "pending" | "confirmed" | "packed" | "shipped" | "in_transit" | "delivered" | "cancelled" | "rto";

async function setup(status: Status = "in_transit") {
  const merchant = await createMerchant();
  const merchantId = merchant._id as Types.ObjectId;
  const product = await Product.create({
    merchantId,
    name: "Premium Achar",
    price: 1250,
    inventory: { onHand: 10, reserved: 0 },
  });
  const orderId = new Types.ObjectId();
  const trackingNumber = `PT-${orderId.toHexString().slice(-8)}`;
  await Order.create({
    _id: orderId,
    merchantId,
    orderNumber: `ORD-${orderId.toHexString().slice(-8)}`,
    customer: { name: "Customer", phone: "+8801711111111", address: "House 1", district: "Dhaka" },
    items: [{ name: "Premium Achar", quantity: 1, price: 1250, productId: product._id }],
    order: { cod: 1330, total: 1330, status: "shipped" },
    inventory: { state: "reserved", cycle: 1, reservedAt: new Date() },
    logistics: { courier: "pathao", trackingNumber },
  });
  await inTransaction((s) => reserveOrderStock(s, { merchantId, orderId, items: [{ productId: product._id as Types.ObjectId, quantity: 1 }] }));
  if (status !== "shipped") {
    // Move to the starting status the way the app would, keeping stock consistent.
    await Order.updateOne({ _id: orderId }, { $set: { "order.status": status } });
    const { syncOrderInventory } = await import("../src/lib/inventory.js");
    await syncOrderInventory([orderId]);
  }
  return { merchant, merchantId, productId: product._id as Types.ObjectId, orderId, trackingNumber };
}

async function fresh(orderId: Types.ObjectId) {
  const o = await Order.findById(orderId).lean();
  return {
    _id: o!._id as Types.ObjectId,
    merchantId: o!.merchantId as Types.ObjectId,
    order: o!.order as never,
    logistics: o!.logistics as never,
  };
}

let eventSeq = 0;
async function apply(orderId: Types.ObjectId, normalized: Parameters<typeof applyTrackingEvents>[1], providerStatus: string) {
  eventSeq++;
  return applyTrackingEvents(
    await fresh(orderId),
    normalized,
    [{ at: new Date(Date.now() + eventSeq * 1000), providerStatus, description: `${providerStatus} #${eventSeq}` }],
    { source: "webhook" },
  );
}

async function state(orderId: Types.ObjectId, productId: Types.ObjectId) {
  const o = await Order.findById(orderId).lean();
  const p = await Product.findById(productId).lean();
  const moves = await InventoryMovement.find({ orderId }).sort({ createdAt: 1, _id: 1 }).lean();
  return {
    status: o!.order.status,
    inventoryState: o!.inventory?.state,
    returnedAt: o!.logistics?.returnedAt ?? null,
    deliveredAt: o!.logistics?.deliveredAt ?? null,
    events: o!.logistics?.trackingEvents?.length ?? 0,
    onHand: p!.inventory.onHand,
    reserved: p!.inventory.reserved,
    moves: moves.map((m) => m.type),
  };
}

beforeAll(async () => {
  await ensureDb();
  await Product.syncIndexes();
  await InventoryMovement.syncIndexes();
});
afterAll(disconnectDb);
beforeEach(resetDb);

describe("courierOrderTransition (pure rules)", () => {
  it("moves active orders forward", () => {
    expect(courierOrderTransition("shipped", "picked_up")).toBe("in_transit");
    expect(courierOrderTransition("shipped", "out_for_delivery")).toBe("in_transit");
    expect(courierOrderTransition("in_transit", "delivered")).toBe("delivered");
    expect(courierOrderTransition("in_transit", "rto")).toBe("rto");
  });
  it("never moves delivered, cancelled or rto backwards", () => {
    for (const terminal of ["delivered", "cancelled", "rto"]) {
      for (const incoming of ["picked_up", "in_transit", "out_for_delivery", "pending", "failed", "unknown"] as const) {
        expect(courierOrderTransition(terminal, incoming)).toBeNull();
      }
    }
    expect(courierOrderTransition("delivered", "rto")).toBeNull();
    expect(courierOrderTransition("cancelled", "rto")).toBeNull();
  });
  it("lets only a courier 'delivered' override a cancellation or return", () => {
    expect(courierOrderTransition("cancelled", "delivered")).toBe("delivered");
    expect(courierOrderTransition("rto", "delivered")).toBe("delivered");
  });
  it("a failed delivery attempt never changes the order", () => {
    for (const s of ["pending", "confirmed", "packed", "shipped", "in_transit"]) {
      expect(courierOrderTransition(s, "failed")).toBeNull();
    }
  });
});

describe("courier events → order status → stock (Mongo)", () => {
  it("1. delivered → late in_transit: stays delivered, stock untouched", async () => {
    const { orderId, productId } = await setup("in_transit");
    await apply(orderId, "delivered", "Delivered");
    const afterDelivered = await state(orderId, productId);
    expect(afterDelivered).toMatchObject({ status: "delivered", inventoryState: "fulfilled", onHand: 9, reserved: 0 });

    const r = await apply(orderId, "in_transit", "In_Transit");
    expect(r.statusTransition).toBeUndefined();
    const after = await state(orderId, productId);
    expect(after).toMatchObject({ status: "delivered", inventoryState: "fulfilled", onHand: 9, reserved: 0 });
    expect(after.moves).toEqual(afterDelivered.moves);
    expect(after.events).toBe(afterDelivered.events + 1); // still on the timeline
  });

  it("2. cancelled → late in_transit: stays cancelled, stock is not re-reserved", async () => {
    const { orderId, productId } = await setup("cancelled");
    const before = await state(orderId, productId);
    expect(before).toMatchObject({ status: "cancelled", inventoryState: "released", onHand: 10, reserved: 0 });

    await apply(orderId, "in_transit", "In_Transit");
    const after = await state(orderId, productId);
    expect(after).toMatchObject({ status: "cancelled", inventoryState: "released", onHand: 10, reserved: 0 });
    expect(after.moves).toEqual(before.moves);
  });

  it("3. rto → late in_transit: stays rto", async () => {
    const { orderId, productId } = await setup("in_transit");
    await apply(orderId, "rto", "Returned to merchant");
    const before = await state(orderId, productId);
    await apply(orderId, "in_transit", "In_Transit");
    expect(await state(orderId, productId)).toMatchObject({ status: "rto", reserved: before.reserved, onHand: before.onHand });
  });

  it("4. Pathao Pickup_Failed: parcel never left — order and stock unchanged", async () => {
    const { orderId, productId, trackingNumber } = await setup("shipped");
    const parsed = parsePathaoWebhook({ consignment_id: trackingNumber, order_status: "Pickup_Failed" })!;
    expect(parsed.normalizedStatus).toBe("pending");
    await apply(orderId, parsed.normalizedStatus, parsed.providerStatus);
    expect(await state(orderId, productId)).toMatchObject({ status: "shipped", inventoryState: "reserved", reserved: 1, onHand: 10 });
  });

  it("5. Pathao Pickup_Cancelled: order and stock unchanged", async () => {
    const { orderId, productId, trackingNumber } = await setup("shipped");
    const parsed = parsePathaoWebhook({ consignment_id: trackingNumber, order_status: "Pickup Cancelled" })!;
    expect(parsed.normalizedStatus).toBe("pending");
    await apply(orderId, parsed.normalizedStatus, parsed.providerStatus);
    expect(await state(orderId, productId)).toMatchObject({ status: "shipped", reserved: 1, onHand: 10 });
  });

  it("6. Delivery_Failed: stays in transit, stock stays reserved, no returnedAt", async () => {
    const { orderId, productId, trackingNumber } = await setup("in_transit");
    const parsed = parsePathaoWebhook({ consignment_id: trackingNumber, order_status: "Delivery_Failed" })!;
    expect(parsed.normalizedStatus).toBe("failed");
    await apply(orderId, parsed.normalizedStatus, parsed.providerStatus);
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "in_transit", inventoryState: "reserved", reserved: 1, onHand: 10, returnedAt: null });
    expect(s.moves).toEqual(["ORDER_RESERVED"]);
  });

  it("7. actual return: rto, reservation released exactly once", async () => {
    const { orderId, productId, trackingNumber } = await setup("in_transit");
    const parsed = parsePathaoWebhook({ consignment_id: trackingNumber, order_status: "Returned to merchant" })!;
    expect(parsed.normalizedStatus).toBe("rto");
    const r = await apply(orderId, parsed.normalizedStatus, parsed.providerStatus);
    expect(r.statusTransition).toEqual({ from: "in_transit", to: "rto" });
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "rto", inventoryState: "released", reserved: 0, onHand: 10 });
    expect(s.returnedAt).toBeTruthy();
    expect(s.moves).toEqual(["ORDER_RESERVED", "RETURNED"]);
  });

  it("8. duplicate delivered webhook: stock and stats change once", async () => {
    const { merchantId, orderId, productId } = await setup("in_transit");
    await MerchantStats.updateOne({ merchantId }, { $set: { in_transit: 1, delivered: 0 } }, { upsert: true });
    const event = { at: new Date("2026-09-27T10:00:00Z"), providerStatus: "Delivered", description: "Delivered" };
    await applyTrackingEvents(await fresh(orderId), "delivered", [event], { source: "webhook" });
    await applyTrackingEvents(await fresh(orderId), "delivered", [event], { source: "webhook" });
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "delivered", onHand: 9, reserved: 0, events: 1 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
    const stats = await MerchantStats.findOne({ merchantId }).lean();
    expect((stats as Record<string, unknown>).delivered).toBe(1);
  });

  it("9. out-of-order: late return after delivered is refused, no returnedAt", async () => {
    const { orderId, productId, trackingNumber } = await setup("in_transit");
    await apply(orderId, "delivered", "Delivered");
    const parsed = parsePathaoWebhook({ consignment_id: trackingNumber, order_status: "Return" })!;
    expect(parsed.normalizedStatus).toBe("rto");
    await apply(orderId, parsed.normalizedStatus, parsed.providerStatus);
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "delivered", onHand: 9, reserved: 0, returnedAt: null });
    expect(s.moves).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
  });

  it("stale snapshot: a late return from a writer that still sees 'in_transit' cannot undo a delivery", async () => {
    const { orderId, productId } = await setup("in_transit");
    const staleSnapshot = await fresh(orderId); // in_transit
    await apply(orderId, "delivered", "Delivered"); // someone else delivers first
    const r = await applyTrackingEvents(staleSnapshot, "rto", [{ at: new Date(), providerStatus: "Return" }], { source: "webhook" });
    expect(r.statusTransition).toBeUndefined();
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "delivered", inventoryState: "fulfilled", onHand: 9, reserved: 0, returnedAt: null });
    expect(s.moves).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
    expect(s.events).toBe(2); // the late event is still on the timeline
  });

  it("race: the same 'delivered' from webhook and poll at once moves stock and stats once", async () => {
    const { merchantId, orderId, productId } = await setup("in_transit");
    await MerchantStats.updateOne({ merchantId }, { $set: { in_transit: 1, delivered: 0 } }, { upsert: true });
    const snap = await fresh(orderId);
    const event = { at: new Date("2026-09-27T10:00:00Z"), providerStatus: "Delivered", description: "Delivered" };
    const results = await Promise.all([
      applyTrackingEvents(snap, "delivered", [event], { source: "webhook" }),
      applyTrackingEvents(snap, "delivered", [event], { source: "poll" }),
    ]);
    expect(results.filter((r) => r.statusTransition).length).toBe(1);
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "delivered", onHand: 9, reserved: 0, events: 1 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
    const stats = await MerchantStats.findOne({ merchantId }).lean();
    expect((stats as Record<string, unknown>).delivered).toBe(1);
  });

  it("courier 'delivered' after a merchant cancellation books the goods as sold", async () => {
    const { orderId, productId } = await setup("cancelled");
    const r = await apply(orderId, "delivered", "Delivered");
    expect(r.statusTransition).toEqual({ from: "cancelled", to: "delivered" });
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "delivered", inventoryState: "fulfilled", onHand: 9, reserved: 0 });
  });
});

describe("courier webhook HTTP route", () => {
  async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const app = express();
    app.use("/api/webhooks/courier", courierWebhookRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      return await fn(`http://127.0.0.1:${port}/api/webhooks/courier`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
  // Pathao presents the webhook secret itself in X-PATHAO-Signature (official plugin).
  const sign = (_body: string) => "ph_secret";

  it("10. foreign merchant: a signed webhook for merchant B cannot touch merchant A's order", async () => {
    const a = await setup("in_transit");
    const b = await createMerchant();
    const body = JSON.stringify({ consignment_id: a.trackingNumber, order_status: "Delivered", updated_at: "2026-09-27T10:00:00Z" });
    await withServer(async (base) => {
      const res = await fetch(`${base}/pathao/${String(b._id)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pathao-signature": sign(body) },
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ignored: true });
    });
    expect(await state(a.orderId, a.productId)).toMatchObject({ status: "in_transit", reserved: 1, onHand: 10, events: 0 });
  });

  it("rejects an unsigned webhook and applies a signed one exactly once", async () => {
    const a = await setup("in_transit");
    const body = JSON.stringify({ consignment_id: a.trackingNumber, order_status: "Delivered", updated_at: "2026-09-27T10:00:00Z" });
    await withServer(async (base) => {
      const url = `${base}/pathao/${String(a.merchantId)}`;
      const unsigned = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(unsigned.status).toBe(401);
      for (let i = 0; i < 2; i++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-pathao-signature": sign(body) },
          body,
        });
        expect(res.status).toBe(200);
      }
    });
    const s = await state(a.orderId, a.productId);
    expect(s).toMatchObject({ status: "delivered", onHand: 9, reserved: 0, events: 1 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
  });
});

describe("adapter parse → normalized status (real fixtures)", () => {
  it("keeps the established mappings", () => {
    expect(parsePathaoWebhook({ consignment_id: "P", order_status: "Delivered" })!.normalizedStatus).toBe("delivered");
    expect(parseRedxWebhook({ tracking_id: "R", status: "pickup-success" })!.normalizedStatus).toBe("picked_up");
    expect(parseSteadfastWebhook({ tracking_code: "S", status: "partial_delivered" })!.normalizedStatus).toBe("delivered");
  });
});
