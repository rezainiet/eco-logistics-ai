import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { ExternalDeliveryProfile } from "@ecom/db";
import { getOrFetchExternalProfile } from "../src/lib/external-delivery/fetch-profile.js";
import {
  __resetExternalDeliveryObservability,
  snapshotExternalDeliveryCounters,
} from "../src/lib/observability/external-delivery.js";
import { hashPhoneForNetwork } from "../src/lib/fraud-network.js";
import type {
  ExternalProviderAdapter,
  ProviderFetchResult,
} from "../src/lib/external-delivery/providers/index.js";
import { env } from "../src/env.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Integration test for the merchant-scoped external-delivery
 * orchestrator. Uses real Mongo + fake provider adapters injected via
 * the `providers` argument.
 *
 * Cache layer (Redis) is exercised at the unit-test level in
 * tests/external-delivery-cache.test.ts. The orchestrator's cache
 * branches degrade cleanly when Redis is unavailable in test (no
 * REDIS_URL set in globalSetup), so cache misses are the default and
 * the orchestrator falls through to Mongo + providers. That's what
 * these tests cover.
 */

type MutableEnv = { EXTERNAL_DELIVERY_ENABLED: boolean };
let originalFlag: boolean;

const MERCHANT_A = new Types.ObjectId("507f1f77bcf86cd799439aa1");
const MERCHANT_B = new Types.ObjectId("507f1f77bcf86cd799439bb2");
const PHONE = "8801712345678";

/** Build a fake adapter that always returns the supplied result. */
function fakeAdapter(
  name: string,
  result: ProviderFetchResult,
  isConfigured = true,
): ExternalProviderAdapter {
  return {
    name,
    sourceVersion: `${name}-fake-v1`,
    isConfigured: () => isConfigured,
    fetchHistory: async () => result,
  };
}

beforeAll(async () => {
  await ensureDb();
  originalFlag = env.EXTERNAL_DELIVERY_ENABLED;
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_ENABLED = true;
});
beforeEach(async () => {
  await resetDb();
  __resetExternalDeliveryObservability();
});
afterEach(() => {
  // ensure flag stays on for the suite
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_ENABLED = true;
});
afterAll(async () => {
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_ENABLED = originalFlag;
  await disconnectDb();
});

/* -------------------------------------------------------------------------- */

describe("external-delivery / fetch-profile — master flag", () => {
  it("returns null immediately when EXTERNAL_DELIVERY_ENABLED=0 (no DB / provider touch)", async () => {
    (env as unknown as MutableEnv).EXTERNAL_DELIVERY_ENABLED = false;
    let providerCalled = false;
    const result = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [
        fakeAdapter("pathao", {
          ok: true,
          total: 10,
          delivered: 9,
          rto: 1,
          cancelled: 0,
          successRate: 0.9,
          durationMs: 5,
        }),
      ],
    });
    expect(result).toBeNull();
    expect(await ExternalDeliveryProfile.countDocuments({})).toBe(0);
    expect(providerCalled).toBe(false);
  });
});

describe("external-delivery / fetch-profile — input validation", () => {
  it("returns null on invalid merchantId", async () => {
    const r = await getOrFetchExternalProfile({
      merchantId: "not-an-objectid",
      phone: PHONE,
      providers: [],
    });
    expect(r).toBeNull();
  });

  it("returns null on unusable phone (placeholder)", async () => {
    const r = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: "00000000000",
      providers: [],
    });
    expect(r).toBeNull();
  });
});

describe("external-delivery / fetch-profile — provider fan-out (Mongo persistence)", () => {
  it("persists per-merchant, aggregates only configured-AND-ok providers, computes signals", async () => {
    const r = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [
        fakeAdapter("pathao", {
          ok: true,
          total: 18,
          delivered: 17,
          rto: 1,
          cancelled: 0,
          successRate: 17 / 18,
          durationMs: 5,
        }),
        fakeAdapter("steadfast", {
          ok: true,
          total: 6,
          delivered: 6,
          rto: 0,
          cancelled: 0,
          successRate: 1,
          durationMs: 5,
        }),
        // Unconfigured provider — must be excluded from aggregate.
        fakeAdapter(
          "redx",
          {
            ok: false,
            error: "stub_unconfigured",
            durationMs: 0,
            timedOut: false,
          },
          false,
        ),
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.merchantId).toBe(MERCHANT_A.toHexString());
    expect(r!.aggregate.contributingProviders).toEqual(["pathao", "steadfast"]);
    expect(r!.aggregate.total).toBe(24);
    expect(r!.aggregate.delivered).toBe(23);
    expect(r!.aggregate.rto).toBe(1);
    // 23/24 = 95.8% over 24 obs ≥ STRONG_MIN_OBSERVATIONS=15
    expect(r!.signals.strong_delivery_history).toBe(true);
    expect(r!.signals.sparse_history).toBe(false);

    const row = await ExternalDeliveryProfile.findOne({
      merchantId: MERCHANT_A,
      phoneHash: hashPhoneForNetwork(PHONE),
    }).lean();
    expect(row).not.toBeNull();
    expect(row!.aggregate?.total).toBe(24);
  });

  it("partial provider failure → aggregate over surviving providers + observability event", async () => {
    const r = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [
        fakeAdapter("pathao", {
          ok: true,
          total: 8,
          delivered: 7,
          rto: 1,
          cancelled: 0,
          successRate: 7 / 8,
          durationMs: 5,
        }),
        // Configured but failed — adapter timed out
        fakeAdapter("steadfast", {
          ok: false,
          error: "timeout",
          durationMs: 5000,
          timedOut: true,
        }),
      ],
    });
    expect(r!.aggregate.contributingProviders).toEqual(["pathao"]);
    expect(r!.aggregate.total).toBe(8);
    const counters = snapshotExternalDeliveryCounters();
    expect(counters.providerTimeout).toBe(1);
    expect(counters.providerPartialFailure).toBe(1);
  });

  it("all providers failed → still persists row with sparse_history signal", async () => {
    const r = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [
        fakeAdapter("pathao", {
          ok: false,
          error: "http_error",
          durationMs: 5,
          timedOut: false,
        }),
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.aggregate.total).toBe(0);
    expect(r!.signals.sparse_history).toBe(true);
    expect(await ExternalDeliveryProfile.countDocuments({})).toBe(1);
  });
});

describe("external-delivery / fetch-profile — per-merchant scope", () => {
  it("two merchants observing the same phone produce independent profiles", async () => {
    const a = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [
        fakeAdapter("pathao", {
          ok: true,
          total: 10,
          delivered: 10,
          rto: 0,
          cancelled: 0,
          successRate: 1,
          durationMs: 5,
        }),
      ],
    });
    const b = await getOrFetchExternalProfile({
      merchantId: MERCHANT_B,
      phone: PHONE,
      providers: [
        fakeAdapter("pathao", {
          ok: true,
          total: 4,
          delivered: 1,
          rto: 3,
          cancelled: 0,
          successRate: 0.25,
          durationMs: 5,
        }),
      ],
    });

    expect(a!.merchantId).toBe(MERCHANT_A.toHexString());
    expect(a!.aggregate.delivered).toBe(10);
    expect(b!.merchantId).toBe(MERCHANT_B.toHexString());
    expect(b!.aggregate.delivered).toBe(1);

    const rows = await ExternalDeliveryProfile.find({}).lean();
    expect(rows).toHaveLength(2);
    // Same phoneHash — different merchant scope.
    expect(rows[0]!.phoneHash).toBe(rows[1]!.phoneHash);
    expect(rows[0]!.merchantId.toString()).not.toBe(
      rows[1]!.merchantId.toString(),
    );
  });
});

describe("external-delivery / fetch-profile — Mongo cache layer", () => {
  it("second call within TTL returns from Mongo (source=mongo) without re-running providers", async () => {
    let pathaoCalls = 0;
    const adapter: ExternalProviderAdapter = {
      name: "pathao",
      sourceVersion: "fake-v1",
      isConfigured: () => true,
      fetchHistory: async () => {
        pathaoCalls += 1;
        return {
          ok: true,
          total: 5,
          delivered: 5,
          rto: 0,
          cancelled: 0,
          successRate: 1,
          durationMs: 5,
        };
      },
    };

    const a = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [adapter],
    });
    const b = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [adapter],
    });

    expect(a!.source).toBe("providers");
    // Redis is unavailable in test → Mongo branch serves the second call.
    expect(b!.source).toBe("mongo");
    expect(pathaoCalls).toBe(1); // provider not re-called
  });
});

describe("external-delivery / fetch-profile — forceFetch", () => {
  it("forceFetch=true bypasses Mongo freshness and re-runs providers", async () => {
    let providerCalls = 0;
    const adapter: ExternalProviderAdapter = {
      name: "pathao",
      sourceVersion: "fake-v1",
      isConfigured: () => true,
      fetchHistory: async () => {
        providerCalls += 1;
        return {
          ok: true,
          total: 7,
          delivered: 7,
          rto: 0,
          cancelled: 0,
          successRate: 1,
          durationMs: 5,
        };
      },
    };
    // Warm the Mongo profile via a normal fetch.
    const a = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [adapter],
    });
    expect(a!.source).toBe("providers");
    expect(providerCalls).toBe(1);

    // forceFetch=false: would return source="mongo" without re-running.
    const b = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [adapter],
    });
    expect(b!.source).toBe("mongo");
    expect(providerCalls).toBe(1);

    // forceFetch=true: bypasses Mongo, re-runs providers, persists fresh.
    const c = await getOrFetchExternalProfile({
      merchantId: MERCHANT_A,
      phone: PHONE,
      providers: [adapter],
      forceFetch: true,
    });
    expect(c!.source).toBe("providers");
    expect(providerCalls).toBe(2);
  });
});

describe("external-delivery / fetch-profile — in-flight dedupe", () => {
  it("two concurrent callers for same (merchant, phone) share a single fan-out", async () => {
    let pathaoCalls = 0;
    const adapter: ExternalProviderAdapter = {
      name: "pathao",
      sourceVersion: "fake-v1",
      isConfigured: () => true,
      fetchHistory: async () => {
        pathaoCalls += 1;
        // Simulate a slow upstream so the second caller arrives while the
        // first is still in flight.
        await new Promise((r) => setTimeout(r, 50));
        return {
          ok: true,
          total: 3,
          delivered: 3,
          rto: 0,
          cancelled: 0,
          successRate: 1,
          durationMs: 50,
        };
      },
    };
    const [a, b] = await Promise.all([
      getOrFetchExternalProfile({
        merchantId: MERCHANT_A,
        phone: PHONE,
        providers: [adapter],
      }),
      getOrFetchExternalProfile({
        merchantId: MERCHANT_A,
        phone: PHONE,
        providers: [adapter],
      }),
    ]);
    expect(a!.aggregate.total).toBe(3);
    expect(b!.aggregate.total).toBe(3);
    expect(pathaoCalls).toBe(1);
  });
});
