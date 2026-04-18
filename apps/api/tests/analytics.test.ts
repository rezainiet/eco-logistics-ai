import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CallLog, Order } from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

async function seedOrder(merchantId: unknown, status: string, courier = "Steadfast", district = "Dhaka") {
  return Order.create({
    merchantId,
    orderNumber: `O-${Math.random().toString(36).slice(2, 8)}`,
    customer: { name: "C", phone: "+8801755555555", address: "A", district },
    items: [{ name: "X", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status },
    logistics: { courier },
  });
}

describe("analyticsRouter", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("getDashboard aggregates order status counts", async () => {
    const m = await createMerchant();
    await Promise.all([
      seedOrder(m._id, "delivered"),
      seedOrder(m._id, "delivered"),
      seedOrder(m._id, "rto"),
      seedOrder(m._id, "pending"),
    ]);

    const caller = callerFor(authUserFor(m));
    const dash = await caller.analytics.getDashboard();
    expect(dash.totalOrders).toBe(4);
    expect(dash.delivered).toBe(2);
    expect(dash.rto).toBe(1);
    expect(dash.pending).toBe(1);
    expect(dash.rtoRate).toBeCloseTo(0.25);
  });

  it("getBestTimeToCall returns a 24-hour heatmap and best hours", async () => {
    const m = await createMerchant();
    const order = await seedOrder(m._id, "delivered");

    const hours = [10, 10, 10, 14, 14, 20];
    for (const hour of hours) {
      const ts = new Date();
      ts.setHours(hour, 0, 0, 0);
      await CallLog.create({
        merchantId: m._id,
        orderId: order._id,
        timestamp: ts,
        hour,
        duration: 60,
        answered: hour !== 20,
        outcome: { successful: hour === 10 },
      });
    }

    const caller = callerFor(authUserFor(m));
    const res = await caller.analytics.getBestTimeToCall();
    expect(res.heatmap).toHaveLength(24);
    expect(res.heatmap[10]!.total).toBe(3);
    expect(res.heatmap[10]!.answerRate).toBe(1);
    expect(res.heatmap[20]!.answerRate).toBe(0);
    expect(res.bestHours[0]).toBe(10);
  });

  it("getRTOMetrics breaks down RTOs by district and courier", async () => {
    const m = await createMerchant();
    await Promise.all([
      seedOrder(m._id, "rto", "Steadfast", "Dhaka"),
      seedOrder(m._id, "rto", "Steadfast", "Dhaka"),
      seedOrder(m._id, "rto", "Pathao", "Sylhet"),
      seedOrder(m._id, "delivered", "Steadfast", "Dhaka"),
    ]);

    const caller = callerFor(authUserFor(m));
    const res = await caller.analytics.getRTOMetrics();
    expect(res.totalOrders).toBe(4);
    expect(res.rtoOrders).toBe(3);
    expect(res.rtoRate).toBeCloseTo(0.75);
    expect(res.byDistrict[0]).toEqual({ district: "Dhaka", count: 2 });
    expect(res.byCourier[0]).toEqual({ courier: "Steadfast", count: 2 });
  });
});
