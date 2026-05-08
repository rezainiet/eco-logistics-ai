import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { CustomerReliability } from "@ecom/db";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  ensureDb,
  resetDb,
} from "./helpers.js";
import {
  __resetReliabilityCounters,
  recordReliabilityOutcome,
} from "../src/lib/observability/delivery-reliability.js";
import {
  __resetRolloutAllowlistCache,
} from "../src/lib/delivery-reliability-rollout.js";
import { env } from "../src/env.js";

/**
 * S10 finalization — tests for the three new admin tRPC procedures
 * exposed in `apps/api/src/server/routers/adminObservability.ts`:
 *
 *   - `deliveryReliabilityRolloutState`
 *   - `deliveryReliabilityMerchantHealth`
 *   - `deliveryReliabilityDriftSample`
 *
 * Contract under audit:
 *   - admin role required (non-admin → FORBIDDEN)
 *   - read-only (no aggregate / Order writes from any procedure)
 *   - graceful degradation on invalid merchantId (returns null, never throws)
 *   - bounded scans honoured (`scanLimit` clamp on driftSample)
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
});

afterAll(disconnectDb);

async function createAdmin() {
  return createMerchant({ role: "admin" });
}

/* ========================================================================== */
/* deliveryReliabilityRolloutState                                            */
/* ========================================================================== */

describe("adminObservability.deliveryReliabilityRolloutState", () => {
  it("rejects non-admin callers with FORBIDDEN", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.adminObservability.deliveryReliabilityRolloutState({}),
    ).rejects.toThrow(/admin role required/);
  });

  it("returns the global rollout snapshot + counters when no merchantId is passed", async () => {
    setWriteFlag(true);
    setReadFlag(false);
    setAnalyticsFlag(false);
    setAllowlist("");
    const admin = await createAdmin();
    const caller = callerFor(authUserFor(admin));
    const out = await caller.adminObservability.deliveryReliabilityRolloutState({});
    expect(out.rollout.phase).toBe("writes_only");
    expect(out.rollout.flags.write).toBe(true);
    expect(out.rollout.allowlistSize).toBe(0);
    expect(out.merchant).toBeNull();
    expect(typeof out.observabilityCounters.customerUpdated).toBe("number");
    expect(out.generatedAt).toBeInstanceOf(Date);
  });

  it("populates merchant snapshot when a valid hex merchantId is supplied", async () => {
    setWriteFlag(true);
    const admin = await createAdmin();
    const target = new Types.ObjectId();
    setAllowlist(target.toHexString());
    const caller = callerFor(authUserFor(admin));
    const out = await caller.adminObservability.deliveryReliabilityRolloutState({
      merchantId: target.toHexString(),
    });
    expect(out.merchant).not.toBeNull();
    expect(out.merchant!.inAllowlist).toBe(true);
    expect(out.merchant!.writeEnabled).toBe(true);
  });

  it("returns merchant=null when the merchantId is invalid hex", async () => {
    const admin = await createAdmin();
    const caller = callerFor(authUserFor(admin));
    const out = await caller.adminObservability.deliveryReliabilityRolloutState({
      merchantId: "not-a-real-id",
    });
    expect(out.merchant).toBeNull();
  });

  it("surfaces the in-process observability counters", async () => {
    const admin = await createAdmin();
    setWriteFlag(true);
    recordReliabilityOutcome({
      event: "customer_updated",
      merchantId: new Types.ObjectId().toHexString(),
      axis: "customer",
      reason: "delivered",
    });
    const caller = callerFor(authUserFor(admin));
    const out = await caller.adminObservability.deliveryReliabilityRolloutState({});
    expect(out.observabilityCounters.customerUpdated).toBe(1);
  });
});

/* ========================================================================== */
/* deliveryReliabilityMerchantHealth                                          */
/* ========================================================================== */

describe("adminObservability.deliveryReliabilityMerchantHealth", () => {
  it("rejects non-admin callers", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.adminObservability.deliveryReliabilityMerchantHealth({
        merchantId: new Types.ObjectId().toHexString(),
      }),
    ).rejects.toThrow(/admin role required/);
  });

  it("returns null on an invalid merchantId (graceful degradation)", async () => {
    const admin = await createAdmin();
    const caller = callerFor(authUserFor(admin));
    const out = await caller.adminObservability.deliveryReliabilityMerchantHealth({
      merchantId: "not-an-objectid",
    });
    expect(out).toBeNull();
  });

  it("returns aggregate-counts shape on a valid merchantId", async () => {
    const admin = await createAdmin();
    const target = new Types.ObjectId();
    await CustomerReliability.create({
      merchantId: target,
      phoneHash: "ph_" + "a".repeat(29),
      deliveredCount: 3,
      rtoCount: 0,
      cancelledCount: 0,
      lastOutcomeAt: new Date(),
    });
    const caller = callerFor(authUserFor(admin));
    const out = await caller.adminObservability.deliveryReliabilityMerchantHealth({
      merchantId: target.toHexString(),
    });
    expect(out).not.toBeNull();
    expect(out!.aggregateCounts.customerRows).toBe(1);
    expect(typeof out!.staleAggregatePercentage.customer).toBe("number");
    expect(out!.observabilityCounters).toBeDefined();
    expect(out!.generatedAt).toBeInstanceOf(Date);
  });
});

/* ========================================================================== */
/* deliveryReliabilityDriftSample                                             */
/* ========================================================================== */

describe("adminObservability.deliveryReliabilityDriftSample", () => {
  it("rejects non-admin callers", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.adminObservability.deliveryReliabilityDriftSample({
        merchantId: new Types.ObjectId().toHexString(),
        axis: "customer",
      }),
    ).rejects.toThrow(/admin role required/);
  });

  it("returns null on invalid merchantId hex", async () => {
    const admin = await createAdmin();
    const caller = callerFor(authUserFor(admin));
    const out = await caller.adminObservability.deliveryReliabilityDriftSample({
      merchantId: "not-an-id",
      axis: "customer",
    });
    expect(out).toBeNull();
  });

  it("returns an empty reconciliation result on an unknown merchant", async () => {
    const admin = await createAdmin();
    const target = new Types.ObjectId();
    const caller = callerFor(authUserFor(admin));
    const out = await caller.adminObservability.deliveryReliabilityDriftSample({
      merchantId: target.toHexString(),
      axis: "customer",
    });
    expect(out).not.toBeNull();
    expect(out!.merchantId).toBe(target.toHexString());
    expect(out!.entries).toEqual([]);
    expect(out!.driftedKeys).toEqual([]);
    expect(out!.missingKeys).toEqual([]);
  });

  it("rejects scanLimit > 10000 at the input layer", async () => {
    const admin = await createAdmin();
    const caller = callerFor(authUserFor(admin));
    await expect(
      caller.adminObservability.deliveryReliabilityDriftSample({
        merchantId: new Types.ObjectId().toHexString(),
        axis: "customer",
        scanLimit: 99_999,
      }),
    ).rejects.toThrow();
  });

  it("rejects scanLimit < 1", async () => {
    const admin = await createAdmin();
    const caller = callerFor(authUserFor(admin));
    await expect(
      caller.adminObservability.deliveryReliabilityDriftSample({
        merchantId: new Types.ObjectId().toHexString(),
        axis: "customer",
        scanLimit: 0,
      }),
    ).rejects.toThrow();
  });

  it("does NOT issue any aggregate writes when invoked", async () => {
    const admin = await createAdmin();
    const target = new Types.ObjectId();
    await CustomerReliability.create({
      merchantId: target,
      phoneHash: "ph_" + "z".repeat(29),
      deliveredCount: 5,
      rtoCount: 0,
      cancelledCount: 0,
      firstOutcomeAt: new Date(),
      lastOutcomeAt: new Date(),
    });
    const before = await CustomerReliability.findOne({
      merchantId: target,
    }).lean();

    const caller = callerFor(authUserFor(admin));
    await caller.adminObservability.deliveryReliabilityDriftSample({
      merchantId: target.toHexString(),
      axis: "customer",
    });
    await caller.adminObservability.deliveryReliabilityDriftSample({
      merchantId: target.toHexString(),
      axis: "customer",
    });

    const after = await CustomerReliability.findOne({
      merchantId: target,
    }).lean();
    expect(after!.deliveredCount).toBe(before!.deliveredCount);
    expect(after!.lastOutcomeAt?.getTime()).toBe(
      before!.lastOutcomeAt?.getTime(),
    );
  });
});
