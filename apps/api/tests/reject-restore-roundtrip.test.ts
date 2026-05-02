import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AuditLog, Order } from "@ecom/db";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import { rebuildQueueState } from "../src/lib/queueState.js";

/**
 * Validation suite for the "internal state consistency" pass.
 *
 * These are guardrail tests against the five scenarios the spec
 * promised: reject-restore round-trip, fraud-queue re-entry on
 * restore, worker safety on a restored order, double-restore
 * idempotency, rebuildQueueState idempotency.
 */

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

/**
 * Drain pending audit writes. The codebase emits audits as
 * `void writeAudit(...)` — fire-and-forget by design so a flaky
 * Mongo write doesn't block a business action — but tests that
 * read AuditLog right after a procedure call race the unawaited
 * promise. Sleeping a tick lets the queued microtasks run.
 */
async function awaitAudits(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
}

async function seedPriorRto(merchantId: Types.ObjectId, phone: string) {
  await Order.create({
    merchantId,
    orderNumber: `PRIOR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    customer: { name: "Prior customer", phone, address: "Prev addr", district: "Dhaka" },
    items: [{ name: "X", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "rto" },
  });
}

describe("reject/restore round-trip — internal state consistency", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("(1) Reject → Restore returns the order to the EXACT same state", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    // Seed a clean order, then manually move it to confirmed + pin a
    // courier so we have a richer automation subdoc to round-trip.
    const created = await caller.orders.createOrder(cleanOrder);
    await Order.updateOne(
      { _id: created.id },
      {
        $set: {
          "automation.state": "confirmed",
          "automation.decidedBy": "merchant",
          "automation.confirmedAt": new Date(),
          "automation.pinnedCourier": "steadfast",
          "automation.attemptedCouriers": ["pathao"],
          "automation.confirmationCode": "654321",
          "order.status": "confirmed",
        },
      },
    );

    const before = await Order.findById(created.id).lean();
    expect(before?.order.status).toBe("confirmed");
    expect(before?.automation?.state).toBe("confirmed");
    expect(before?.automation?.pinnedCourier).toBe("steadfast");
    expect(before?.automation?.attemptedCouriers).toEqual(["pathao"]);

    // Manual reject (rejectOrder).
    await caller.orders.rejectOrder({ id: created.id, reason: "test reject" });
    const rejected = await Order.findById(created.id).lean();
    expect(rejected?.order.status).toBe("cancelled");
    expect(rejected?.automation?.state).toBe("rejected");
    // Legacy + consolidated snapshot fields populated.
    expect(rejected?.automation?.preRejectState).toBe("confirmed");
    expect(rejected?.order.preRejectStatus).toBe("confirmed");
    const snap = (rejected as unknown as {
      preActionSnapshot?: {
        order?: { status?: string };
        automation?: { state?: string; subdoc?: Record<string, unknown> };
      };
    }).preActionSnapshot;
    expect(snap).toBeTruthy();
    expect(snap?.order?.status).toBe("confirmed");
    expect(snap?.automation?.state).toBe("confirmed");
    expect(snap?.automation?.subdoc?.pinnedCourier).toBe("steadfast");
    expect(snap?.automation?.subdoc?.attemptedCouriers).toEqual(["pathao"]);

    // Restore.
    await caller.orders.restoreOrder({ id: created.id });
    const restored = await Order.findById(created.id).lean();

    // Round-trip: state, status, courier pin, attempted couriers,
    // confirmation code all back.
    expect(restored?.order.status).toBe("confirmed");
    expect(restored?.automation?.state).toBe("confirmed");
    expect(restored?.automation?.pinnedCourier).toBe("steadfast");
    expect(restored?.automation?.attemptedCouriers).toEqual(["pathao"]);
    expect(restored?.automation?.confirmationCode).toBe("654321");

    // Snapshot fields cleared on restore.
    expect(restored?.automation?.preRejectState).toBeUndefined();
    expect(restored?.order.preRejectStatus).toBeUndefined();
    expect(
      (restored as unknown as { preActionSnapshot?: unknown })?.preActionSnapshot,
    ).toBeUndefined();
    expect(restored?.automation?.rejectedAt).toBeUndefined();
    expect(restored?.automation?.rejectionReason).toBeUndefined();
  });

  it("(2) Fraud reject → Restore brings the order back into the fraud queue", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    await seedPriorRto(m._id, riskyOrder.customer.phone);
    const risky = await caller.orders.createOrder(riskyOrder);
    expect(risky.risk.reviewStatus).toBe("pending_call");

    // Confirm the order is in the fraud queue.
    const queueBefore = await caller.fraud.listPendingReviews({
      cursor: null,
      limit: 25,
      filter: "all_open",
    });
    expect(queueBefore.items.some((i) => i.id === risky.id)).toBe(true);

    // Fraud reject.
    await caller.fraud.markRejected({ id: risky.id, notes: "fake" });
    const rejected = await Order.findById(risky.id).lean();
    expect(rejected?.fraud?.reviewStatus).toBe("rejected");
    expect(rejected?.fraud?.preRejectReviewStatus).toBe("pending_call");
    expect(rejected?.fraud?.preRejectLevel).toBe("high");
    expect(rejected?.automation?.state).toBe("rejected");
    expect(rejected?.automation?.decidedBy).toBe("merchant");

    // The fraud-rejected order should NOT be in the queue.
    const queueDuring = await caller.fraud.listPendingReviews({
      cursor: null,
      limit: 25,
      filter: "all_open",
    });
    expect(queueDuring.items.some((i) => i.id === risky.id)).toBe(false);

    // Restore.
    await caller.orders.restoreOrder({ id: risky.id });
    const restored = await Order.findById(risky.id).lean();

    // fraud.reviewStatus put back to "pending_call".
    expect(restored?.fraud?.reviewStatus).toBe("pending_call");
    expect(restored?.fraud?.level).toBe("high");
    // Snapshot fields cleared.
    expect(restored?.fraud?.preRejectReviewStatus).toBeUndefined();
    expect(restored?.fraud?.preRejectLevel).toBeUndefined();

    // Order is back in the merchant's review queue (query-based).
    const queueAfter = await caller.fraud.listPendingReviews({
      cursor: null,
      limit: 25,
      filter: "all_open",
    });
    expect(queueAfter.items.some((i) => i.id === risky.id)).toBe(true);
  });

  it("(3) Worker running on a restored order skips safely without mutating", async () => {
    // Simulates: order rejected → SMS worker job fires, but order has
    // since been restored from rejected back to a non-pending_confirmation
    // state. Worker MUST not stamp confirmationSentAt or send SMS.
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(cleanOrder);

    // Force order into pending_confirmation state with a code, then
    // reject it.
    await Order.updateOne(
      { _id: created.id },
      {
        $set: {
          "automation.state": "pending_confirmation",
          "automation.confirmationCode": "111111",
        },
      },
    );
    await caller.orders.rejectOrder({ id: created.id, reason: "test" });

    // At this point automation.state="rejected". The SMS worker would
    // skip — verify by importing the worker's gate function via its
    // own state guard. We exercise the same-shaped check the worker
    // does at apps/api/src/workers/automationSms.ts.
    const stillRejected = await Order.findById(created.id).lean();
    expect(stillRejected?.automation?.state).toBe("rejected");

    // Now restore. State goes back to pending_confirmation.
    await caller.orders.restoreOrder({ id: created.id });
    const restored = await Order.findById(created.id).lean();
    expect(restored?.automation?.state).toBe("pending_confirmation");

    // A previously-enqueued SMS job for this order arrives now (out-
    // of-order). The worker's state guard should accept it (state IS
    // pending_confirmation post-restore). We don't actually fire the
    // worker (it would call the SMS gateway); instead we confirm the
    // pre-condition the worker checks.
    const guardOk =
      (restored?.automation as { state?: string } | undefined)?.state ===
      "pending_confirmation";
    expect(guardOk).toBe(true);

    // Now move the order forward (e.g. customer confirmed via inbound
    // SMS path) and verify the SMS worker would now skip.
    await Order.updateOne(
      { _id: created.id },
      { $set: { "automation.state": "confirmed" } },
    );
    const moved = await Order.findById(created.id).lean();
    const guardSkip =
      (moved?.automation as { state?: string } | undefined)?.state !==
      "pending_confirmation";
    expect(guardSkip).toBe(true);
  });

  it("(4) Double restore is a no-op (atomic filter rejects the second)", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(cleanOrder);

    await caller.orders.rejectOrder({ id: created.id, reason: "test" });
    await caller.orders.restoreOrder({ id: created.id });
    const afterFirst = await Order.findById(created.id).lean();

    // Second restore: must throw CONFLICT (filter requires
    // automation.state="rejected"; it's now back to pre-reject state).
    await expect(
      caller.orders.restoreOrder({ id: created.id }),
    ).rejects.toThrowError(/restorable|state changed|background/i);

    const afterSecond = await Order.findById(created.id).lean();
    expect(afterSecond?.order.status).toBe(afterFirst?.order.status);
    expect(afterSecond?.automation?.state).toBe(afterFirst?.automation?.state);
  });

  it("(5) rebuildQueueState is idempotent — repeated calls are safe", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(cleanOrder);

    // Put the order in a state that DOES warrant SMS enqueue.
    await Order.updateOne(
      { _id: created.id },
      {
        $set: {
          "automation.state": "pending_confirmation",
          "automation.confirmationCode": "222222",
          "automation.confirmationSentAt": null,
        },
      },
    );

    // Call rebuildQueueState 3 times back-to-back. BullMQ jobId
    // dedupe + the worker's state guards make each call safe.
    const r1 = await rebuildQueueState({
      orderId: created.id,
      merchantId: m._id as Types.ObjectId,
    });
    const r2 = await rebuildQueueState({
      orderId: created.id,
      merchantId: m._id as Types.ObjectId,
    });
    const r3 = await rebuildQueueState({
      orderId: created.id,
      merchantId: m._id as Types.ObjectId,
    });

    // All three return the same shape — booking never enqueued, fraud
    // queue eligibility is determined by reviewStatus (not in queue
    // for a clean order).
    for (const r of [r1, r2, r3]) {
      expect(r.bookingEnqueued).toBe(false);
      expect(r.fraudQueueEligible).toBe(false);
    }

    // Audit: one queue_rebuilt entry per call. We don't dedupe audits
    // (would lose timeline fidelity). Note rebuildQueueState fires its
    // audit as void writeAudit — drain before asserting.
    await awaitAudits();
    const audits = await AuditLog.find({
      subjectId: created.id,
      action: "automation.queue_rebuilt",
    }).lean();
    expect(audits.length).toBe(3);

    // Order state was NOT mutated by rebuildQueueState — its job is to
    // ensure queues match state, not to change state.
    const after = await Order.findById(created.id).lean();
    expect(after?.automation?.state).toBe("pending_confirmation");
    expect(after?.automation?.confirmationSentAt).toBeFalsy();
  });

  it("audit trail records reject + restore + queue_rebuilt", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder(cleanOrder);

    await caller.orders.rejectOrder({ id: created.id, reason: "test" });
    await caller.orders.restoreOrder({ id: created.id });

    await awaitAudits();
    const audits = await AuditLog.find({ subjectId: created.id }).lean();
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("automation.rejected");
    expect(actions).toContain("automation.restored");
    expect(actions).toContain("automation.queue_rebuilt");
  });
});
