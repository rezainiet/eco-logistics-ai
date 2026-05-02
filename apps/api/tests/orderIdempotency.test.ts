import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Order, Usage, currentUsagePeriod } from "@ecom/db";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";

/**
 * Exactly-once order creation — Mongo-transaction guarantees.
 *
 * The createOrder mutation wraps idempotency re-check + quota reservation +
 * Order insert in a single multi-document transaction. The unique sparse
 * index on (merchantId, source.clientRequestId) is the authoritative
 * cross-process guard. These tests pin three failure modes the audit flagged:
 *
 *   1. double-click (sequential) — two requests with the same clientRequestId
 *      from the same caller must collapse to one order.
 *   2. concurrent re-submission — two requests dispatched in parallel race the
 *      transaction; exactly one inserts, the other returns idempotent=true.
 *      Quota is incremented exactly once.
 *   3. crash-recovery retry — a client retries after our process crashed mid-
 *      flight. Whether the original tx committed or aborted, the retry sees
 *      either the existing order (idempotent) or successfully creates one,
 *      but NEVER produces a duplicate or a half-counted quota.
 */

const baseInput = (clientRequestId: string) => ({
  customer: {
    name: "Karim Ahmed",
    phone: "+8801712345678",
    address: "House 1, Road 1, Dhanmondi",
    district: "Dhaka",
  },
  items: [{ name: "Widget", quantity: 1, price: 500 }],
  cod: 500,
  clientRequestId,
});

async function quotaUsed(merchantId: unknown): Promise<number> {
  const period = currentUsagePeriod();
  const doc = await Usage.findOne({ merchantId, period }).lean();
  return doc?.ordersCreated ?? 0;
}

describe("createOrder exactly-once", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("double-click with same clientRequestId returns one order, one quota increment", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));

    const a = await caller.orders.createOrder(baseInput("req-double-1"));
    const b = await caller.orders.createOrder(baseInput("req-double-1"));

    expect(a.idempotent).toBe(false);
    expect(b.idempotent).toBe(true);
    expect(b.id).toBe(a.id);
    expect(b.orderNumber).toBe(a.orderNumber);

    const orders = await Order.find({
      merchantId: m._id,
      "source.clientRequestId": "req-double-1",
    }).lean();
    expect(orders).toHaveLength(1);
    expect(await quotaUsed(m._id)).toBe(1);
  });

  it("concurrent submissions with same clientRequestId collapse to one order + one quota increment", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));

    // Same caller dispatches BOTH requests in parallel — the in-tx idempotency
    // re-check + the unique-index race resolve to exactly one insert. Whichever
    // tx commits first wins; the other receives a duplicate-key error inside
    // its tx, aborts (rolling back its quota $inc), and the catch block
    // returns the existing order to the caller.
    const cid = "req-concurrent-1";
    const [a, b] = await Promise.all([
      caller.orders.createOrder(baseInput(cid)),
      caller.orders.createOrder(baseInput(cid)),
    ]);

    expect(a.id).toBe(b.id);
    expect(a.orderNumber).toBe(b.orderNumber);
    // Exactly one of the two responses reports idempotent=true.
    expect([a.idempotent, b.idempotent].filter(Boolean)).toHaveLength(1);

    const orders = await Order.find({
      merchantId: m._id,
      "source.clientRequestId": cid,
    }).lean();
    expect(orders).toHaveLength(1);
    expect(await quotaUsed(m._id)).toBe(1);
  });

  it("crash-recovery retry after a successful commit returns the existing order", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const cid = "req-crash-recovery-1";

    // Simulate the original request's commit. Then the client (not knowing
    // whether the response was lost or the server crashed) retries with the
    // same clientRequestId. The retry MUST return the existing order, not
    // create a second one nor double-charge the quota.
    const original = await caller.orders.createOrder(baseInput(cid));
    expect(original.idempotent).toBe(false);

    const retry = await caller.orders.createOrder(baseInput(cid));
    expect(retry.idempotent).toBe(true);
    expect(retry.id).toBe(original.id);

    const orders = await Order.find({
      merchantId: m._id,
      "source.clientRequestId": cid,
    }).lean();
    expect(orders).toHaveLength(1);
    expect(await quotaUsed(m._id)).toBe(1);
  });

  it("crash-recovery retry after an ABORTED tx still produces exactly one order on retry", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const cid = "req-crash-aborted-1";

    // Pre-conditions: the merchant has zero orders, zero quota usage. We can't
    // easily kill the process mid-tx in a unit test, but we CAN simulate the
    // observable end-state of an aborted tx: nothing was written. Then the
    // client retries. The retry must succeed AND the tally must show 1 order
    // and 1 quota increment (NOT 0+1 leftover from a phantom abort, NOT 2).
    expect(await Order.countDocuments({ merchantId: m._id })).toBe(0);
    expect(await quotaUsed(m._id)).toBe(0);

    const retry = await caller.orders.createOrder(baseInput(cid));
    expect(retry.idempotent).toBe(false);

    const orders = await Order.find({ merchantId: m._id }).lean();
    expect(orders).toHaveLength(1);
    expect(await quotaUsed(m._id)).toBe(1);

    // Second crash-recovery retry — same cid — collapses to the existing.
    const retry2 = await caller.orders.createOrder(baseInput(cid));
    expect(retry2.idempotent).toBe(true);
    expect(retry2.id).toBe(retry.id);
    expect(await Order.countDocuments({ merchantId: m._id })).toBe(1);
    expect(await quotaUsed(m._id)).toBe(1);
  });

  it("requests WITHOUT clientRequestId are NOT idempotent (sanity check)", async () => {
    // Without a clientRequestId there is no idempotency key to dedupe on —
    // the mutation produces a fresh order each time. Any change to that
    // contract should be a deliberate decision, not a regression of the
    // exactly-once tx affecting the no-id path.
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const noId = { ...baseInput("ignored") } as Record<string, unknown>;
    delete noId.clientRequestId;

    const a = await caller.orders.createOrder(noId as never);
    const b = await caller.orders.createOrder(noId as never);

    expect(a.id).not.toBe(b.id);
    expect(await Order.countDocuments({ merchantId: m._id })).toBe(2);
    expect(await quotaUsed(m._id)).toBe(2);
  });

  it("the unique idempotency index on (merchantId, clientRequestId) is in place", async () => {
    // Belt-and-braces: the in-tx re-check is the FAST path; this index is the
    // last-line cross-process defense. If someone ever drops it, this test
    // fires before the duplicate-order incident does.
    const indexes = await Order.collection.indexes();
    const idemp = indexes.find(
      (i) =>
        i.unique === true &&
        i.key &&
        i.key.merchantId === 1 &&
        i.key["source.clientRequestId"] === 1,
    );
    expect(idemp).toBeDefined();
    expect(idemp?.partialFilterExpression).toBeDefined();
  });
});
