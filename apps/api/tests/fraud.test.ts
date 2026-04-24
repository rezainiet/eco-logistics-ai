import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AuditLog, MerchantStats, Order } from "@ecom/db";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";

// Inputs that should trip enough signals to land on "pending_call" review.
const riskyOrder = {
  customer: {
    name: "xxx",
    phone: "+8801799999999",
    address: "House 1",
    district: "unknown",
  },
  items: [{ name: "Phone", quantity: 1, price: 12000 }],
  cod: 12000,
};

const cleanOrder = {
  customer: {
    name: "Karim Ahmed",
    phone: "+8801700000001",
    address: "Road 2, House 5",
    district: "Dhaka",
  },
  items: [{ name: "Shirt", quantity: 1, price: 500 }],
  cod: 500,
};

/**
 * Seed a prior RTO with the same phone so the phone-history signal fires
 * and the risky order lands on "high" (extreme_cod 30 + fake_name 18 +
 * suspicious_district 16 + prior_returns 22 = 86).
 */
async function seedPriorRto(merchantId: Types.ObjectId, phone: string) {
  await Order.create({
    merchantId,
    orderNumber: `PRIOR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    customer: { name: "Prior customer", phone, address: "Prev addr", district: "Dhaka" },
    items: [{ name: "X", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "rto" },
  });
}

async function seedRiskyOrder(
  caller: ReturnType<typeof callerFor>,
  merchantId: Types.ObjectId,
  overrides: Partial<typeof riskyOrder> = {},
) {
  const customer = { ...riskyOrder.customer, ...(overrides.customer ?? {}) };
  await seedPriorRto(merchantId, customer.phone);
  const created = await caller.orders.createOrder({
    ...riskyOrder,
    ...overrides,
    customer,
  });
  expect(created.risk.level).toBe("high");
  expect(created.risk.reviewStatus).toBe("pending_call");
  return created;
}

describe("fraudRouter", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("lists pending reviews sorted by risk score", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    await caller.orders.createOrder(cleanOrder);
    const risky = await seedRiskyOrder(caller, m._id);

    const queue = await caller.fraud.listPendingReviews({
      cursor: null,
      limit: 25,
      filter: "all_open",
    });
    expect(queue.total).toBe(1);
    expect(queue.items[0]!.id).toBe(risky.id);
    expect(queue.items[0]!.level).toBe("high");
  });

  it("markVerified transitions to verified + writes audit", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const risky = await seedRiskyOrder(caller, m._id);

    const res = await caller.fraud.markVerified({ id: risky.id, notes: "Confirmed by phone" });
    expect(res.reviewStatus).toBe("verified");

    const order = await Order.findById(risky.id).lean();
    expect(order?.fraud?.reviewStatus).toBe("verified");
    expect(order?.fraud?.reviewNotes).toBe("Confirmed by phone");
    expect(order?.fraud?.reviewedAt).toBeTruthy();

    const audits = await AuditLog.find({ subjectId: order?._id }).lean();
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("review.verified");
  });

  it("markRejected cancels the order and adjusts merchant stats", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const risky = await seedRiskyOrder(caller, m._id);

    const before = await MerchantStats.findOne({ merchantId: m._id }).lean();
    expect(before?.pending).toBe(1);

    const res = await caller.fraud.markRejected({ id: risky.id, notes: "Fake order" });
    expect(res.reviewStatus).toBe("rejected");
    expect(res.orderStatus).toBe("cancelled");
    expect(res.codSaved).toBe(12000);

    const order = await Order.findById(risky.id).lean();
    expect(order?.fraud?.reviewStatus).toBe("rejected");
    expect(order?.order.status).toBe("cancelled");

    const after = await MerchantStats.findOne({ merchantId: m._id }).lean();
    expect(after?.pending).toBe(0);
    expect(after?.cancelled).toBe(1);

    const audits = await AuditLog.find({ subjectId: order?._id }).lean();
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toContain("review.rejected");
    expect(actions).toContain("order.cancelled");
  });

  it("markNoAnswer keeps the order in the queue under a different filter", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const risky = await seedRiskyOrder(caller, m._id);

    await caller.fraud.markNoAnswer({ id: risky.id });

    const pending = await caller.fraud.listPendingReviews({
      cursor: null,
      limit: 25,
      filter: "pending_call",
    });
    expect(pending.total).toBe(0);

    const noAnswer = await caller.fraud.listPendingReviews({
      cursor: null,
      limit: 25,
      filter: "no_answer",
    });
    expect(noAnswer.total).toBe(1);
    expect(noAnswer.items[0]!.id).toBe(risky.id);
  });

  it("rejects repeated verification attempts on the same order", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const risky = await seedRiskyOrder(caller, m._id);

    await caller.fraud.markVerified({ id: risky.id });
    await expect(
      caller.fraud.markVerified({ id: risky.id }),
    ).rejects.toThrowError(/not awaiting review/i);
  });

  it("bookShipment is blocked while order is pending review", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const risky = await seedRiskyOrder(caller, m._id);

    await expect(
      caller.orders.bookShipment({
        orderId: risky.id,
        courier: "steadfast",
      }),
    ).rejects.toThrowError(/requires call verification/i);
  });

  it("bookShipment succeeds after verification", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const risky = await seedRiskyOrder(caller, m._id);

    await caller.fraud.markVerified({ id: risky.id });

    const booked = await caller.orders.bookShipment({
      orderId: risky.id,
      courier: "steadfast",
    });
    expect(booked.status).toBe("shipped");
    expect(booked.trackingNumber).toBeTruthy();
  });

  it("bookShipment rejects orders that were rejected during review", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const risky = await seedRiskyOrder(caller, m._id);

    await caller.fraud.markRejected({ id: risky.id });
    await expect(
      caller.orders.bookShipment({
        orderId: risky.id,
        courier: "steadfast",
      }),
    ).rejects.toThrowError(/rejected|cancelled/i);
  });

  it("getReviewStats reports queue + saved COD", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    await caller.orders.createOrder(cleanOrder);
    const risky1 = await seedRiskyOrder(caller, m._id);
    await seedRiskyOrder(caller, m._id, {
      customer: { ...riskyOrder.customer, phone: "+8801788888888" },
    });

    await caller.fraud.markRejected({ id: risky1.id });

    const stats = await caller.fraud.getReviewStats({ days: 7 });
    expect(stats.queue.pending).toBe(1);
    expect(stats.today.rejected).toBe(1);
    expect(stats.today.codSaved).toBe(12000);
  });

  it("rescoreOrder refreshes signals without overwriting terminal review states", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const risky = await seedRiskyOrder(caller, m._id);
    await caller.fraud.markVerified({ id: risky.id });

    const rescored = await caller.fraud.rescoreOrder({ id: risky.id });
    expect(rescored.reviewStatus).toBe("verified");
    expect(rescored.riskScore).toBeGreaterThan(0);
  });
});
