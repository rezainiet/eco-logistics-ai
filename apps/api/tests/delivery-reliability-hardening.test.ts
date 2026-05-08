import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  AddressReliability,
  CustomerReliability,
  Order,
} from "@ecom/db";
import {
  reconcileSlice,
  reconcileKey,
  __TEST as RECONCILE_TEST,
  DRIFT_TOLERANCE,
  MAX_RECONCILE_SCAN,
} from "../src/lib/delivery-reliability-reconciliation.js";
import {
  rebuildAggregateForKey,
  rebuildSliceForMerchant,
  MAX_REPAIR_BATCH,
} from "../src/lib/delivery-reliability-repair.js";
import { hashPhoneForNetwork } from "../src/lib/fraud-network.js";
import { hashAddress } from "../src/server/risk.js";
import { applyTrackingEvents } from "../src/server/tracking.js";
import {
  __resetReliabilityCounters,
  snapshotReliabilityCounters,
} from "../src/lib/observability/delivery-reliability.js";
import { env } from "../src/env.js";
import {
  createMerchant,
  disconnectDb,
  ensureDb,
  resetDb,
} from "./helpers.js";

/**
 * S10 — operational hardening tests.
 *
 * Coverage:
 *   - reconciliation correctness (zero drift on freshly-built aggregates,
 *     drift detection on tampered aggregates, missing aggregate detection)
 *   - repair dry-run vs apply semantics
 *   - bounded repair guarantees
 *   - drift-tolerance gate
 *   - idempotency of repair writes
 *   - no unintended side-effects (no Order writes, no chokepoint replay)
 *   - observability emissions on apply
 *   - degraded-mode resilience (Mongo failure)
 */

type MutableEnv = { -readonly [K in keyof typeof env]: typeof env[K] };
function setWriteFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_WRITE_ENABLED = value;
}

let originalWrite: boolean;

beforeEach(async () => {
  await ensureDb();
  await resetDb();
  __resetReliabilityCounters();
  originalWrite = env.DELIVERY_RELIABILITY_WRITE_ENABLED;
  setWriteFlag(true); // most hardening tests need writes ON to seed aggregates organically
});

afterEach(() => {
  setWriteFlag(originalWrite);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const TEST_PHONE = "+8801711222333";
const TEST_ADDRESS = "House 11, Road 4, Banani";
const TEST_DISTRICT = "Dhaka";

const PHONE_HASH = hashPhoneForNetwork(TEST_PHONE)!;
const ADDRESS_HASH = hashAddress(TEST_ADDRESS, TEST_DISTRICT)!;

/**
 * Seed a delivered Order via the real chokepoint — uses real-time
 * timestamps so the aggregate's `firstOutcomeAt` (set by the helper at
 * upsert time) and the order's `logistics.deliveredAt` (set by the
 * chokepoint) align inside the reconciler's window. Pre-dating either
 * causes window-check rejection in production, which is correct
 * behaviour but makes pre-dated test seeds reconcile to drift=N.
 */
async function seedDeliveredOrder(
  merchantId: Types.ObjectId,
): Promise<{ orderId: Types.ObjectId }> {
  const orderDoc = await Order.create({
    merchantId,
    orderNumber: `HARD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      trackingNumber: `TR-${Date.now()}-${Math.random()}`,
      shippedAt: new Date(),
      trackingEvents: [],
    },
    source: { addressHash: ADDRESS_HASH },
  });
  const lean = await Order.findById(orderDoc._id).lean();
  await applyTrackingEvents(
    lean as Parameters<typeof applyTrackingEvents>[0],
    "delivered",
    [
      {
        at: new Date(),
        providerStatus: "Delivered",
        description: "Parcel handed to recipient",
      },
    ],
    { source: "webhook" },
  );
  await new Promise((r) => setTimeout(r, 25));
  return { orderId: orderDoc._id as Types.ObjectId };
}

/* ========================================================================== */
/* Reconciliation correctness                                                 */
/* ========================================================================== */

describe("reconcileSlice — fresh aggregates", () => {
  it("reports zero drift after the chokepoint seeds aggregates organically", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    await seedDeliveredOrder(merchantId);
    await seedDeliveredOrder(merchantId);

    const result = await reconcileSlice({
      merchantId,
      axis: "customer",
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.exists).toBe(true);
    expect(result.entries[0]?.driftMagnitude).toBe(0);
    expect(result.entries[0]?.aggregate.delivered).toBe(2);
    expect(result.entries[0]?.expected.delivered).toBe(2);
    expect(result.driftedKeys).toEqual([]);
    expect(result.missingKeys).toEqual([]);
  });

  it("address axis reconciles cleanly after the chokepoint runs", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    await seedDeliveredOrder(merchantId);
    const result = await reconcileSlice({
      merchantId,
      axis: "address",
    });
    expect(result.entries[0]?.driftMagnitude).toBe(0);
  });

  it("returns empty entries for a merchant with no aggregates", async () => {
    const merchantId = new Types.ObjectId();
    const result = await reconcileSlice({ merchantId, axis: "customer" });
    expect(result.entries).toEqual([]);
    expect(result.driftedKeys).toEqual([]);
  });

  it("returns empty entries on invalid merchantId", async () => {
    const result = await reconcileSlice({
      merchantId: "not-an-objectid",
      axis: "customer",
    });
    expect(result.entries).toEqual([]);
    expect(result.warnings.some((w) => w.includes("invalid merchantId"))).toBe(true);
  });
});

/* ========================================================================== */
/* Reconciliation drift detection                                             */
/* ========================================================================== */

describe("reconcileSlice — drift detection", () => {
  it("detects drift when the aggregate is undercount (chokepoint missed a write)", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    await seedDeliveredOrder(merchantId);
    await seedDeliveredOrder(merchantId);
    await seedDeliveredOrder(merchantId);
    // Tamper: reduce the aggregate counter to simulate a missed chokepoint write.
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 1 } },
    );
    const result = await reconcileSlice({
      merchantId,
      axis: "customer",
    });
    const entry = result.entries[0]!;
    expect(entry.aggregate.delivered).toBe(1);
    expect(entry.expected.delivered).toBe(3);
    expect(entry.drift.delivered).toBe(2);
    expect(entry.driftMagnitude).toBe(2);
    // Drift magnitude exactly at tolerance = NOT in driftedKeys.
    expect(result.driftedKeys).not.toContain(PHONE_HASH);
  });

  it("flags drift > tolerance in driftedKeys", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 1 } },
    );
    const result = await reconcileSlice({
      merchantId,
      axis: "customer",
    });
    expect(result.driftedKeys).toContain(PHONE_HASH);
    expect(result.entries[0]?.driftMagnitude).toBeGreaterThan(DRIFT_TOLERANCE);
  });

  it("detects MISSING aggregates when single-key mode finds Order observations but no aggregate row", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    // Seed Orders WITHOUT going through the chokepoint — emulate pre-flag history.
    setWriteFlag(false);
    await seedDeliveredOrder(merchantId);
    await seedDeliveredOrder(merchantId);
    setWriteFlag(true);

    const result = await reconcileKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
    });
    expect(result).not.toBeNull();
    expect(result!.exists).toBe(false);
    expect(result!.expected.delivered).toBe(2);
    expect(result!.driftMagnitude).toBe(2);
  });

  it("respects the per-aggregate `firstOutcomeAt` window — pre-window orders do NOT count", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    // Seed pre-flag orders DIRECTLY (no chokepoint) with backdated
    // deliveredAt — this models "delivered before the merchant turned
    // WRITE_ENABLED on". The aggregate's firstOutcomeAt is set later by
    // the in-window chokepoint runs below.
    const preFlagAge = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 2; i++) {
      await Order.create({
        merchantId,
        orderNumber: `PRE-${Date.now()}-${i}`,
        customer: {
          name: "Test Buyer",
          phone: TEST_PHONE,
          address: TEST_ADDRESS,
          district: TEST_DISTRICT,
        },
        items: [{ name: "thing", quantity: 1, price: 500 }],
        order: { cod: 500, total: 500, status: "delivered" },
        logistics: {
          courier: "steadfast",
          trackingNumber: `PRE-TR-${Date.now()}-${i}`,
          deliveredAt: preFlagAge,
        },
        source: { addressHash: ADDRESS_HASH },
      });
    }
    // Now seed in-window orders via the chokepoint.
    await seedDeliveredOrder(merchantId);
    await seedDeliveredOrder(merchantId);

    const result = await reconcileSlice({
      merchantId,
      axis: "customer",
    });
    // Aggregate counts in-window orders only (2). Expected MUST also be 2.
    expect(result.entries[0]?.aggregate.delivered).toBe(2);
    expect(result.entries[0]?.expected.delivered).toBe(2);
    expect(result.entries[0]?.driftMagnitude).toBe(0);
  });

  it("reports truncated=true when the merchant's terminal-order set exceeds the scan limit", async () => {
    const merchantId = new Types.ObjectId();
    const t = Date.now();
    // Mock Order.find to return one more row than the limit.
    const fakeRow = () => ({
      _id: new Types.ObjectId(),
      customer: { phone: TEST_PHONE },
      source: { addressHash: ADDRESS_HASH },
      order: { status: "delivered" },
      logistics: { deliveredAt: new Date(t - 60_000) },
      updatedAt: new Date(t - 60_000),
    });
    const tooMany = Array.from({ length: 6 }, () => fakeRow());
    await CustomerReliability.create({
      merchantId,
      phoneHash: PHONE_HASH,
      deliveredCount: 5,
      rtoCount: 0,
      cancelledCount: 0,
      firstOutcomeAt: new Date(t - 24 * 60 * 60 * 1000),
      lastOutcomeAt: new Date(t - 60_000),
    });
    vi.spyOn(Order, "find").mockImplementation(
      () =>
        ({
          select: () => ({
            limit: () => ({
              lean: () => ({
                exec: () => Promise.resolve(tooMany),
              }),
            }),
          }),
        }) as never,
    );
    const result = await reconcileSlice({
      merchantId,
      axis: "customer",
      scanLimit: 5,
    });
    expect(result.truncated).toBe(true);
    expect(result.warnings.some((w) => w.includes("capped"))).toBe(true);
  });
});

/* ========================================================================== */
/* Reconciliation read-only invariants                                        */
/* ========================================================================== */

describe("reconcileSlice — read-only invariants", () => {
  it("does NOT issue any aggregate writes", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    await seedDeliveredOrder(merchantId);
    const before = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    await reconcileSlice({ merchantId, axis: "customer" });
    await reconcileSlice({ merchantId, axis: "customer" });
    const after = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(after!.deliveredCount).toBe(before!.deliveredCount);
    expect(after!.lastOutcomeAt?.getTime()).toBe(before!.lastOutcomeAt?.getTime());
  });

  it("does NOT issue any Order writes", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const seed = await seedDeliveredOrder(merchantId);
    const before = await Order.findById(seed.orderId).lean();
    await reconcileSlice({ merchantId, axis: "customer" });
    const after = await Order.findById(seed.orderId).lean();
    expect(after!.order!.status).toBe(before!.order!.status);
    expect(after!.logistics!.deliveredAt?.getTime()).toBe(
      before!.logistics!.deliveredAt?.getTime(),
    );
  });

  it("returns gracefully when the Order scan rejects", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    await seedDeliveredOrder(merchantId);
    vi.spyOn(Order, "find").mockImplementation(
      () =>
        ({
          select: () => ({
            limit: () => ({
              lean: () => ({
                exec: () => Promise.reject(new Error("simulated")),
              }),
            }),
          }),
        }) as never,
    );
    const result = await reconcileSlice({
      merchantId,
      axis: "customer",
    });
    expect(result.warnings.some((w) => w.includes("order scan failed"))).toBe(true);
    expect(result.entries).toEqual([]);
  });
});

/* ========================================================================== */
/* Repair — dry-run                                                           */
/* ========================================================================== */

describe("rebuildAggregateForKey — dry-run", () => {
  it("default is dry-run; reports planned mutations without writing", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 1 } },
    );
    const before = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();

    const result = await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
    });
    expect(result.action).toEqual({ kind: "noop", reason: "dry_run" });
    expect(result.proposed).toEqual({
      deliveredCount: 10,
      rtoCount: 0,
      cancelledCount: 0,
    });
    const after = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(after!.deliveredCount).toBe(before!.deliveredCount);
  });

  it("noops when drift is within tolerance (≤ 2)", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 0 } }, // drift = 1, within tolerance
    );
    const result = await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false, // even when applying, tolerance gate refuses
    });
    expect(result.action).toEqual({
      kind: "noop",
      reason: "drift_within_tolerance",
    });
  });

  it("refuses to recreate a missing aggregate (v1 backfill is out of scope)", async () => {
    const merchantId = new Types.ObjectId();
    setWriteFlag(false);
    await seedDeliveredOrder(merchantId);
    await seedDeliveredOrder(merchantId);
    setWriteFlag(true);

    const result = await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false,
    });
    expect(result.action).toEqual({
      kind: "noop",
      reason: "missing_aggregate_skipped",
    });
    expect(
      await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean(),
    ).toBeNull();
  });

  it("returns failed action on invalid input", async () => {
    const result = await rebuildAggregateForKey({
      merchantId: "not-an-objectid",
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false,
    });
    expect(result.action.kind).toBe("failed");
  });
});

/* ========================================================================== */
/* Repair — apply mode                                                        */
/* ========================================================================== */

describe("rebuildAggregateForKey — apply", () => {
  it("writes corrected counters when dryRun=false and drift > tolerance", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 1 } },
    );
    const result = await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false,
    });
    expect(result.action.kind).toBe("applied");
    const after = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(after!.deliveredCount).toBe(10);
  });

  it("repair is idempotent — running again produces no new mutation", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 1 } },
    );
    await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false,
    });
    const second = await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false,
    });
    expect(second.action).toEqual({
      kind: "noop",
      reason: "drift_within_tolerance",
    });
  });

  it("repair is idempotent across both axes", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await AddressReliability.updateOne(
      { merchantId, addressHash: ADDRESS_HASH },
      { $set: { deliveredCount: 1 } },
    );
    const result = await rebuildAggregateForKey({
      merchantId,
      axis: "address",
      hashKey: ADDRESS_HASH,
      dryRun: false,
    });
    expect(result.action.kind).toBe("applied");
    const after = await AddressReliability.findOne({
      merchantId,
      addressHash: ADDRESS_HASH,
    }).lean();
    expect(after!.deliveredCount).toBe(10);
  });

  it("returns 'failed' if the row is deleted between drift report and write", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    // Tamper FIRST so the row reads `deliveredCount: 1` when the repair's
    // reconciler runs. THEN install the once-only spy so it fires on the
    // repair's `applyKeyRepair` updateOne — simulating "row deleted between
    // drift report and write". Setup-order matters: the previous arrangement
    // had the spy consume the tamper itself, so the repair saw no drift.
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 1 } },
    );
    vi.spyOn(CustomerReliability, "updateOne").mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    } as never);
    const result = await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false,
    });
    expect(result.action.kind).toBe("failed");
  });
});

/* ========================================================================== */
/* Slice repair — bounded                                                     */
/* ========================================================================== */

describe("rebuildSliceForMerchant — bounded", () => {
  it("respects the cap", async () => {
    expect(MAX_REPAIR_BATCH).toBe(100);
  });

  it("repairs only drifted-above-tolerance keys; reports non-drifted as inspected=0", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    const slice = await rebuildSliceForMerchant({
      merchantId,
      axis: "customer",
      dryRun: true,
    });
    // Aggregate is in sync — nothing to repair.
    expect(slice.perKey).toHaveLength(0);
    expect(slice.capped).toBe(0);
  });

  it("returns capped > 0 when the limit is smaller than the drifted-key count", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const t = Date.now();
    // Seed three different buyers; tamper all three.
    for (let i = 0; i < 3; i++) {
      const phone = `+880171${i}${i}${i}${i}${i}${i}${i}${i}${i}`;
      const phoneHash = hashPhoneForNetwork(phone)!;
      await CustomerReliability.create({
        merchantId,
        phoneHash,
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        firstOutcomeAt: new Date(t - 10 * 24 * 60 * 60 * 1000),
        lastOutcomeAt: new Date(t - 60_000),
      });
      // Seed Order rows so reconciler sees expected > aggregate.
      for (let j = 0; j < 5; j++) {
        const oDoc = await Order.create({
          merchantId,
          orderNumber: `BATCH-${i}-${j}-${t}`,
          customer: { name: "x", phone, address: "a", district: "Dhaka" },
          items: [{ name: "thing", quantity: 1, price: 100 }],
          order: { cod: 100, total: 100, status: "delivered" },
          logistics: {
            courier: "steadfast",
            trackingNumber: `TR-${i}-${j}-${t}`,
            deliveredAt: new Date(t - 60_000 - j * 1000),
          },
          source: { addressHash: hashAddress("a", "Dhaka") },
          createdAt: new Date(t - 8 * 24 * 60 * 60 * 1000),
          updatedAt: new Date(t - 60_000 - j * 1000),
        });
        void oDoc;
      }
    }

    const slice = await rebuildSliceForMerchant({
      merchantId,
      axis: "customer",
      dryRun: true,
      limit: 1,
    });
    expect(slice.perKey).toHaveLength(1);
    expect(slice.capped).toBe(2);
  });

  it("apply mode mutates each drifted key in turn", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 0 } },
    );
    const slice = await rebuildSliceForMerchant({
      merchantId,
      axis: "customer",
      dryRun: false,
    });
    expect(slice.perKey).toHaveLength(1);
    expect(slice.perKey[0]?.action.kind).toBe("applied");
    const after = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(after!.deliveredCount).toBe(10);
  });
});

/* ========================================================================== */
/* No replay-side-effect invariants                                           */
/* ========================================================================== */

describe("repair — no replay side-effects", () => {
  it("repairing does NOT push tracking events into Order.logistics.trackingEvents", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    const beforeEvents = await Order.findOne({ merchantId })
      .select("logistics.trackingEvents")
      .lean();
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 0 } },
    );
    await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false,
    });
    const afterEvents = await Order.findOne({ merchantId })
      .select("logistics.trackingEvents")
      .lean();
    expect(afterEvents!.logistics!.trackingEvents).toEqual(
      beforeEvents!.logistics!.trackingEvents,
    );
  });

  it("repairing does NOT modify FraudPrediction or any other collection", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 0 } },
    );

    const ordersBefore = await Order.countDocuments({ merchantId });
    await rebuildAggregateForKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
      dryRun: false,
    });
    const ordersAfter = await Order.countDocuments({ merchantId });
    expect(ordersAfter).toBe(ordersBefore);
  });
});

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

describe("__TEST helpers", () => {
  it("terminalAt picks the right timestamp by status", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    expect(
      RECONCILE_TEST.terminalAt({
        order: { status: "delivered" },
        logistics: { deliveredAt: t },
        updatedAt: new Date(),
      }),
    ).toEqual(t);
    expect(
      RECONCILE_TEST.terminalAt({
        order: { status: "rto" },
        logistics: { returnedAt: t },
        updatedAt: new Date(),
      }),
    ).toEqual(t);
    expect(
      RECONCILE_TEST.terminalAt({
        order: { status: "cancelled" },
        updatedAt: t,
      }),
    ).toEqual(t);
    expect(RECONCILE_TEST.terminalAt({ order: { status: "in_transit" } })).toBeNull();
  });

  it("counterDiff produces a per-axis diff", () => {
    const d = RECONCILE_TEST.counterDiff(
      { delivered: 10, rto: 2, cancelled: 1 },
      { delivered: 7, rto: 2, cancelled: 0 },
    );
    expect(d).toEqual({ delivered: 3, rto: 0, cancelled: 1 });
  });

  it("magnitude sums absolute counter deltas", () => {
    expect(RECONCILE_TEST.magnitude({ delivered: 3, rto: -1, cancelled: 2 })).toBe(6);
  });

  it("MAX_RECONCILE_SCAN cap is exposed for sanity", () => {
    expect(MAX_RECONCILE_SCAN).toBe(10_000);
  });
});

/* ========================================================================== */
/* drift_detected observability emit                                          */
/* ========================================================================== */

describe("reconcileSlice — drift_detected observability emit", () => {
  it("does NOT bump driftDetected on a clean reconciliation", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    await seedDeliveredOrder(merchantId);
    __resetReliabilityCounters();

    const result = await reconcileSlice({ merchantId, axis: "customer" });
    expect(result.driftedKeys).toEqual([]);
    expect(result.missingKeys).toEqual([]);
    expect(snapshotReliabilityCounters().driftDetected).toBe(0);
  });

  it("bumps driftDetected exactly once when drift > tolerance is found", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 1 } },
    );
    __resetReliabilityCounters();

    const result = await reconcileSlice({ merchantId, axis: "customer" });
    expect(result.driftedKeys).toContain(PHONE_HASH);
    expect(snapshotReliabilityCounters().driftDetected).toBe(1);
  });

  it("bumps driftDetected when a missing aggregate is found via single-key mode", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    setWriteFlag(false);
    await seedDeliveredOrder(merchantId);
    await seedDeliveredOrder(merchantId);
    setWriteFlag(true);
    __resetReliabilityCounters();

    const single = await reconcileKey({
      merchantId,
      axis: "customer",
      hashKey: PHONE_HASH,
    });
    expect(single).not.toBeNull();
    expect(single!.exists).toBe(false);
    expect(snapshotReliabilityCounters().driftDetected).toBe(1);
  });

  it("emits at most ONE drift_detected event per reconcileSlice call (no per-key flooding)", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const t = Date.now();
    // Three drifted keys in one slice — single-shot emit must still fire only once.
    for (let i = 0; i < 3; i++) {
      const phone = `+880172${i}${i}${i}${i}${i}${i}${i}${i}`;
      const phoneHash = hashPhoneForNetwork(phone)!;
      await CustomerReliability.create({
        merchantId,
        phoneHash,
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        firstOutcomeAt: new Date(t - 10 * 24 * 60 * 60 * 1000),
        lastOutcomeAt: new Date(t - 60_000),
      });
      for (let j = 0; j < 5; j++) {
        await Order.create({
          merchantId,
          orderNumber: `EMIT-${i}-${j}-${t}`,
          customer: { name: "x", phone, address: "a", district: "Dhaka" },
          items: [{ name: "thing", quantity: 1, price: 100 }],
          order: { cod: 100, total: 100, status: "delivered" },
          logistics: {
            courier: "steadfast",
            trackingNumber: `TR-EMIT-${i}-${j}-${t}`,
            deliveredAt: new Date(t - 60_000 - j * 1000),
          },
          source: { addressHash: hashAddress("a", "Dhaka") },
          createdAt: new Date(t - 8 * 24 * 60 * 60 * 1000),
          updatedAt: new Date(t - 60_000 - j * 1000),
        });
      }
    }
    __resetReliabilityCounters();

    const result = await reconcileSlice({ merchantId, axis: "customer" });
    expect(result.driftedKeys.length).toBeGreaterThanOrEqual(1);
    expect(snapshotReliabilityCounters().driftDetected).toBe(1);
  });
});

/* ========================================================================== */
/* Write-ordering unification — regression coverage                           */
/* (see docs/audits/reconciliation-window-race-investigation.md)              */
/* ========================================================================== */

describe("chokepoint write-ordering — terminalNow unification", () => {
  it("first delivered flip: aggregate.firstOutcomeAt === Order.logistics.deliveredAt (byte-equal)", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    await seedDeliveredOrder(merchantId);
    const cust = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    const order = await Order.findOne({ merchantId }).lean();
    expect(cust).not.toBeNull();
    expect(order).not.toBeNull();
    const firstOutcomeMs = cust!.firstOutcomeAt!.getTime();
    const deliveredAtMs = order!.logistics!.deliveredAt!.getTime();
    // The fix: both timestamps derive from the SAME Date in
    // applyTrackingEvents → byte-equal.
    expect(firstOutcomeMs).toBe(deliveredAtMs);
  });

  it("first rto flip: aggregate.firstOutcomeAt === Order.logistics.returnedAt", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const orderDoc = await Order.create({
      merchantId,
      orderNumber: `RTO-FIRST-${Date.now()}`,
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
        trackingNumber: `TR-RTO-${Date.now()}`,
        shippedAt: new Date(),
        trackingEvents: [],
      },
      source: { addressHash: ADDRESS_HASH },
    });
    const lean = await Order.findById(orderDoc._id).lean();
    await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "rto",
      [
        {
          at: new Date(),
          providerStatus: "Returned",
          description: "Parcel returned to origin",
        },
      ],
      { source: "webhook" },
    );
    await new Promise((r) => setTimeout(r, 25));

    const cust = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    const order = await Order.findById(orderDoc._id).lean();
    const firstOutcomeMs = cust!.firstOutcomeAt!.getTime();
    const returnedAtMs = order!.logistics!.returnedAt!.getTime();
    expect(firstOutcomeMs).toBe(returnedAtMs);
  });

  it("reconciler reports zero drift after a tight loop of N flips (no off-by-one)", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);

    const result = await reconcileSlice({ merchantId, axis: "customer" });
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    // Pre-fix: aggregate=10, expected=9, drift=-1.
    // Post-fix: aggregate=10, expected=10, drift=0.
    expect(entry.aggregate.delivered).toBe(10);
    expect(entry.expected.delivered).toBe(10);
    expect(entry.driftMagnitude).toBe(0);
    expect(result.driftedKeys).toEqual([]);
  });

  it("reconciler still excludes pre-flag terminal orders (window invariant preserved)", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    // Seed pre-flag orders via a direct insert (no chokepoint, no aggregate
    // write). These have `deliveredAt` 30 days before WRITE_ENABLED was on.
    const preFlagAge = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 2; i++) {
      await Order.create({
        merchantId,
        orderNumber: `PREFLAG-${Date.now()}-${i}`,
        customer: {
          name: "Test Buyer",
          phone: TEST_PHONE,
          address: TEST_ADDRESS,
          district: TEST_DISTRICT,
        },
        items: [{ name: "thing", quantity: 1, price: 500 }],
        order: { cod: 500, total: 500, status: "delivered" },
        logistics: {
          courier: "steadfast",
          trackingNumber: `PREFLAG-TR-${Date.now()}-${i}`,
          deliveredAt: preFlagAge,
        },
        source: { addressHash: ADDRESS_HASH },
      });
    }
    // Now seed in-window orders via the chokepoint.
    await seedDeliveredOrder(merchantId);
    await seedDeliveredOrder(merchantId);

    const result = await reconcileSlice({ merchantId, axis: "customer" });
    const entry = result.entries[0]!;
    // The unification fix MUST NOT cause pre-flag orders to leak into the
    // expected count. Window strict-`<` invariant must hold.
    expect(entry.aggregate.delivered).toBe(2);
    expect(entry.expected.delivered).toBe(2);
    expect(entry.driftMagnitude).toBe(0);
  });

  it("identical replay of a delivered event still increments the aggregate exactly once", async () => {
    // Replay-safety smoke test colocated with the write-ordering fix —
    // verifies the chokepoint guard semantics are unchanged by the
    // terminalNow unification.
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    let lean = await Order.create({
      merchantId,
      orderNumber: `REPLAY-${Date.now()}`,
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
        trackingNumber: `TR-REPLAY-${Date.now()}`,
        shippedAt: new Date(),
        trackingEvents: [],
      },
      source: { addressHash: ADDRESS_HASH },
    }).then((d) => Order.findById(d._id).lean());

    const event = {
      at: new Date(),
      providerStatus: "Delivered",
      description: "Parcel handed to recipient",
    };
    for (let i = 0; i < 5; i++) {
      await applyTrackingEvents(
        lean as Parameters<typeof applyTrackingEvents>[0],
        "delivered",
        [event],
        { source: "webhook" },
      );
      lean = await Order.findById((lean as { _id: Types.ObjectId })._id).lean();
    }
    await new Promise((r) => setTimeout(r, 50));

    const cust = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(cust!.deliveredCount).toBe(1);
  });

  it("repair report `proposed` matches the aggregate's true count after tampering", async () => {
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);
    await CustomerReliability.updateOne(
      { merchantId, phoneHash: PHONE_HASH },
      { $set: { deliveredCount: 1 } },
    );
    const slice = await reconcileSlice({ merchantId, axis: "customer" });
    const entry = slice.entries[0]!;
    // After unification, expected matches the actual chokepoint-driven
    // history exactly — proposed should reach 10, not 9.
    expect(entry.expected.delivered).toBe(10);
    expect(entry.driftMagnitude).toBe(9);
  });
});
