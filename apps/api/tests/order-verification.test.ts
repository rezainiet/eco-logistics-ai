import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { AuditLog, Order } from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { bookSingleShipment } from "../src/server/routers/orders.js";
import { reviewStatusAfterRescore } from "../src/lib/verification.js";
import { computeRisk } from "../src/server/risk.js";

/**
 * Order verification — what this phase adds on top of the existing review
 * queue (fraud.* router): sending any order to verification, structured
 * reason codes, per-order history, rescoring that can't silently undo a
 * merchant's request, and the dispatch gate re-checked atomically (courier
 * booking lock and manual "shipped").
 */

const cleanOrder = {
  customer: { name: "Karim Ahmed", phone: "+8801700000001", address: "Road 2, House 5", district: "Dhaka" },
  items: [{ name: "Shirt", quantity: 1, price: 500 }],
  cod: 500,
};

const riskyOrder = {
  customer: { name: "xxx", phone: "+8801799999999", address: "House 1", district: "unknown" },
  items: [{ name: "Phone", quantity: 1, price: 12000 }],
  cod: 12000,
};

async function seedRisky(caller: ReturnType<typeof callerFor>, merchantId: Types.ObjectId) {
  await Order.create({
    merchantId,
    orderNumber: `PRIOR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    customer: { name: "Prior", phone: riskyOrder.customer.phone, address: "Prev", district: "Dhaka" },
    items: [{ name: "X", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "rto" },
  });
  const created = await caller.orders.createOrder(riskyOrder);
  expect(created.risk.reviewStatus).toBe("pending_call");
  return created;
}

async function shop(tier?: "starter" | "growth") {
  const m = await createMerchant(tier ? { tier } : {});
  return { m, caller: callerFor(authUserFor(m)) };
}

const reviewOf = async (id: string) => (await Order.findById(id).lean())!.fraud;

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

describe("send to verification", () => {
  it("puts a bookable order into the queue, blocks booking until verified, then books", async () => {
    const { caller } = await shop();
    const o = await caller.orders.createOrder(cleanOrder);
    expect(o.risk.reviewStatus).toBe("not_required");

    const r = await caller.fraud.requestVerification({ id: o.id, reasonCode: "high_value", notes: "big order" });
    expect(r).toEqual({ id: o.id, reviewStatus: "pending_call" });
    const f = await reviewOf(o.id);
    expect(f).toMatchObject({ reviewStatus: "pending_call", reviewReasonCode: "high_value", reviewNotes: "big order" });
    expect(f?.manualReviewAt).toBeInstanceOf(Date);

    const queue = await caller.fraud.listPendingReviews({ filter: "all_open", limit: 25, cursor: null });
    expect(queue.items.map((i) => i.id)).toContain(o.id);

    await expect(caller.orders.bookShipment({ orderId: o.id, courier: "steadfast" })).rejects.toThrowError(/requires call verification/i);

    await caller.fraud.markVerified({ id: o.id, reasonCode: "confirmed_by_call" });
    const booked = await caller.orders.bookShipment({ orderId: o.id, courier: "steadfast" });
    expect(booked.status).toBe("shipped");
  });

  it("is refused once dispatch has started, for cancelled orders, and twice in a row", async () => {
    const { caller } = await shop();
    const shipped = await caller.orders.createOrder(cleanOrder);
    await caller.orders.bookShipment({ orderId: shipped.id, courier: "steadfast" });
    await expect(caller.fraud.requestVerification({ id: shipped.id })).rejects.toThrowError(/already being dispatched|only orders not yet dispatched/);

    const cancelled = await caller.orders.createOrder({ ...cleanOrder, customer: { ...cleanOrder.customer, phone: "+8801700000002" } });
    await caller.orders.updateOrder({ id: cancelled.id, status: "cancelled" });
    await expect(caller.fraud.requestVerification({ id: cancelled.id })).rejects.toThrowError(/not yet dispatched/);

    const twice = await caller.orders.createOrder({ ...cleanOrder, customer: { ...cleanOrder.customer, phone: "+8801700000003" } });
    await caller.fraud.requestVerification({ id: twice.id });
    await expect(caller.fraud.requestVerification({ id: twice.id })).rejects.toThrowError(/awaiting verification/);
  });

  it("is refused while a courier booking is in flight", async () => {
    const { caller } = await shop();
    const o = await caller.orders.createOrder(cleanOrder);
    await Order.updateOne({ _id: o.id }, { $set: { "logistics.bookingInFlight": true } });
    await expect(caller.fraud.requestVerification({ id: o.id })).rejects.toThrowError(/already being dispatched/);
    expect((await reviewOf(o.id))?.reviewStatus).toBe("not_required");
  });

  it("is merchant-scoped and plan-gated", async () => {
    const a = await shop();
    const b = await shop();
    const o = await a.caller.orders.createOrder(cleanOrder);
    await expect(b.caller.fraud.requestVerification({ id: o.id })).rejects.toThrowError(/not found/i);
    expect((await reviewOf(o.id))?.reviewStatus).toBe("not_required");

    const starter = await shop("starter");
    const so = await starter.caller.orders.createOrder(cleanOrder);
    await expect(starter.caller.fraud.requestVerification({ id: so.id })).rejects.toThrowError(/not available/i);
  });
});

describe("reason codes", () => {
  it("are stored on the order and in the audit trail; a bad code changes nothing", async () => {
    const { m, caller } = await shop();
    const o = await seedRisky(caller, m._id as Types.ObjectId);

    await expect(caller.fraud.markRejected({ id: o.id, reasonCode: "made_up" })).rejects.toThrowError(/unknown reason code/);
    expect((await reviewOf(o.id))?.reviewStatus).toBe("pending_call");
    // A verify-only code is not valid for a rejection.
    await expect(caller.fraud.markRejected({ id: o.id, reasonCode: "confirmed_by_call" })).rejects.toThrowError(/unknown reason code/);

    await caller.fraud.markNoAnswer({ id: o.id, reasonCode: "phone_off" });
    expect((await reviewOf(o.id))?.reviewReasonCode).toBe("phone_off");

    await caller.fraud.markRejected({ id: o.id, reasonCode: "fake_order", notes: "prank" });
    const after = (await Order.findById(o.id).lean())!;
    expect(after.fraud).toMatchObject({ reviewStatus: "rejected", reviewReasonCode: "fake_order" });
    expect(after.order.status).toBe("cancelled");
    expect(after.automation?.rejectionReason).toBe("prank");
    const audit = await AuditLog.findOne({ subjectId: after._id, action: "review.rejected" }).lean();
    expect(audit?.meta).toMatchObject({ reasonCode: "fake_order", notes: "prank" });
  });

  it("a decision without a code clears the previous one", async () => {
    const { m, caller } = await shop();
    const o = await seedRisky(caller, m._id as Types.ObjectId);
    await caller.fraud.markNoAnswer({ id: o.id, reasonCode: "no_pickup" });
    await caller.fraud.markVerified({ id: o.id });
    expect((await reviewOf(o.id))?.reviewReasonCode).toBeUndefined();
  });
});

describe("verification history", () => {
  it("lists this order's verification events in order, with reasons", async () => {
    const { caller } = await shop();
    const o = await caller.orders.createOrder(cleanOrder);
    await caller.fraud.requestVerification({ id: o.id, reasonCode: "new_customer" });
    await caller.fraud.markNoAnswer({ id: o.id, reasonCode: "no_pickup" });
    await caller.fraud.markVerified({ id: o.id, reasonCode: "confirmed_by_call", notes: "called twice" });
    // writeAudit is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 100));

    const history = await caller.fraud.getVerificationHistory({ id: o.id });
    const decisions = history.filter((h) => h.action.startsWith("review."));
    expect(decisions.map((h) => [h.action, h.reasonCode])).toEqual([
      ["review.requested", "new_customer"],
      ["review.no_answer", "no_pickup"],
      ["review.verified", "confirmed_by_call"],
    ]);
    expect(decisions[2]!.notes).toBe("called twice");
    expect(decisions[0]!.actor).toBe("merchant");
  });

  it("never shows another merchant's order", async () => {
    const a = await shop();
    const b = await shop();
    const o = await a.caller.orders.createOrder(cleanOrder);
    await expect(b.caller.fraud.getVerificationHistory({ id: o.id })).rejects.toThrowError(/not found/i);
  });
});

describe("rescoring", () => {
  it("rule: decisions stay, a merchant's request stays awaiting review, everything else follows the score", () => {
    expect(reviewStatusAfterRescore("verified", "pending_call", false)).toBe("verified");
    expect(reviewStatusAfterRescore("rejected", "not_required", true)).toBe("rejected");
    expect(reviewStatusAfterRescore("pending_call", "not_required", true)).toBe("pending_call");
    expect(reviewStatusAfterRescore("no_answer", "optional_review", true)).toBe("no_answer");
    expect(reviewStatusAfterRescore("pending_call", "not_required", false)).toBe("not_required");
    expect(reviewStatusAfterRescore("not_required", "pending_call", false)).toBe("pending_call");
  });

  it("a rescore can't make a manually requested order bookable again", async () => {
    const { caller } = await shop();
    const o = await caller.orders.createOrder(cleanOrder);
    await caller.fraud.requestVerification({ id: o.id });
    const res = await caller.fraud.rescoreOrder({ id: o.id });
    expect(res.reviewStatus).toBe("pending_call");
    await expect(caller.orders.bookShipment({ orderId: o.id, courier: "steadfast" })).rejects.toThrowError(/requires call verification/i);
  });
});

describe("dispatch gate", () => {
  it("the booking lock re-checks verification: an order sent to review after the pre-check is not booked", async () => {
    const { m, caller } = await shop();
    const o = await caller.orders.createOrder(cleanOrder);
    // Race: booking reads the order (still bookable), then — before it takes
    // the lock — the order is sent to verification.
    const realFindOne = Order.findOne.bind(Order);
    vi.spyOn(Order, "findOne").mockImplementationOnce(((...args: Parameters<typeof Order.findOne>) => {
      return (async () => {
        const snapshot = await realFindOne(...args);
        await Order.updateOne({ _id: o.id }, { $set: { "fraud.reviewStatus": "pending_call", "fraud.manualReviewAt": new Date() } });
        return snapshot;
      })();
    }) as unknown as typeof Order.findOne);

    const res = await bookSingleShipment({ merchantId: m._id as Types.ObjectId, userId: String(m._id), orderId: o.id, courier: "steadfast" });
    expect(res).toMatchObject({ ok: false, code: "CONFLICT" });
    if (!res.ok) expect(res.error).toMatch(/requires call verification/);
    const after = (await Order.findById(o.id).lean())!;
    expect(after.logistics?.trackingNumber ?? null).toBeNull();
    expect(after.logistics?.bookingInFlight ?? false).toBe(false);
    expect(after.order.status).toBe("pending");
  });

  it("marking an order shipped by hand is blocked until it's verified", async () => {
    const { m, caller } = await shop();
    const o = await seedRisky(caller, m._id as Types.ObjectId);
    await caller.orders.updateOrder({ id: o.id, status: "confirmed" });
    await caller.orders.updateOrder({ id: o.id, status: "packed" });
    await expect(caller.orders.updateOrder({ id: o.id, status: "shipped" })).rejects.toThrowError(/requires call verification before dispatch/);
    expect((await Order.findById(o.id).lean())!.order.status).toBe("packed");

    await caller.fraud.markVerified({ id: o.id });
    await caller.orders.updateOrder({ id: o.id, status: "shipped" });
    expect((await Order.findById(o.id).lean())!.order.status).toBe("shipped");
  });

  it("orders that never needed review ship by hand as before", async () => {
    const { caller } = await shop();
    const o = await caller.orders.createOrder(cleanOrder);
    for (const status of ["confirmed", "packed", "shipped"] as const) await caller.orders.updateOrder({ id: o.id, status });
    expect((await Order.findById(o.id).lean())!.order.status).toBe("shipped");
  });

  it("the watch list (medium risk) is listable and can be sent to verification", async () => {
    const { caller } = await shop();
    const o = await caller.orders.createOrder(cleanOrder);
    await Order.updateOne({ _id: o.id }, { $set: { "fraud.reviewStatus": "optional_review", "fraud.level": "medium" } });
    const watch = await caller.fraud.listPendingReviews({ filter: "watch", limit: 25, cursor: null });
    expect(watch.items.map((i) => i.id)).toEqual([o.id]);
    await caller.fraud.requestVerification({ id: o.id, reasonCode: "suspicious_details" });
    const open = await caller.fraud.listPendingReviews({ filter: "all_open", limit: 25, cursor: null });
    expect(open.items.map((i) => i.id)).toEqual([o.id]);
  });
});

describe("verification rules: blocked phones", () => {
  const zero = {
    phoneOrdersCount: 0, phoneReturnedCount: 0, phoneCancelledCount: 0, phoneUnreachableCount: 0,
    ipRecentCount: 0, phoneVelocityCount: 0, addressDistinctPhones: 0, addressReturnedCount: 0,
  };
  const customer = { name: "Karim Ahmed", phone: "+8801711111111", address: "Road 2, House 5", district: "Dhaka" };

  it("match however the merchant typed the number (01…, 8801…, +880…)", () => {
    for (const entry of ["01711111111", "8801711111111", "+880 1711-111111", "+8801711111111"]) {
      const r = computeRisk({ cod: 500, customer }, zero, { blockedPhones: [entry] });
      expect(r.signals.map((s) => s.key), entry).toContain("blocked_phone");
      expect(r.reviewStatus, entry).toBe("pending_call");
    }
    const other = computeRisk({ cod: 500, customer }, zero, { blockedPhones: ["01711111112"] });
    expect(other.signals.map((s) => s.key)).not.toContain("blocked_phone");
  });

  it("an order from a phone saved in local format goes straight to verification", async () => {
    const { caller } = await shop();
    await caller.merchants.updateFraudConfig({ blockedPhones: ["01700000001"] });
    const o = await caller.orders.createOrder(cleanOrder);
    expect(o.risk.reviewStatus).toBe("pending_call");
    await expect(caller.orders.bookShipment({ orderId: o.id, courier: "steadfast" })).rejects.toThrowError(/requires call verification/i);
  });
});
