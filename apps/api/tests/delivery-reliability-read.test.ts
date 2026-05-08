import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  AddressReliability,
  COURIER_PERF_GLOBAL_DISTRICT,
  CourierPerformance,
  CustomerReliability,
} from "@ecom/db";
import {
  __TEST,
  loadDeliveryReliability,
} from "../src/lib/delivery-reliability-read.js";
import { recordCustomerOutcome, recordAddressOutcome } from "../src/lib/delivery-reliability-writers.js";
import { hashPhoneForNetwork } from "../src/lib/fraud-network.js";
import { env } from "../src/env.js";
import { ensureDb, disconnectDb, resetDb } from "./helpers.js";

/**
 * S6 — read-path integration tests for the `loadDeliveryReliability`
 * helper. Read-only surface; does not exercise the chokepoint or any
 * write path. The aggregates are seeded directly via the writer helpers
 * (S3) where convenient, or via `Model.create` for stale-state setups.
 */

type MutableEnv = { -readonly [K in keyof typeof env]: typeof env[K] };
function setReadFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_READ_ENABLED = value;
}
function setWriteFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_WRITE_ENABLED = value;
}

let originalRead: boolean;
let originalWrite: boolean;

beforeEach(async () => {
  await ensureDb();
  await resetDb();
  originalRead = env.DELIVERY_RELIABILITY_READ_ENABLED;
  originalWrite = env.DELIVERY_RELIABILITY_WRITE_ENABLED;
  setReadFlag(true);
  setWriteFlag(true);
});

afterEach(() => {
  setReadFlag(originalRead);
  setWriteFlag(originalWrite);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const TEST_PHONE = "+8801711222333";
const TEST_DISTRICT = "Dhaka";
const TEST_COURIER = "steadfast";
const ADDRESS_HASH = "ad_" + "c".repeat(29);

/* ========================================================================== */
/* Flag-off behavior                                                          */
/* ========================================================================== */

describe("loadDeliveryReliability — flag-off", () => {
  it("returns null without issuing any DB lookup when flag is off", async () => {
    setReadFlag(false);
    const merchantId = new Types.ObjectId();
    // Seed data so a flag-on path WOULD hit it.
    await recordCustomerOutcome({
      merchantId,
      phoneHash: hashPhoneForNetwork(TEST_PHONE)!,
      outcome: "delivered",
      now: new Date(),
    });
    const findSpy = vi.spyOn(CustomerReliability, "findOne");
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
    });
    expect(r).toBeNull();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("returns null without DB I/O when input is null/undefined", async () => {
    expect(
      // @ts-expect-error
      await loadDeliveryReliability(null),
    ).toBeNull();
    expect(
      // @ts-expect-error
      await loadDeliveryReliability(undefined),
    ).toBeNull();
  });

  it("returns null when merchantId is invalid", async () => {
    const r = await loadDeliveryReliability({
      merchantId: "not-an-objectid",
      phone: TEST_PHONE,
    });
    expect(r).toBeNull();
  });
});

/* ========================================================================== */
/* Flag-on with no aggregates — graceful no_data                              */
/* ========================================================================== */

describe("loadDeliveryReliability — no aggregates", () => {
  it("returns tier=no_data when no aggregate row exists", async () => {
    const merchantId = new Types.ObjectId();
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      addressHash: ADDRESS_HASH,
      courier: TEST_COURIER,
      district: TEST_DISTRICT,
    });
    expect(r).not.toBeNull();
    expect(r!.tier).toBe("no_data");
    expect(r!.noData).toBe(true);
    expect(r!.confidence).toBe("unknown");
    expect(r!.samplesConsidered).toEqual({ customer: 0, address: 0, courier: 0 });
    expect(r!.stale).toBe(false);
  });

  it("returns tier=no_data when phone/address/courier/district all absent", async () => {
    const merchantId = new Types.ObjectId();
    const r = await loadDeliveryReliability({ merchantId });
    expect(r!.tier).toBe("no_data");
    expect(r!.noData).toBe(true);
  });
});

/* ========================================================================== */
/* Flag-on with full data — happy path                                        */
/* ========================================================================== */

describe("loadDeliveryReliability — happy path", () => {
  it("classifies a buyer with strong delivery history as verified-leaning", async () => {
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    const now = new Date();

    // Seed 10 deliveries over time.
    for (let i = 0; i < 10; i++) {
      await recordCustomerOutcome({
        merchantId,
        phoneHash,
        outcome: "delivered",
        now,
      });
    }
    // Seed a strong courier lane (50 obs, 92% success). Production writers
    // (`recordCourierOutcome`) normalise district before storing — mirror that.
    await CourierPerformance.create({
      merchantId,
      courier: TEST_COURIER,
      district: TEST_DISTRICT.toLowerCase(),
      deliveredCount: 46,
      rtoCount: 3,
      cancelledCount: 1,
      totalDeliveryHours: 46 * 24,
      lastOutcomeAt: now,
    });

    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      courier: TEST_COURIER,
      district: TEST_DISTRICT,
      now,
    });
    expect(r).not.toBeNull();
    expect(r!.tier).toBe("verified");
    expect(r!.confidence).toBe("high");
    expect(r!.score).toBeGreaterThanOrEqual(70);
    expect(r!.signals.find((s) => s.key === "customer_repeat_success")).toBeDefined();
    expect(r!.signals.find((s) => s.key === "courier_lane_strong")).toBeDefined();
    expect(r!.samplesConsidered.customer).toBe(10);
    expect(r!.samplesConsidered.courier).toBe(50);
    expect(r!.stale).toBe(false);
    expect(r!.noData).toBe(false);
  });

  it("classifies a high-RTO buyer as unverified-leaning", async () => {
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await recordCustomerOutcome({
        merchantId,
        phoneHash,
        outcome: "rto",
        now,
      });
    }
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      now,
    });
    expect(r).not.toBeNull();
    expect(["unverified", "implicit"]).toContain(r!.tier);
    expect(r!.signals.find((s) => s.key === "customer_repeat_rto")).toBeDefined();
  });

  it("confidence map: verified→high, implicit→medium, unverified→low, no_data→unknown", () => {
    expect(__TEST.tierToConfidence("verified")).toBe("high");
    expect(__TEST.tierToConfidence("implicit")).toBe("medium");
    expect(__TEST.tierToConfidence("unverified")).toBe("low");
    expect(__TEST.tierToConfidence("no_data")).toBe("unknown");
  });
});

/* ========================================================================== */
/* Partial data fallback                                                      */
/* ========================================================================== */

describe("loadDeliveryReliability — partial aggregates", () => {
  it("uses customer-only data when address + courier aggregates are absent", async () => {
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    for (let i = 0; i < 5; i++) {
      await recordCustomerOutcome({
        merchantId,
        phoneHash,
        outcome: "delivered",
        now: new Date(),
      });
    }
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
    });
    expect(r!.tier).not.toBe("no_data");
    expect(r!.samplesConsidered.customer).toBe(5);
    expect(r!.samplesConsidered.address).toBe(0);
    expect(r!.samplesConsidered.courier).toBe(0);
  });

  it("uses address-only data when customer + courier are absent", async () => {
    const merchantId = new Types.ObjectId();
    for (let i = 0; i < 4; i++) {
      await recordAddressOutcome({
        merchantId,
        addressHash: ADDRESS_HASH,
        outcome: "delivered",
        now: new Date(),
      });
    }
    const r = await loadDeliveryReliability({
      merchantId,
      addressHash: ADDRESS_HASH,
    });
    expect(r!.tier).not.toBe("no_data");
    expect(r!.samplesConsidered.address).toBe(4);
  });

  it("falls back to global courier row when district row is too cold-start", async () => {
    const merchantId = new Types.ObjectId();
    const now = new Date();
    // Cold-start district row + healthy global aggregate.
    await CourierPerformance.create({
      merchantId,
      courier: TEST_COURIER,
      district: TEST_DISTRICT.toLowerCase(),
      deliveredCount: 2,
      rtoCount: 0,
      cancelledCount: 0,
      lastOutcomeAt: now,
    });
    await CourierPerformance.create({
      merchantId,
      courier: TEST_COURIER,
      district: COURIER_PERF_GLOBAL_DISTRICT,
      deliveredCount: 90,
      rtoCount: 5,
      cancelledCount: 5,
      totalDeliveryHours: 90 * 22,
      lastOutcomeAt: now,
    });
    const r = await loadDeliveryReliability({
      merchantId,
      courier: TEST_COURIER,
      district: TEST_DISTRICT,
      now,
    });
    expect(r!.samplesConsidered.courier).toBe(100); // global was picked
    expect(r!.signals.find((s) => s.key === "courier_lane_strong")).toBeDefined();
  });
});

/* ========================================================================== */
/* Stale aggregates                                                           */
/* ========================================================================== */

describe("loadDeliveryReliability — stale aggregates", () => {
  it("flags stale=true when customer row's lastOutcomeAt is past the staleness cutoff", async () => {
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    const now = new Date();
    // Direct insert with old timestamps so we don't have to manipulate writer time.
    await CustomerReliability.create({
      merchantId,
      phoneHash,
      deliveredCount: 5,
      rtoCount: 0,
      cancelledCount: 0,
      firstOutcomeAt: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
      lastOutcomeAt: new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000),
    });
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      now,
    });
    expect(r).not.toBeNull();
    expect(r!.stale).toBe(true);
    // Stale axis is treated as cold-start by the classifier — no
    // customer signals fire, so result tips to no_data on this single
    // axis alone.
    expect(r!.tier).toBe("no_data");
  });

  it("does NOT flag stale when lastOutcomeAt is just under 180d ago", async () => {
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    const now = new Date();
    await CustomerReliability.create({
      merchantId,
      phoneHash,
      deliveredCount: 5,
      rtoCount: 0,
      cancelledCount: 0,
      firstOutcomeAt: new Date(now.getTime() - 170 * 24 * 60 * 60 * 1000),
      lastOutcomeAt: new Date(now.getTime() - 170 * 24 * 60 * 60 * 1000),
    });
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      now,
    });
    expect(r!.stale).toBe(false);
    expect(r!.tier).not.toBe("no_data");
  });
});

/* ========================================================================== */
/* Corrupted aggregates — tolerate without throwing                           */
/* ========================================================================== */

describe("loadDeliveryReliability — corrupted aggregates", () => {
  it("tolerates a row with null counters (treats them as 0)", async () => {
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    // Bypass schema defaults by using the raw collection driver — simulates
    // a row that landed via a buggy direct write at some point.
    const coll = CustomerReliability.collection;
    await coll.insertOne({
      merchantId,
      phoneHash,
      deliveredCount: null,
      rtoCount: 5,
      cancelledCount: 0,
      lastOutcomeAt: new Date(),
      firstOutcomeAt: new Date(),
    });
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
    });
    expect(r).not.toBeNull();
    // No throw; classifier saw deliveredCount as missing → safeCount → 0,
    // total observations = 5, customer_repeat_rto + customer_low_success_rate fire.
    expect(r!.tier).not.toBe("no_data");
  });

  it("does not throw when a Mongo lookup rejects — treats that axis as absent", async () => {
    const merchantId = new Types.ObjectId();
    vi.spyOn(CustomerReliability, "findOne").mockImplementationOnce((() => ({
      lean: () => ({
        exec: () => Promise.reject(new Error("simulated mongo failure")),
      }),
    })) as never);
    // Seed the address axis so the call can produce a non-null result.
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      now: new Date(),
    });
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      now: new Date(),
    });
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      now: new Date(),
    });
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      addressHash: ADDRESS_HASH,
    });
    expect(r).not.toBeNull();
    expect(r!.samplesConsidered.customer).toBe(0); // failed read → axis absent
    expect(r!.samplesConsidered.address).toBe(3);
  });

  it("does not throw when ALL three Mongo reads reject — returns no_data cleanly", async () => {
    const merchantId = new Types.ObjectId();
    const fail = (() => ({
      lean: () => ({
        exec: () => Promise.reject(new Error("simulated mongo failure")),
      }),
    })) as never;
    vi.spyOn(CustomerReliability, "findOne").mockImplementation(fail);
    vi.spyOn(AddressReliability, "findOne").mockImplementation(fail);
    vi.spyOn(CourierPerformance, "find").mockImplementation(fail);
    const r = await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      addressHash: ADDRESS_HASH,
      courier: TEST_COURIER,
      district: TEST_DISTRICT,
    });
    expect(r).not.toBeNull();
    expect(r!.tier).toBe("no_data");
    expect(r!.noData).toBe(true);
  });
});

/* ========================================================================== */
/* Observational-only — no side-effects                                       */
/* ========================================================================== */

describe("loadDeliveryReliability — observational-only invariants", () => {
  it("does NOT issue any write to CustomerReliability", async () => {
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    await recordCustomerOutcome({
      merchantId,
      phoneHash,
      outcome: "delivered",
      now: new Date(),
    });
    const before = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    const after = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(after!.deliveredCount).toBe(before!.deliveredCount);
    expect(after!.lastOutcomeAt?.getTime()).toBe(before!.lastOutcomeAt?.getTime());
  });

  it("does NOT issue any write to AddressReliability", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      now: new Date(),
    });
    const before = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      addressHash: ADDRESS_HASH,
    });
    const after = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(after!.deliveredCount).toBe(before!.deliveredCount);
  });

  it("issues at most THREE Mongo lookups per call (bounded query count)", async () => {
    const merchantId = new Types.ObjectId();
    const custSpy = vi.spyOn(CustomerReliability, "findOne");
    const addrSpy = vi.spyOn(AddressReliability, "findOne");
    const courierSpy = vi.spyOn(CourierPerformance, "find");
    await loadDeliveryReliability({
      merchantId,
      phone: TEST_PHONE,
      addressHash: ADDRESS_HASH,
      courier: TEST_COURIER,
      district: TEST_DISTRICT,
    });
    expect(custSpy).toHaveBeenCalledTimes(1);
    expect(addrSpy).toHaveBeenCalledTimes(1);
    expect(courierSpy).toHaveBeenCalledTimes(1);
  });

  it("issues ZERO Mongo lookups when the relevant input is absent", async () => {
    const merchantId = new Types.ObjectId();
    const custSpy = vi.spyOn(CustomerReliability, "findOne");
    const addrSpy = vi.spyOn(AddressReliability, "findOne");
    const courierSpy = vi.spyOn(CourierPerformance, "find");
    await loadDeliveryReliability({ merchantId });
    expect(custSpy).not.toHaveBeenCalled();
    expect(addrSpy).not.toHaveBeenCalled();
    expect(courierSpy).not.toHaveBeenCalled();
  });

  it("never throws on a sweep of plausible inputs", async () => {
    const merchantId = new Types.ObjectId();
    const inputs: Parameters<typeof loadDeliveryReliability>[0][] = [
      { merchantId },
      { merchantId, phone: "" },
      { merchantId, phone: TEST_PHONE, addressHash: "" },
      { merchantId, phone: TEST_PHONE, addressHash: "x".repeat(70) },
      { merchantId, courier: "", district: TEST_DISTRICT },
      { merchantId, courier: TEST_COURIER, district: "" },
    ];
    for (const i of inputs) {
      await expect(loadDeliveryReliability(i)).resolves.not.toThrow();
    }
  });
});

/* ========================================================================== */
/* Cooperation with the write flag                                            */
/* ========================================================================== */

describe("loadDeliveryReliability — write/read flag cooperation", () => {
  it("write-on / read-on: full data flow", async () => {
    setWriteFlag(true);
    setReadFlag(true);
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    for (let i = 0; i < 5; i++) {
      await recordCustomerOutcome({
        merchantId,
        phoneHash,
        outcome: "delivered",
        now: new Date(),
      });
    }
    const r = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(r!.tier).not.toBe("no_data");
  });

  it("write-off / read-on: no aggregates exist → tier=no_data (cold start)", async () => {
    setWriteFlag(false);
    setReadFlag(true);
    const merchantId = new Types.ObjectId();
    const r = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(r!.tier).toBe("no_data");
  });

  it("write-on / read-off: aggregates accumulate but read is suppressed", async () => {
    setWriteFlag(true);
    setReadFlag(false);
    const merchantId = new Types.ObjectId();
    const phoneHash = hashPhoneForNetwork(TEST_PHONE)!;
    await recordCustomerOutcome({
      merchantId,
      phoneHash,
      outcome: "delivered",
      now: new Date(),
    });
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust!.deliveredCount).toBe(1);
    // Read is suppressed.
    const r = await loadDeliveryReliability({ merchantId, phone: TEST_PHONE });
    expect(r).toBeNull();
  });
});
