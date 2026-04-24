import { Types } from "mongoose";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Order } from "@ecom/db";
import { registerCourierAdapter } from "../src/lib/couriers/index.js";
import { PathaoAdapter, MockPathaoTransport, __clearPathaoTokenCache } from "../src/lib/couriers/pathao.js";
import type { CourierAdapter, TrackingInfo } from "../src/lib/couriers/types.js";
import { pickOrdersToSync, syncOrderTracking } from "../src/server/tracking.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

const sampleOrder = {
  customer: {
    name: "Jane",
    phone: "+8801712345678",
    address: "House 5, Road 3",
    district: "Dhaka",
  },
  items: [{ name: "Shirt", quantity: 1, price: 500 }],
  cod: 500,
};

async function loadOrder(id: string) {
  const o = await Order.findById(id).lean();
  if (!o) throw new Error("order not found");
  return o;
}

describe("syncOrderTracking", () => {
  beforeEach(async () => {
    await resetDb();
    __clearPathaoTokenCache();
    MockPathaoTransport.reset();
    // Reset any test-swapped adapters.
    registerCourierAdapter("pathao", (creds) => new PathaoAdapter({ credentials: creds }));
  });
  afterAll(disconnectDb);

  it("persists new tracking events and dedupes on repeated polls", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);
    await caller.orders.bookShipment({ orderId: created.id, courier: "pathao" });

    // Fixed-timestamp adapter — second poll returns the exact same events, so
    // dedupeKey matches and no duplicates should be inserted.
    const fixedAt = new Date("2026-03-01T12:00:00Z");
    registerCourierAdapter("pathao", () => fixedEventAdapter(fixedAt));

    const order1 = await loadOrder(created.id);
    const first = await syncOrderTracking({
      _id: order1._id,
      merchantId: order1.merchantId,
      order: order1.order as never,
      logistics: order1.logistics as never,
    });
    expect(first.error).toBeUndefined();
    expect((first.newEvents ?? 0)).toBeGreaterThan(0);

    const order2 = await loadOrder(created.id);
    const eventsAfterFirst = order2.logistics?.trackingEvents?.length ?? 0;
    expect(eventsAfterFirst).toBeGreaterThan(0);

    const second = await syncOrderTracking({
      _id: order2._id,
      merchantId: order2.merchantId,
      order: order2.order as never,
      logistics: order2.logistics as never,
    });
    expect(second.newEvents ?? 0).toBe(0);

    const order3 = await loadOrder(created.id);
    expect(order3.logistics?.trackingEvents?.length).toBe(eventsAfterFirst);
    expect(order3.logistics?.lastPolledAt).toBeTruthy();
  });

  it("transitions shipped → delivered when courier reports delivered", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);
    await caller.orders.bookShipment({ orderId: created.id, courier: "pathao" });

    // Swap pathao with a scripted adapter that reports "Delivered".
    registerCourierAdapter("pathao", () => scriptedAdapter("delivered"));

    const order = await loadOrder(created.id);
    const res = await syncOrderTracking({
      _id: order._id,
      merchantId: order.merchantId,
      order: order.order as never,
      logistics: order.logistics as never,
    });
    expect(res.statusTransition?.to).toBe("delivered");

    const after = await loadOrder(created.id);
    expect(after.order.status).toBe("delivered");
    expect(after.logistics?.deliveredAt).toBeTruthy();
  });

  it("transitions shipped → rto when courier reports return", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);
    await caller.orders.bookShipment({ orderId: created.id, courier: "pathao" });

    registerCourierAdapter("pathao", () => scriptedAdapter("rto"));

    const order = await loadOrder(created.id);
    const res = await syncOrderTracking({
      _id: order._id,
      merchantId: order.merchantId,
      order: order.order as never,
      logistics: order.logistics as never,
    });
    expect(res.statusTransition?.to).toBe("rto");

    const after = await loadOrder(created.id);
    expect(after.order.status).toBe("rto");
    expect(after.logistics?.returnedAt).toBeTruthy();
  });

  it("records pollError without throwing when adapter fails", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);
    await caller.orders.bookShipment({ orderId: created.id, courier: "pathao" });

    registerCourierAdapter("pathao", () => failingAdapter());

    const order = await loadOrder(created.id);
    const res = await syncOrderTracking({
      _id: order._id,
      merchantId: order.merchantId,
      order: order.order as never,
      logistics: order.logistics as never,
    });
    expect(res.error).toBeTruthy();

    const after = await loadOrder(created.id);
    expect(after.logistics?.pollError).toMatch(/boom/i);
    expect(after.logistics?.pollErrorCount).toBeGreaterThan(0);
  });

  it("pickOrdersToSync returns only active shipments with tracking numbers", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const a = await caller.orders.createOrder(sampleOrder);
    await caller.orders.createOrder({
      ...sampleOrder,
      customer: { ...sampleOrder.customer, phone: "+8801722222222" },
    });
    await caller.orders.bookShipment({ orderId: a.id, courier: "pathao" });

    const picked = await pickOrdersToSync(10, 60_000);
    expect(picked.length).toBe(1);
    expect(String(picked[0]?._id)).toBe(a.id);
  });
});

function scriptedAdapter(variant: "delivered" | "rto"): CourierAdapter {
  return {
    name: "pathao",
    async validateCredentials() {
      return { valid: true };
    },
    async createAWB() {
      throw new Error("not used in this test");
    },
    async getTracking(trackingNumber: string): Promise<TrackingInfo> {
      const now = new Date();
      if (variant === "delivered") {
        return {
          trackingNumber,
          providerStatus: "Delivered",
          normalizedStatus: "delivered",
          events: [{ at: now, description: "Delivered to customer" }],
          deliveredAt: now,
        };
      }
      return {
        trackingNumber,
        providerStatus: "Returned",
        normalizedStatus: "rto",
        events: [{ at: now, description: "Returned to sender" }],
      };
    },
    async priceQuote() {
      return { amount: 0, currency: "BDT" };
    },
  };
}

function fixedEventAdapter(at: Date): CourierAdapter {
  return {
    name: "pathao",
    async validateCredentials() {
      return { valid: true };
    },
    async createAWB() {
      throw new Error("not used");
    },
    async getTracking(trackingNumber: string): Promise<TrackingInfo> {
      return {
        trackingNumber,
        providerStatus: "Pickup Requested",
        normalizedStatus: "pending",
        events: [
          { at, description: "Order Placed" },
          { at, description: "Pickup Requested" },
        ],
      };
    },
    async priceQuote() {
      return { amount: 0, currency: "BDT" };
    },
  };
}

function failingAdapter(): CourierAdapter {
  return {
    name: "pathao",
    async validateCredentials() {
      return { valid: true };
    },
    async createAWB() {
      throw new Error("not used");
    },
    async getTracking(): Promise<TrackingInfo> {
      throw new Error("boom: courier down");
    },
    async priceQuote() {
      return { amount: 0, currency: "BDT" };
    },
  };
}

