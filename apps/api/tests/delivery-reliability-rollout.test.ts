import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  AddressReliability,
  COURIER_PERF_GLOBAL_DISTRICT,
  CourierPerformance,
  CustomerReliability,
} from "@ecom/db";
import {
  __resetRolloutAllowlistCache,
  getMerchantRolloutSnapshot,
  getRolloutState,
  isAnalyticsEnabledForMerchant,
  isReadEnabledForMerchant,
  isWriteEnabledForMerchant,
} from "../src/lib/delivery-reliability-rollout.js";
import { applyTrackingEvents } from "../src/server/tracking.js";
import { hashAddress } from "../src/server/risk.js";
import { hashPhoneForNetwork } from "../src/lib/fraud-network.js";
import { loadDeliveryReliability } from "../src/lib/delivery-reliability-read.js";
import {
  recordAddressOutcome,
  recordCustomerOutcome,
} from "../src/lib/delivery-reliability-writers.js";
import {
  __resetReliabilityCounters,
} from "../src/lib/observability/delivery-reliability.js";
import { buildVerificationReport, __TEST } from "../src/scripts/verifyDeliveryReliability.js";
import { Order } from "@ecom/db";
import { env } from "../src/env.js";
import { createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * S9 — production rollout tests.
 *
 * Coverage:
 *   - per-merchant gate matrix (allowlist on / off; flag on / off)
 *   - rollback semantics (flag flip → immediate behaviour change)
 *   - the verification script's `buildVerificationReport` helper
 *   - chokepoint integration with allowlist gating
 *   - read-helper integration with allowlist gating
 *   - rollout phase derivation
 */

type MutableEnv = { -readonly [K in keyof typeof env]: typeof env[K] };
function setWriteFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_WRITE_ENABLED = value;
}
function setReadFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_READ_ENABLED = value;
}
function setAnalyticsFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_ANALYTICS_ENABLED = value;
}
function setAllowlist(value: string) {
  (env as MutableEnv).DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS = value;
  __resetRolloutAllowlistCache();
}

let originalWrite: boolean;
let originalRead: boolean;
let originalAnalytics: boolean;
let originalAllowlist: string;

beforeEach(async () => {
  await ensureDb();
  await resetDb();
  __resetReliabilityCounters();
  originalWrite = env.DELIVERY_RELIABILITY_WRITE_ENABLED;
  originalRead = env.DELIVERY_RELIABILITY_READ_ENABLED;
  originalAnalytics = env.DELIVERY_RELIABILITY_ANALYTICS_ENABLED;
  originalAllowlist = env.DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS;
  setWriteFlag(false);
  setReadFlag(false);
  setAnalyticsFlag(false);
  setAllowlist("");
});

afterEach(() => {
  setWriteFlag(originalWrite);
  setReadFlag(originalRead);
  setAnalyticsFlag(originalAnalytics);
  setAllowlist(originalAllowlist);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const NOW = new Date("2026-05-08T12:00:00Z");

const TEST_PHONE = "+8801711222333";
const TEST_ADDRESS = "House 11, Road 4, Mirpur";
const TEST_DISTRICT = "Dhaka";

async function createInTransitOrder(merchantId: Types.ObjectId) {
  const orderDoc = await Order.create({
    merchantId,
    orderNumber: `ROLLOUT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      shippedAt: new Date(Date.now() - 60_000),
      trackingEvents: [],
    },
    source: { addressHash: hashAddress(TEST_ADDRESS, TEST_DISTRICT) },
  });
  return Order.findById(orderDoc._id).lean();
}

async function flushVoidWrites() {
  await new Promise((r) => setTimeout(r, 50));
}

const DELIVERED_EVENT = {
  at: NOW,
  providerStatus: "Delivered",
  description: "Parcel handed to recipient",
  location: "Mirpur Hub",
};

/* ========================================================================== */
/* GROUP A — pure gate semantics                                              */
/* ========================================================================== */

describe("rollout gates — pure semantics", () => {
  it("write gate: closed when env flag is off", () => {
    const m = new Types.ObjectId();
    setWriteFlag(false);
    setAllowlist("");
    expect(isWriteEnabledForMerchant(m)).toBe(false);
  });

  it("write gate: open for all merchants when flag is on AND allowlist is empty", () => {
    setWriteFlag(true);
    setAllowlist("");
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    expect(isWriteEnabledForMerchant(a)).toBe(true);
    expect(isWriteEnabledForMerchant(b)).toBe(true);
  });

  it("write gate: only open for allowlisted merchants when allowlist is set", () => {
    setWriteFlag(true);
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    setAllowlist(a.toHexString());
    expect(isWriteEnabledForMerchant(a)).toBe(true);
    expect(isWriteEnabledForMerchant(b)).toBe(false);
  });

  it("write gate: closed even for allowlisted merchant when flag is off (rollback wins)", () => {
    setWriteFlag(false);
    const a = new Types.ObjectId();
    setAllowlist(a.toHexString());
    expect(isWriteEnabledForMerchant(a)).toBe(false);
  });

  it("read gate mirrors write gate semantics", () => {
    const m = new Types.ObjectId();
    setReadFlag(false);
    expect(isReadEnabledForMerchant(m)).toBe(false);
    setReadFlag(true);
    setAllowlist("");
    expect(isReadEnabledForMerchant(m)).toBe(true);
    setAllowlist(m.toHexString());
    expect(isReadEnabledForMerchant(m)).toBe(true);
    setAllowlist(new Types.ObjectId().toHexString());
    expect(isReadEnabledForMerchant(m)).toBe(false);
  });

  it("analytics gate mirrors write gate semantics", () => {
    const m = new Types.ObjectId();
    setAnalyticsFlag(false);
    expect(isAnalyticsEnabledForMerchant(m)).toBe(false);
    setAnalyticsFlag(true);
    setAllowlist("");
    expect(isAnalyticsEnabledForMerchant(m)).toBe(true);
  });

  it("allowlist tolerates whitespace + multiple ids", () => {
    setWriteFlag(true);
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    setAllowlist(`  ${a.toHexString()} ,${b.toHexString()},   ,invalid-id  `);
    expect(isWriteEnabledForMerchant(a)).toBe(true);
    expect(isWriteEnabledForMerchant(b)).toBe(true);
    expect(isWriteEnabledForMerchant(new Types.ObjectId())).toBe(false);
  });

  it("allowlist accepts merchantId as ObjectId, hex string, or Mongoose-coercible value", () => {
    setWriteFlag(true);
    const a = new Types.ObjectId();
    setAllowlist(a.toHexString());
    expect(isWriteEnabledForMerchant(a)).toBe(true); // ObjectId
    expect(isWriteEnabledForMerchant(a.toHexString())).toBe(true); // hex string
    expect(isWriteEnabledForMerchant(a.toString())).toBe(true); // toString
  });

  it("allowlist returns false for malformed merchantId", () => {
    setWriteFlag(true);
    const a = new Types.ObjectId();
    setAllowlist(a.toHexString());
    expect(isWriteEnabledForMerchant(null)).toBe(false);
    expect(isWriteEnabledForMerchant(undefined)).toBe(false);
    expect(isWriteEnabledForMerchant("not-an-id")).toBe(false);
    expect(isWriteEnabledForMerchant({})).toBe(false);
  });

  it("getMerchantRolloutSnapshot returns the per-merchant gate matrix", () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    setWriteFlag(true);
    setReadFlag(true);
    setAnalyticsFlag(false);
    setAllowlist(a.toHexString());

    expect(getMerchantRolloutSnapshot(a)).toEqual({
      inAllowlist: true,
      writeEnabled: true,
      readEnabled: true,
      analyticsEnabled: false,
    });
    expect(getMerchantRolloutSnapshot(b)).toEqual({
      inAllowlist: false,
      writeEnabled: false,
      readEnabled: false,
      analyticsEnabled: false,
    });
  });
});

/* ========================================================================== */
/* GROUP B — phase derivation                                                 */
/* ========================================================================== */

describe("rollout phase derivation", () => {
  it("phase=off when write is off", () => {
    setWriteFlag(false);
    setReadFlag(true);
    setAnalyticsFlag(true);
    expect(getRolloutState().phase).toBe("off");
  });

  it("phase=writes_only when write on, read off", () => {
    setWriteFlag(true);
    setReadFlag(false);
    expect(getRolloutState().phase).toBe("writes_only");
  });

  it("phase=reads_on when write on, read on, analytics off", () => {
    setWriteFlag(true);
    setReadFlag(true);
    setAnalyticsFlag(false);
    expect(getRolloutState().phase).toBe("reads_on");
  });

  it("phase=ga when all three on AND allowlist empty", () => {
    setWriteFlag(true);
    setReadFlag(true);
    setAnalyticsFlag(true);
    setAllowlist("");
    expect(getRolloutState().phase).toBe("ga");
    expect(getRolloutState().staged).toBe(false);
  });

  it("phase=staged_ga when all three on AND allowlist non-empty", () => {
    setWriteFlag(true);
    setReadFlag(true);
    setAnalyticsFlag(true);
    setAllowlist(new Types.ObjectId().toHexString());
    const state = getRolloutState();
    expect(state.phase).toBe("staged_ga");
    expect(state.staged).toBe(true);
    expect(state.allowlistSize).toBe(1);
  });
});

/* ========================================================================== */
/* GROUP C — chokepoint integration with rollout gates                        */
/* ========================================================================== */

describe("chokepoint × rollout gate", () => {
  it("write flag on, allowlist empty → fan-out fires for any merchant", async () => {
    setWriteFlag(true);
    setAllowlist("");
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);

    await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust).not.toBeNull();
    expect(cust!.deliveredCount).toBe(1);
  });

  it("write flag on, allowlist EXCLUDES merchant → fan-out does NOT fire", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    // Allowlist contains a different merchantId.
    setAllowlist(new Types.ObjectId().toHexString());
    const order = await createInTransitOrder(merchantId);

    await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    expect(await CustomerReliability.countDocuments({ merchantId })).toBe(0);
    expect(await AddressReliability.countDocuments({ merchantId })).toBe(0);
  });

  it("write flag on, allowlist INCLUDES merchant → fan-out fires", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    setAllowlist(merchantId.toHexString());
    const order = await createInTransitOrder(merchantId);

    await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    expect(
      (await CustomerReliability.findOne({ merchantId, phoneHash }).lean())!
        .deliveredCount,
    ).toBe(1);
  });

  it("write flag flipped off mid-session → subsequent terminal flips do NOT fan-out (immediate rollback)", async () => {
    setWriteFlag(true);
    setAllowlist("");
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order1 = await createInTransitOrder(merchantId);
    const order2 = await createInTransitOrder(merchantId);

    await applyTrackingEvents(
      order1 as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    // Roll back.
    setWriteFlag(false);

    await applyTrackingEvents(
      order2 as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    // First order's row exists; second order did NOT advance the counter.
    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust!.deliveredCount).toBe(1);
  });
});

/* ========================================================================== */
/* GROUP D — read helper × rollout gate                                       */
/* ========================================================================== */

describe("read helper × rollout gate", () => {
  it("read flag on, allowlist empty → loadDeliveryReliability returns a result", async () => {
    setReadFlag(true);
    setAllowlist("");
    const merchantId = new Types.ObjectId();
    const r = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(r).not.toBeNull();
    expect(r!.tier).toBe("no_data");
  });

  it("read flag on, allowlist EXCLUDES merchant → loadDeliveryReliability returns null", async () => {
    setReadFlag(true);
    setAllowlist(new Types.ObjectId().toHexString());
    const merchantId = new Types.ObjectId();
    const r = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(r).toBeNull();
  });

  it("read flag on, allowlist INCLUDES merchant → loadDeliveryReliability returns a result", async () => {
    setReadFlag(true);
    const merchantId = new Types.ObjectId();
    setAllowlist(merchantId.toHexString());
    const r = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(r).not.toBeNull();
  });

  it("read flag flipped off mid-session → subsequent calls return null (immediate rollback)", async () => {
    setReadFlag(true);
    setAllowlist("");
    const merchantId = new Types.ObjectId();
    const before = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(before).not.toBeNull();
    setReadFlag(false);
    const after = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(after).toBeNull();
  });
});

/* ========================================================================== */
/* GROUP E — rollback isolation between flags                                 */
/* ========================================================================== */

describe("rollback isolation", () => {
  it("disabling read does NOT disable write", async () => {
    setWriteFlag(true);
    setReadFlag(false);
    setAllowlist("");
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);
    await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    expect(
      (await CustomerReliability.findOne({ merchantId, phoneHash }).lean())!
        .deliveredCount,
    ).toBe(1);
    // Read still suppressed.
    expect(
      await loadDeliveryReliability({ merchantId, phone: TEST_PHONE }),
    ).toBeNull();
  });

  it("disabling analytics does NOT disable read", async () => {
    setReadFlag(true);
    setAnalyticsFlag(false);
    setAllowlist("");
    const merchantId = new Types.ObjectId();
    const r = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(r).not.toBeNull();
    // Analytics gate would refuse separately — verified at the helper level.
    expect(isAnalyticsEnabledForMerchant(merchantId)).toBe(false);
    expect(isReadEnabledForMerchant(merchantId)).toBe(true);
  });

  it("disabling all three flags drains the surface immediately on the next request", async () => {
    setWriteFlag(true);
    setReadFlag(true);
    setAnalyticsFlag(true);
    setAllowlist("");
    const merchantId = new Types.ObjectId();
    expect(isWriteEnabledForMerchant(merchantId)).toBe(true);
    expect(isReadEnabledForMerchant(merchantId)).toBe(true);
    expect(isAnalyticsEnabledForMerchant(merchantId)).toBe(true);

    setWriteFlag(false);
    setReadFlag(false);
    setAnalyticsFlag(false);
    expect(isWriteEnabledForMerchant(merchantId)).toBe(false);
    expect(isReadEnabledForMerchant(merchantId)).toBe(false);
    expect(isAnalyticsEnabledForMerchant(merchantId)).toBe(false);
  });
});

/* ========================================================================== */
/* GROUP F — verifyDeliveryReliability script                                 */
/* ========================================================================== */

describe("verifyDeliveryReliability — read-only verification report", () => {
  it("builds a report with rollout state + observability counters when DB is empty", async () => {
    const report = await buildVerificationReport();
    expect(report.scope).toBe("global");
    expect(report.merchants).toEqual([]);
    expect(report.rollout.phase).toBe("off");
    expect(typeof report.observabilityCounters.customerUpdated).toBe("number");
    expect(report.warnings).toEqual([]);
  });

  it("scopes to a single merchant via --merchant arg", async () => {
    const merchantId = new Types.ObjectId();
    await CustomerReliability.create({
      merchantId,
      phoneHash: "ph_" + "a".repeat(29),
      deliveredCount: 5,
      rtoCount: 0,
      cancelledCount: 0,
      firstOutcomeAt: new Date(),
      lastOutcomeAt: new Date(),
    });
    const report = await buildVerificationReport({
      merchant: merchantId.toHexString(),
    });
    expect(report.scope).toBe("single_merchant");
    expect(report.merchants).toHaveLength(1);
    expect(report.merchants[0]?.merchantId).toBe(merchantId.toHexString());
    expect(report.merchants[0]?.customerRows).toBe(1);
  });

  it("warns on invalid --merchant value but does not throw", async () => {
    const report = await buildVerificationReport({
      merchant: "not-an-objectid",
    });
    expect(report.warnings.some((w) => w.includes("Invalid"))).toBe(true);
    expect(report.merchants).toEqual([]);
  });

  it("does NOT issue any aggregate writes (read-only contract)", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: "ph_" + "z".repeat(29),
      outcome: "delivered",
      now: NOW,
    });
    await recordAddressOutcome({
      merchantId,
      addressHash: "ad_" + "z".repeat(29),
      outcome: "delivered",
      now: NOW,
    });
    const beforeCust = await CustomerReliability.findOne({ merchantId }).lean();
    const beforeAddr = await AddressReliability.findOne({ merchantId }).lean();

    await buildVerificationReport({ merchant: merchantId.toHexString() });
    await buildVerificationReport({ merchant: merchantId.toHexString() });

    const afterCust = await CustomerReliability.findOne({ merchantId }).lean();
    const afterAddr = await AddressReliability.findOne({ merchantId }).lean();
    expect(afterCust!.deliveredCount).toBe(beforeCust!.deliveredCount);
    expect(afterAddr!.deliveredCount).toBe(beforeAddr!.deliveredCount);
  });

  it("computes stale percentages using the 180-day cutoff", async () => {
    const merchantId = new Types.ObjectId();
    await CustomerReliability.create({
      merchantId,
      phoneHash: "ph_fresh",
      deliveredCount: 5,
      rtoCount: 0,
      cancelledCount: 0,
      lastOutcomeAt: new Date(),
    });
    await CustomerReliability.create({
      merchantId,
      phoneHash: "ph_stale",
      deliveredCount: 5,
      rtoCount: 0,
      cancelledCount: 0,
      lastOutcomeAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    });
    const report = await buildVerificationReport({
      merchant: merchantId.toHexString(),
    });
    expect(report.merchants[0]?.customerStaleRows).toBe(1);
    expect(report.merchants[0]?.customerStalePct).toBeCloseTo(0.5, 2);
  });

  it("integrity sample flags impossible counters", async () => {
    const merchantId = new Types.ObjectId();
    // Direct collection insert bypasses Mongoose schema validators — simulates
    // a row that landed via a buggy direct write.
    await CustomerReliability.collection.insertOne({
      merchantId,
      phoneHash: "ph_bad",
      deliveredCount: -5,
      rtoCount: 1,
      cancelledCount: 0,
      lastOutcomeAt: new Date(),
      firstOutcomeAt: new Date(),
    });
    const report = await buildVerificationReport({
      merchant: merchantId.toHexString(),
    });
    expect(report.merchants[0]?.integrityViolations).toBeGreaterThan(0);
  });

  it("formatHumanReport produces a non-empty string for any report shape", () => {
    const fake = {
      generatedAt: NOW.toISOString(),
      rollout: {
        flags: { write: false, read: false, analytics: false, observability: true },
        allowlistSize: 0,
        staged: false,
        phase: "off" as const,
      },
      observabilityCounters: {
        customerUpdated: 0,
        addressUpdated: 0,
        writeFailed: 0,
        aggregateSkipped: 0,
        replaySuppressed: 0,
        driftDetected: 0,
        invalidTransition: 0,
        integrityWarning: 0,
      },
      scope: "global" as const,
      merchants: [],
      warnings: [],
    };
    const out = __TEST.formatHumanReport(fake);
    expect(out).toContain("Delivery Reliability");
    expect(out).toContain("phase:");
    expect(out).toContain("off");
  });

  it("parseArgs extracts --merchant and --json", () => {
    expect(__TEST.parseArgs(["node", "script", "--merchant=abc123"])).toEqual({
      merchant: "abc123",
    });
    expect(__TEST.parseArgs(["node", "script", "--json"])).toEqual({ json: true });
    expect(__TEST.parseArgs(["node", "script"])).toEqual({});
  });
});

/* ========================================================================== */
/* GROUP G — degraded mode                                                    */
/* ========================================================================== */

describe("degraded mode — script tolerates DB failure on individual axes", () => {
  it("inspectMerchant returns -1 for failed counts but never throws", async () => {
    const merchantId = new Types.ObjectId();
    vi.spyOn(CourierPerformance, "countDocuments").mockRejectedValueOnce(
      new Error("simulated"),
    );
    const report = await buildVerificationReport({
      merchant: merchantId.toHexString(),
    });
    expect(report.merchants).toHaveLength(1);
    // Failed count surfaces as -1; other counts are 0 or computed.
    expect(report.merchants[0]?.courierRows).toBeLessThanOrEqual(0);
  });
});

void Order; // import-keepalive — used inside helper above when seeding
void COURIER_PERF_GLOBAL_DISTRICT; // suppress unused-import warning
