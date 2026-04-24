import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { __clearPathaoTokenCache, MockPathaoTransport } from "../src/lib/couriers/pathao.js";
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

describe("ordersRouter.bookShipment", () => {
  beforeEach(async () => {
    await resetDb();
    __clearPathaoTokenCache();
    MockPathaoTransport.reset();
  });
  afterAll(disconnectDb);

  it("books a single order and flips status to shipped", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);

    const res = await caller.orders.bookShipment({
      orderId: created.id,
      courier: "pathao",
    });

    expect(res.status).toBe("shipped");
    expect(res.trackingNumber).toMatch(/^PTH-/);
    expect(res.courier).toBe("pathao");

    const list = await caller.orders.listOrders({ status: "shipped" });
    expect(list.total).toBe(1);
    expect(list.items[0]?.trackingNumber).toBe(res.trackingNumber);
  });

  it("is idempotent — replaying returns the same trackingNumber", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);
    const first = await caller.orders.bookShipment({ orderId: created.id, courier: "pathao" });
    const second = await caller.orders.bookShipment({ orderId: created.id, courier: "pathao" });
    expect(second.trackingNumber).toBe(first.trackingNumber);
  });

  it("rejects orders already in terminal status", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);
    // Cancel is a one-step terminal transition from pending; the full
    // delivered path would require walking through shipped (which also
    // books a shipment) so it isn't useful here.
    await caller.orders.updateOrder({ id: created.id, status: "cancelled" });

    await expect(
      caller.orders.bookShipment({ orderId: created.id, courier: "pathao" }),
    ).rejects.toThrowError(/cancelled/i);
  });

  it("rejects when courier is not configured for the merchant", async () => {
    const { Merchant } = await import("@ecom/db");
    const m = await createMerchant();
    await Merchant.updateOne({ _id: m._id }, { $pull: { couriers: { name: "pathao" } } });
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);
    await expect(
      caller.orders.bookShipment({ orderId: created.id, courier: "pathao" }),
    ).rejects.toThrowError(/not configured/i);
  });

  it("bulkBookShipment reports per-order success/failure", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const a = await caller.orders.createOrder(sampleOrder);
    const b = await caller.orders.createOrder({
      ...sampleOrder,
      customer: { ...sampleOrder.customer, phone: "+8801722222222" },
    });
    const c = await caller.orders.createOrder({
      ...sampleOrder,
      customer: { ...sampleOrder.customer, phone: "+8801733333333" },
    });
    // Terminal state via the one-step pending → cancelled transition.
    await caller.orders.updateOrder({ id: c.id, status: "cancelled" });

    const res = await caller.orders.bulkBookShipment({
      orderIds: [a.id, b.id, c.id],
      courier: "pathao",
    });

    expect(res.total).toBe(3);
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
    const cResult = res.results.find((r) => r.orderId === c.id);
    expect(cResult?.ok).toBe(false);
  });

  it("getTracking returns normalized events for a shipped order", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(sampleOrder);
    await caller.orders.bookShipment({ orderId: created.id, courier: "pathao" });

    const tracking = await caller.orders.getTracking({ orderId: created.id });
    expect(tracking.courier).toBe("pathao");
    expect((tracking.events ?? []).length).toBeGreaterThan(0);
  });
});

describe("merchantsRouter.validateCourier", () => {
  beforeEach(async () => {
    await resetDb();
    __clearPathaoTokenCache();
    MockPathaoTransport.reset();
  });
  afterAll(disconnectDb);

  it("persists lastValidatedAt when credentials are accepted", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const res = await caller.merchants.validateCourier({ name: "pathao" });
    expect(res.valid).toBe(true);
    const couriers = await caller.merchants.getCouriers();
    const pathao = couriers.find((c) => c.name === "pathao");
    expect(pathao?.lastValidatedAt).toBeTruthy();
    expect(pathao?.validationError).toBeNull();
  });
});
