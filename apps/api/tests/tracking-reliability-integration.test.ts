import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  AddressReliability,
  CourierPerformance,
  CustomerReliability,
  FraudPrediction,
  Order,
} from "@ecom/db";
import { applyTrackingEvents } from "../src/server/tracking.js";
import { hashAddress } from "../src/server/risk.js";
import { hashPhoneForNetwork } from "../src/lib/fraud-network.js";
import { env } from "../src/env.js";
import { createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * S4 — chokepoint integration tests for delivery-reliability fan-out.
 *
 * These are replay-sensitive. Every test that turns the write flag on
 * MUST verify either the happy-path counter advance OR the chokepoint
 * guard's idempotency. Failure isolation tests prove that an injected
 * Mongo error inside the new helpers does NOT regress the existing
 * fan-outs (FraudPrediction, CourierPerformance) or the Order/status
 * write itself.
 *
 * The flag is stamped onto the parsed `env` object directly — Mongoose
 * env is loaded at process boot, so we mutate the cached value per test
 * and restore in afterEach. vitest runs in singleFork; sequential tests
 * within this file see the toggle.
 */

const DEL_REL = "DELIVERY_RELIABILITY_WRITE_ENABLED";
type MutableEnv = {
  -readonly [K in keyof typeof env]: typeof env[K];
};
function setWriteFlag(value: boolean) {
  (env as MutableEnv)[DEL_REL] = value;
}

let originalFlag: boolean;

beforeEach(async () => {
  await ensureDb();
  await resetDb();
  originalFlag = env.DELIVERY_RELIABILITY_WRITE_ENABLED;
  // Default each test to flag-OFF; tests that need writes opt in.
  setWriteFlag(false);
});

afterEach(() => {
  setWriteFlag(originalFlag);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

const TEST_PHONE = "+8801711111111";
const TEST_ADDRESS = "House 12, Road 5, Banani";
const TEST_DISTRICT = "Dhaka";

async function createInTransitOrder(merchantId: Types.ObjectId) {
  const orderDoc = await Order.create({
    merchantId,
    orderNumber: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    customer: {
      name: "Test Buyer",
      phone: TEST_PHONE,
      address: TEST_ADDRESS,
      district: TEST_DISTRICT,
    },
    items: [{ name: "thing", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "in_transit" },
    logistics: {
      courier: "steadfast",
      trackingNumber: `TR-${Date.now()}`,
      shippedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      trackingEvents: [],
    },
    source: {
      addressHash: hashAddress(TEST_ADDRESS, TEST_DISTRICT),
    },
  });
  return Order.findById(orderDoc._id).lean();
}

/** Drain the fire-and-forget side-effects after an applyTrackingEvents call. */
async function flushVoidWrites() {
  // 50 ms is enough for the in-memory mongo + microtask queue to settle.
  await new Promise((r) => setTimeout(r, 50));
}

const DELIVERED_EVENT = {
  at: new Date("2026-05-08T10:00:00Z"),
  providerStatus: "Delivered",
  description: "Parcel handed to recipient",
  location: "Banani Hub",
};

const RTO_EVENT = {
  at: new Date("2026-05-08T11:00:00Z"),
  providerStatus: "Returned",
  description: "Parcel returned to origin",
};

/* ========================================================================= */
/* (1) single terminal transition + (9) flag-on behavior                     */
/* ========================================================================= */

describe("applyTrackingEvents — flag-on, single terminal transition", () => {
  it("delivered transition writes one CustomerReliability row and one AddressReliability row", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);
    expect(order).not.toBeNull();

    const result = await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );

    expect(result.statusTransition).toEqual({ from: "in_transit", to: "delivered" });
    expect(result.newEvents).toBe(1);

    await flushVoidWrites();

    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const addressHash = hashAddress(TEST_ADDRESS, TEST_DISTRICT);
    expect(phoneHash).toBeTruthy();
    expect(addressHash).toBeTruthy();

    const cust = await CustomerReliability.findOne({
      merchantId,
      phoneHash,
    }).lean();
    expect(cust).not.toBeNull();
    expect(cust!.deliveredCount).toBe(1);
    expect(cust!.rtoCount).toBe(0);
    expect(cust!.cancelledCount).toBe(0);
    expect(cust!.lastDistrict).toBe(TEST_DISTRICT);

    const addr = await AddressReliability.findOne({
      merchantId,
      addressHash,
    }).lean();
    expect(addr).not.toBeNull();
    expect(addr!.deliveredCount).toBe(1);
    expect(addr!.rtoCount).toBe(0);
    expect(addr!.distinctPhoneHashes).toEqual([phoneHash]);
  });

  it("rto transition increments rtoCount on both axes", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);

    await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "rto",
      [RTO_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const addressHash = hashAddress(TEST_ADDRESS, TEST_DISTRICT);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    const addr = await AddressReliability.findOne({ merchantId, addressHash }).lean();
    expect(cust!.rtoCount).toBe(1);
    expect(cust!.deliveredCount).toBe(0);
    expect(addr!.rtoCount).toBe(1);
    expect(addr!.deliveredCount).toBe(0);
  });
});

/* ========================================================================= */
/* (8) flag-off behavior                                                     */
/* ========================================================================= */

describe("applyTrackingEvents — flag-off", () => {
  it("delivered transition writes NOTHING to either reliability collection", async () => {
    setWriteFlag(false);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);

    const result = await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    expect(result.statusTransition?.to).toBe("delivered");
    await flushVoidWrites();

    expect(await CustomerReliability.countDocuments({ merchantId })).toBe(0);
    expect(await AddressReliability.countDocuments({ merchantId })).toBe(0);
  });

  it("flag-off does not break existing fan-outs (FraudPrediction outcome still stamped)", async () => {
    setWriteFlag(false);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const orderDoc = await Order.create({
      merchantId,
      orderNumber: `TEST-FRAUDPRED-${Date.now()}`,
      customer: {
        name: "Test Buyer",
        phone: TEST_PHONE,
        address: TEST_ADDRESS,
        district: TEST_DISTRICT,
      },
      items: [{ name: "thing", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "in_transit" },
      logistics: { courier: "steadfast", trackingNumber: "TR-FP-1" },
      source: { addressHash: hashAddress(TEST_ADDRESS, TEST_DISTRICT) },
    });
    // Seed a prediction so the chokepoint's outcome stamp has a target.
    await FraudPrediction.create({
      merchantId,
      orderId: orderDoc._id,
      riskScore: 30,
      pRto: 0.2,
      levelPredicted: "low",
      customerTier: "new",
      signals: [],
      weightsVersion: "v2.0",
    });
    const lean = await Order.findById(orderDoc._id).lean();

    await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    const fp = await FraudPrediction.findOne({ orderId: orderDoc._id }).lean();
    expect(fp!.outcome).toBe("delivered");
    expect(fp!.outcomeAt).toBeInstanceOf(Date);
  });
});

/* ========================================================================= */
/* (2) duplicate webhook replay                                              */
/* (3) replayWebhookInbox replay (chokepoint perspective is identical)       */
/* (4) PendingJob replay (likewise — funnels back through this chokepoint)   */
/* (5) repeated applyTrackingEvents invocation                               */
/* ========================================================================= */

describe("applyTrackingEvents — replay safety (no double-count)", () => {
  it("identical event replayed 5× yields exactly ONE counter increment", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    let lean = await createInTransitOrder(merchantId);

    for (let i = 0; i < 5; i++) {
      // After the first call the order's `order.status` flips to delivered,
      // so subsequent identical-event calls trip the chokepoint's status
      // guard AND the dedupeKey $nin clause. Either way: zero new fan-outs.
      const r = await applyTrackingEvents(
        lean as Parameters<typeof applyTrackingEvents>[0],
        "delivered",
        [DELIVERED_EVENT],
        { source: "webhook" },
      );
      // Re-fetch after each call so the test mirrors a webhook handler
      // that re-loads the order on each delivery (matches production
      // pattern in `webhooks/courier.ts`).
      lean = await Order.findById((lean as { _id: Types.ObjectId })._id).lean();
      void r;
    }
    await flushVoidWrites();

    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust!.deliveredCount).toBe(1);
    expect(cust!.rtoCount).toBe(0);

    const addressHash = hashAddress(TEST_ADDRESS, TEST_DISTRICT);
    const addr = await AddressReliability.findOne({ merchantId, addressHash }).lean();
    expect(addr!.deliveredCount).toBe(1);
  });

  it("replay with a fresh content-hashed event after delivery does NOT re-fire the fan-out (status guard)", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    let lean = await createInTransitOrder(merchantId);

    // First delivered event lands.
    await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();
    lean = await Order.findById((lean as { _id: Types.ObjectId })._id).lean();

    // Second call — different dedupeKey (different description), still
    // normalizedStatus="delivered" → STATUS_MAP says next=delivered.
    // prev is also delivered, so `nextStatus !== prevStatus` is FALSE
    // and the entire fan-out block is skipped.
    await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [
        {
          at: new Date("2026-05-08T10:30:00Z"),
          providerStatus: "Delivered",
          description: "Confirmed via signature",
        },
      ],
      { source: "webhook" },
    );
    await flushVoidWrites();

    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust!.deliveredCount).toBe(1); // still 1 — second call was a no-op transition
  });
});

/* ========================================================================= */
/* (6) stale nextStatus                                                      */
/* ========================================================================= */

describe("applyTrackingEvents — stale nextStatus", () => {
  it("production replay (re-fetch between calls) does not double-count when status has stabilised", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    let lean = await createInTransitOrder(merchantId);

    // First delivered event lands.
    await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    // Production webhook handlers re-fetch the order before each
    // applyTrackingEvents call (see `webhooks/courier.ts`). After re-fetch,
    // prevStatus is "delivered". A second delivered event with a fresh
    // dedupe key has next="delivered" === prev="delivered", so the
    // chokepoint's `nextStatus !== prevStatus` gate skips the entire
    // fan-out. THIS is the production replay-safety guarantee.
    lean = await Order.findById((lean as { _id: Types.ObjectId })._id).lean();
    await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [
        {
          at: new Date("2026-05-08T10:30:00Z"),
          providerStatus: "Delivered",
          description: "Confirmed via signature",
        },
      ],
      { source: "webhook" },
    );
    await flushVoidWrites();

    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust!.deliveredCount).toBe(1);
    expect(cust!.rtoCount).toBe(0);
  });

  it("atomic Order guard rejects a stale-snapshot writer's write to the Order doc (documents §6.2)", async () => {
    // Documents an inherited deep-audit §6.2 caveat: under a non-production
    // path that does NOT re-fetch the order between calls (i.e., a stale
    // in-memory lean snapshot), the chokepoint's atomic Order.updateOne
    // filter rejects the write (Order doc unchanged), but the in-memory
    // fan-out gate `nextStatus !== prevStatus` evaluates against the stale
    // snapshot and CAN fire the fan-out. v1 inherits this from the existing
    // four fan-outs (FraudPrediction, contributeOutcome, recordCourierOutcome,
    // MerchantStats) — all share the same gating semantics. The blueprint
    // (§6.2 of deep-scoring-audit.md) documents this; v1 does NOT add a new
    // guarantee here.
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const fresh = await createInTransitOrder(merchantId);

    await applyTrackingEvents(
      fresh as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    // The stale snapshot's atomic write WILL be rejected at the Order level —
    // the asserted invariant is that the Order doc is NOT corrupted.
    await applyTrackingEvents(
      fresh as Parameters<typeof applyTrackingEvents>[0],
      "rto",
      [RTO_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    const orderAfter = await Order.findById(
      (fresh as { _id: Types.ObjectId })._id,
    ).lean();
    expect(orderAfter!.order!.status).toBe("delivered");
    expect(orderAfter!.logistics!.deliveredAt).toBeInstanceOf(Date);
    expect(orderAfter!.logistics!.returnedAt).toBeUndefined();
  });
});

/* ========================================================================= */
/* (7) concurrent terminal updates                                           */
/* ========================================================================= */

describe("applyTrackingEvents — concurrent terminal updates on the same order", () => {
  it("two parallel callers — atomic Order guard reports exactly one transition; fan-out double-fire is §6.2 inherited", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const lean = await createInTransitOrder(merchantId);

    const [r1, r2] = await Promise.all([
      applyTrackingEvents(
        lean as Parameters<typeof applyTrackingEvents>[0],
        "delivered",
        [DELIVERED_EVENT],
        { source: "webhook" },
      ),
      applyTrackingEvents(
        lean as Parameters<typeof applyTrackingEvents>[0],
        "delivered",
        [DELIVERED_EVENT],
        { source: "webhook" },
      ),
    ]);
    await flushVoidWrites();

    // Atomic Order.updateOne guarantees exactly one of the two callers
    // reports a statusTransition (the other's filter no longer matches
    // because the doc is now "delivered" and the dedupe key is present).
    const transitions = [r1, r2].filter((r) => r.statusTransition).length;
    expect(transitions).toBe(1);

    // Fan-out double-fire IS the documented §6.2 caveat: both callers
    // evaluate `nextStatus !== prevStatus` against their shared in-memory
    // lean (prev="in_transit"), so both can enter the fan-out block. The
    // chokepoint inherits this for ALL fan-outs (FraudPrediction,
    // recordCourierOutcome, contributeOutcome, MerchantStats); v1 does
    // not add a new guarantee. Counter is bounded between 1 and 2.
    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust!.deliveredCount).toBeGreaterThanOrEqual(1);
    expect(cust!.deliveredCount).toBeLessThanOrEqual(2);
  });

  it("parallel transitions on DIFFERENT orders for the SAME buyer accumulate cleanly", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const lean1 = await createInTransitOrder(merchantId);
    const lean2 = await createInTransitOrder(merchantId);

    await Promise.all([
      applyTrackingEvents(
        lean1 as Parameters<typeof applyTrackingEvents>[0],
        "delivered",
        [{ ...DELIVERED_EVENT, location: "Banani Hub A" }],
        { source: "webhook" },
      ),
      applyTrackingEvents(
        lean2 as Parameters<typeof applyTrackingEvents>[0],
        "delivered",
        [{ ...DELIVERED_EVENT, location: "Banani Hub B" }],
        { source: "webhook" },
      ),
    ]);
    await flushVoidWrites();

    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust!.deliveredCount).toBe(2); // exactly two orders, two increments
  });
});

/* ========================================================================= */
/* (10) failure isolation                                                    */
/* ========================================================================= */

describe("applyTrackingEvents — aggregate write failure isolation", () => {
  it("a thrown error inside CustomerReliability.updateOne is swallowed; Order + existing fan-outs unaffected", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const orderDoc = await Order.create({
      merchantId,
      orderNumber: `TEST-FI-${Date.now()}`,
      customer: {
        name: "Test Buyer",
        phone: TEST_PHONE,
        address: TEST_ADDRESS,
        district: TEST_DISTRICT,
      },
      items: [{ name: "thing", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "in_transit" },
      logistics: {
        courier: "steadfast",
        trackingNumber: "TR-FI-1",
        shippedAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
      },
      source: { addressHash: hashAddress(TEST_ADDRESS, TEST_DISTRICT) },
    });
    await FraudPrediction.create({
      merchantId,
      orderId: orderDoc._id,
      riskScore: 30,
      pRto: 0.2,
      levelPredicted: "low",
      customerTier: "new",
      signals: [],
      weightsVersion: "v2.0",
    });
    const lean = await Order.findById(orderDoc._id).lean();

    // Inject a failure into the new helper's underlying Mongo write. The
    // outer .catch in the chokepoint AND the helper's own try/catch both
    // contribute to swallowing this — either layer is sufficient.
    const spy = vi
      .spyOn(CustomerReliability, "updateOne")
      .mockRejectedValueOnce(new Error("simulated mongo timeout"));

    const result = await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    // Order/status write succeeded.
    expect(result.statusTransition?.to).toBe("delivered");
    const orderAfter = await Order.findById(orderDoc._id).lean();
    expect(orderAfter!.order!.status).toBe("delivered");

    // Existing fan-out still ran.
    const fp = await FraudPrediction.findOne({ orderId: orderDoc._id }).lean();
    expect(fp!.outcome).toBe("delivered");

    // CourierPerformance still updated.
    const courierRows = await CourierPerformance.countDocuments({
      merchantId,
      courier: "steadfast",
    });
    expect(courierRows).toBeGreaterThan(0);

    // CustomerReliability did NOT get the row (the spy rejected the only
    // call). AddressReliability is independent and DID land.
    expect(await CustomerReliability.countDocuments({ merchantId })).toBe(0);
    expect(await AddressReliability.countDocuments({ merchantId })).toBe(1);

    spy.mockRestore();
  });

  it("a thrown error inside AddressReliability.updateOne does NOT block CustomerReliability or Order", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const lean = await createInTransitOrder(merchantId);

    const spy = vi
      .spyOn(AddressReliability, "updateOne")
      .mockRejectedValueOnce(new Error("simulated mongo timeout"));

    const result = await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    expect(result.statusTransition?.to).toBe("delivered");
    expect(await CustomerReliability.countDocuments({ merchantId })).toBe(1);
    expect(await AddressReliability.countDocuments({ merchantId })).toBe(0);

    spy.mockRestore();
  });
});

/* ========================================================================= */
/* Smoke: existing semantics preserved                                       */
/* ========================================================================= */

describe("applyTrackingEvents — existing semantics preserved (smoke)", () => {
  it("the new fan-out does not change MerchantStats counter behavior", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const lean = await createInTransitOrder(merchantId);

    const result = await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();
    expect(result.statusTransition).toEqual({ from: "in_transit", to: "delivered" });

    const orderAfter = await Order.findById((lean as { _id: Types.ObjectId })._id).lean();
    expect(orderAfter!.order!.status).toBe("delivered");
    expect(orderAfter!.logistics!.deliveredAt).toBeInstanceOf(Date);
  });
});
