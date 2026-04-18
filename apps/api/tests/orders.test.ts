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

  it("suggestCourier ranks exact district matches first", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const res = await caller.orders.suggestCourier({ district: "Sylhet" });
    expect(res.couriers[0]!.name).toBe("Pathao");
    expect(res.couriers[0]!.exactMatch).toBe(true);
  });
});
