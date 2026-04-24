import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

const sampleOrder = {
  customer: {
    name: "John Doe",
    phone: "+8801711111111",
    address: "House 1, Road 1",
    district: "Dhaka",
  },
  items: [{ name: "T-Shirt", quantity: 2, price: 500 }],
  cod: 1000,
};

describe("ordersRouter", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("createOrder creates and returns identifiers", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const res = await caller.orders.createOrder(sampleOrder);
    expect(res.id).toBeTruthy();
    expect(res.orderNumber).toMatch(/^ORD-/);
  });

  it("listOrders filters by status", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    await caller.orders.createOrder(sampleOrder);
    await caller.orders.createOrder({ ...sampleOrder, customer: { ...sampleOrder.customer, phone: "+8801722222222" } });

    const all = await caller.orders.listOrders({});
    expect(all.total).toBe(2);

    const pending = await caller.orders.listOrders({ status: "pending" });
    expect(pending.total).toBe(2);

    const delivered = await caller.orders.listOrders({ status: "delivered" });
    expect(delivered.total).toBe(0);
  });

  it("bulkUpload parses CSV and inserts valid rows", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const csv = [
      "orderNumber,customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod",
      "BULK-1,Jane,+8801733333333,Address 1,Dhaka,Shirt,1,500,500",
      "BULK-2,Bob,+8801744444444,Address 2,Sylhet,Pants,2,700,1400",
      "BULK-3,Alice,badphone,Addr,Dhaka,Thing,1,100,100",
    ].join("\n");

    const res = await caller.orders.bulkUpload({ csv });
    expect(res.inserted).toBe(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.error).toBe("invalid phone");
  });

  it("updateOrder changes status and keeps merchant stats in sync", async () => {
    const { MerchantStats } = await import("@ecom/db");
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const created = await caller.orders.createOrder(sampleOrder);
    const before = await MerchantStats.findOne({ merchantId: m._id }).lean();
    expect(before?.pending).toBe(1);
    expect(before?.delivered ?? 0).toBe(0);

    // Walk the valid status-transition chain: pending → confirmed → packed →
    // shipped → delivered. Direct pending → delivered jumps are blocked by
    // the transition map.
    await caller.orders.updateOrder({ id: created.id, status: "confirmed" });
    await caller.orders.updateOrder({ id: created.id, status: "packed" });
    await caller.orders.updateOrder({ id: created.id, status: "shipped" });
    const res = await caller.orders.updateOrder({ id: created.id, status: "delivered" });
    expect(res.status).toBe("delivered");

    const after = await MerchantStats.findOne({ merchantId: m._id }).lean();
    expect(after?.pending).toBe(0);
    expect(after?.delivered).toBe(1);
    expect(after?.totalOrders).toBe(before?.totalOrders);
  });

  it("updateOrder rejects orders owned by another merchant", async () => {
    const owner = await createMerchant({ email: `owner-${Date.now()}@test.com` });
    const stranger = await createMerchant({ email: `stranger-${Date.now()}@test.com` });
    const created = await callerFor(authUserFor(owner)).orders.createOrder(sampleOrder);

    await expect(
      callerFor(authUserFor(stranger)).orders.updateOrder({
        id: created.id,
        status: "confirmed",
      }),
    ).rejects.toThrowError(/not found/i);
  });

  it("deleteOrder removes the order and decrements stats", async () => {
    const { MerchantStats, Order } = await import("@ecom/db");
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const created = await caller.orders.createOrder(sampleOrder);
    const res = await caller.orders.deleteOrder({ id: created.id });
    expect(res.deleted).toBe(true);

    const stillThere = await Order.findById(created.id).lean();
    expect(stillThere).toBeNull();

    const stats = await MerchantStats.findOne({ merchantId: m._id }).lean();
    expect(stats?.totalOrders).toBe(0);
    expect(stats?.pending).toBe(0);
  });

  it("suggestCourier ranks exact district matches first", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const res = await caller.orders.suggestCourier({ district: "Sylhet" });
    expect(res.couriers[0]!.name).toBe("pathao");
    expect(res.couriers[0]!.exactMatch).toBe(true);
  });
});
