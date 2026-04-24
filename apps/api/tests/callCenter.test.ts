import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

const sampleOrder = {
  customer: {
    name: "Jane Doe",
    phone: "+8801711111111",
    address: "House 1, Road 1",
    district: "Dhaka",
  },
  items: [{ name: "T-Shirt", quantity: 1, price: 500 }],
  cod: 500,
};

describe("callCenterRouter", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("logCall creates a standalone call (no orderId)", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const res = await caller.callCenter.logCall({
      duration: 45,
      answered: true,
      successful: true,
      callType: "outgoing",
      customerPhone: "+8801700000001",
      notes: "confirmation call",
    });

    expect(res.id).toBeTruthy();
    expect(typeof res.hour).toBe("number");
  });

  it("logCall verifies ownership when orderId is provided", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const order = await caller.orders.createOrder(sampleOrder);

    const res = await caller.callCenter.logCall({
      orderId: order.id,
      duration: 30,
      answered: true,
      callType: "outgoing",
    });
    expect(res.id).toBeTruthy();
  });

  it("logCall rejects orders owned by another merchant", async () => {
    const owner = await createMerchant({ email: `owner-${Date.now()}@test.com` });
    const stranger = await createMerchant({ email: `stranger-${Date.now()}@test.com` });
    const order = await callerFor(authUserFor(owner)).orders.createOrder(sampleOrder);

    await expect(
      callerFor(authUserFor(stranger)).callCenter.logCall({
        orderId: order.id,
        duration: 10,
        answered: false,
      }),
    ).rejects.toThrowError(/not found/i);
  });

  it("getCallLogs returns cursor-paginated results with callType filter", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    for (let i = 0; i < 5; i++) {
      await caller.callCenter.logCall({
        duration: 20 + i,
        answered: i % 2 === 0,
        callType: i % 2 === 0 ? "outgoing" : "incoming",
      });
    }

    const firstPage = await caller.callCenter.getCallLogs({
      limit: 2,
      callType: "all",
      cursor: null,
    });
    expect(firstPage.calls).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();

    const nextPage = await caller.callCenter.getCallLogs({
      limit: 2,
      callType: "all",
      cursor: firstPage.nextCursor,
    });
    expect(nextPage.calls).toHaveLength(2);
    expect(nextPage.calls[0]!.id).not.toBe(firstPage.calls[0]!.id);

    const onlyOutgoing = await caller.callCenter.getCallLogs({
      limit: 10,
      callType: "outgoing",
      cursor: null,
    });
    expect(onlyOutgoing.calls.every((c) => c.callType === "outgoing")).toBe(true);
    expect(onlyOutgoing.calls.length).toBe(3);
  });

  it("getCallAnalytics computes answer and success rates", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    await caller.callCenter.logCall({ duration: 60, answered: true, successful: true });
    await caller.callCenter.logCall({ duration: 30, answered: true, successful: false });
    await caller.callCenter.logCall({ duration: 0, answered: false });
    await caller.callCenter.logCall({ duration: 45, answered: true, successful: true });

    const a = await caller.callCenter.getCallAnalytics({ days: 30 });
    expect(a.totalCalls).toBe(4);
    expect(a.answeredCalls).toBe(3);
    expect(a.successfulCalls).toBe(2);
    expect(a.answerRate).toBe(75);
    expect(a.successRate).toBe(67);
    expect(a.avgDurationSeconds).toBeGreaterThan(0);
    expect(a.totalDurationSeconds).toBe(135);
  });

  it("getCallAnalytics scopes results to the requesting merchant", async () => {
    const a1 = await createMerchant({ email: `a1-${Date.now()}@test.com` });
    const a2 = await createMerchant({ email: `a2-${Date.now()}@test.com` });

    await callerFor(authUserFor(a1)).callCenter.logCall({ duration: 10, answered: true });
    await callerFor(authUserFor(a1)).callCenter.logCall({ duration: 15, answered: true });
    await callerFor(authUserFor(a2)).callCenter.logCall({ duration: 20, answered: false });

    const res = await callerFor(authUserFor(a2)).callCenter.getCallAnalytics({ days: 30 });
    expect(res.totalCalls).toBe(1);
    expect(res.answeredCalls).toBe(0);
  });
});
