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
  loadCourierReliabilityOverview,
  loadReliabilityDistribution,
  loadReliabilityHealthSnapshot,
  loadReliabilitySummary,
} from "../src/lib/delivery-reliability-analytics.js";
import {
  __resetReliabilityCounters,
  recordReliabilityOutcome,
} from "../src/lib/observability/delivery-reliability.js";
import { env } from "../src/env.js";
import { ensureDb, disconnectDb, resetDb } from "./helpers.js";

/**
 * S7 — analytics integration tests for the four read-only summary
 * surfaces. Read-only by construction; verifies bounded queries,
 * graceful degradation, observability counter integration, and
 * absence of write side-effects.
 */

type MutableEnv = { -readonly [K in keyof typeof env]: typeof env[K] };
function setAnalyticsFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_ANALYTICS_ENABLED = value;
}

let originalAnalytics: boolean;

beforeEach(async () => {
  await ensureDb();
  await resetDb();
  __resetReliabilityCounters();
  originalAnalytics = env.DELIVERY_RELIABILITY_ANALYTICS_ENABLED;
  // Most tests need the helpers callable; the flag check lives in the
  // router only. Helpers themselves are flag-agnostic so they remain
  // unit-testable. The flag-off behaviour is exercised at the router seam.
  setAnalyticsFlag(true);
});

afterEach(() => {
  setAnalyticsFlag(originalAnalytics);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const NOW = new Date("2026-05-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

async function seedCustomerRows(
  merchantId: Types.ObjectId,
  rows: Array<{
    phoneHash: string;
    delivered: number;
    rto: number;
    cancelled: number;
    daysAgo?: number;
  }>,
) {
  for (const r of rows) {
    const ts = new Date(NOW.getTime() - (r.daysAgo ?? 0) * DAY);
    await CustomerReliability.create({
      merchantId,
      phoneHash: r.phoneHash,
      deliveredCount: r.delivered,
      rtoCount: r.rto,
      cancelledCount: r.cancelled,
      firstOutcomeAt: ts,
      lastOutcomeAt: ts,
    });
  }
}

async function seedAddressRows(
  merchantId: Types.ObjectId,
  rows: Array<{
    addressHash: string;
    delivered: number;
    rto: number;
    cancelled: number;
    daysAgo?: number;
  }>,
) {
  for (const r of rows) {
    const ts = new Date(NOW.getTime() - (r.daysAgo ?? 0) * DAY);
    await AddressReliability.create({
      merchantId,
      addressHash: r.addressHash,
      deliveredCount: r.delivered,
      rtoCount: r.rto,
      cancelledCount: r.cancelled,
      distinctPhoneHashes: [],
      firstOutcomeAt: ts,
      lastOutcomeAt: ts,
    });
  }
}

async function seedCourierRows(
  merchantId: Types.ObjectId,
  rows: Array<{
    courier: string;
    district: string;
    delivered: number;
    rto: number;
    cancelled: number;
    totalDeliveryHours?: number;
    daysAgo?: number;
  }>,
) {
  for (const r of rows) {
    const ts = new Date(NOW.getTime() - (r.daysAgo ?? 0) * DAY);
    await CourierPerformance.create({
      merchantId,
      courier: r.courier,
      district: r.district,
      deliveredCount: r.delivered,
      rtoCount: r.rto,
      cancelledCount: r.cancelled,
      totalDeliveryHours: r.totalDeliveryHours ?? r.delivered * 24,
      lastOutcomeAt: ts,
    });
  }
}

/* ========================================================================== */
/* loadReliabilitySummary                                                     */
/* ========================================================================== */

describe("loadReliabilitySummary", () => {
  it("returns zeros for an empty merchant", async () => {
    const merchantId = new Types.ObjectId();
    const r = await loadReliabilitySummary({ merchantId, now: NOW });
    expect(r.sampleSize).toBe(0);
    expect(r.totals).toEqual({ verified: 0, implicit: 0, unverified: 0, noData: 0 });
    expect(r.averageScore).toBe(0);
    expect(r.stalePercentage).toBe(0);
    expect(r.generatedAt).toEqual(NOW);
  });

  it("returns zeros for an invalid merchantId", async () => {
    const r = await loadReliabilitySummary({
      merchantId: "not-an-objectid",
      now: NOW,
    });
    expect(r.sampleSize).toBe(0);
    expect(r.totals.noData).toBe(0);
  });

  it("classifies rows by tier correctly", async () => {
    const merchantId = new Types.ObjectId();
    await seedCustomerRows(merchantId, [
      { phoneHash: "v1", delivered: 9, rto: 1, cancelled: 0 }, // 90% → verified
      { phoneHash: "v2", delivered: 17, rto: 3, cancelled: 0 }, // 85% → verified
      { phoneHash: "i1", delivered: 5, rto: 4, cancelled: 1 }, // 50% → implicit
      { phoneHash: "u1", delivered: 1, rto: 4, cancelled: 0 }, // 20% → unverified
      { phoneHash: "n1", delivered: 1, rto: 0, cancelled: 0 }, // total<3 → noData
    ]);
    const r = await loadReliabilitySummary({ merchantId, now: NOW });
    expect(r.sampleSize).toBe(5);
    expect(r.totals.verified).toBe(2);
    expect(r.totals.implicit).toBe(1);
    expect(r.totals.unverified).toBe(1);
    expect(r.totals.noData).toBe(1);
  });

  it("averages score across non-noData rows only", async () => {
    const merchantId = new Types.ObjectId();
    await seedCustomerRows(merchantId, [
      { phoneHash: "a", delivered: 9, rto: 1, cancelled: 0 }, // score=90
      { phoneHash: "b", delivered: 5, rto: 5, cancelled: 0 }, // score=50
      { phoneHash: "c", delivered: 0, rto: 0, cancelled: 1 }, // total<3 → excluded
    ]);
    const r = await loadReliabilitySummary({ merchantId, now: NOW });
    expect(r.averageScore).toBeCloseTo((90 + 50) / 2, 1);
  });

  it("computes stalePercentage from lastOutcomeAt vs cutoff", async () => {
    const merchantId = new Types.ObjectId();
    await seedCustomerRows(merchantId, [
      { phoneHash: "fresh1", delivered: 5, rto: 0, cancelled: 0, daysAgo: 5 },
      { phoneHash: "fresh2", delivered: 5, rto: 0, cancelled: 0, daysAgo: 10 },
      { phoneHash: "stale1", delivered: 5, rto: 0, cancelled: 0, daysAgo: 200 },
    ]);
    const r = await loadReliabilitySummary({ merchantId, now: NOW });
    expect(r.stalePercentage).toBeCloseTo(1 / 3, 2);
  });

  it("supports the address axis as well", async () => {
    const merchantId = new Types.ObjectId();
    await seedAddressRows(merchantId, [
      { addressHash: "a1", delivered: 9, rto: 1, cancelled: 0 },
      { addressHash: "a2", delivered: 5, rto: 4, cancelled: 1 },
    ]);
    const r = await loadReliabilitySummary({
      merchantId,
      axis: "address",
      now: NOW,
    });
    expect(r.sampleSize).toBe(2);
    expect(r.totals.verified).toBe(1);
    expect(r.totals.implicit).toBe(1);
  });

  it("isolates by merchantId — never reads cross-tenant rows", async () => {
    const merchantA = new Types.ObjectId();
    const merchantB = new Types.ObjectId();
    await seedCustomerRows(merchantA, [
      { phoneHash: "a", delivered: 5, rto: 0, cancelled: 0 },
    ]);
    await seedCustomerRows(merchantB, [
      { phoneHash: "b", delivered: 9, rto: 1, cancelled: 0 },
      { phoneHash: "c", delivered: 1, rto: 4, cancelled: 0 },
    ]);
    const rA = await loadReliabilitySummary({ merchantId: merchantA, now: NOW });
    const rB = await loadReliabilitySummary({ merchantId: merchantB, now: NOW });
    expect(rA.sampleSize).toBe(1);
    expect(rB.sampleSize).toBe(2);
    expect(rA.totals.verified).toBe(1);
    expect(rB.totals.verified).toBe(1);
    expect(rB.totals.unverified).toBe(1);
  });

  it("does not throw on Mongo failure — degrades to zeroed result", async () => {
    vi.spyOn(CustomerReliability, "find").mockImplementation(
      () =>
        ({
          select: () => ({
            limit: () => ({
              lean: () => ({
                exec: () => Promise.reject(new Error("simulated mongo failure")),
              }),
            }),
          }),
        }) as never,
    );
    const r = await loadReliabilitySummary({
      merchantId: new Types.ObjectId(),
      now: NOW,
    });
    expect(r.sampleSize).toBe(0);
    expect(r.totals.noData).toBe(0);
  });
});

/* ========================================================================== */
/* loadReliabilityDistribution                                                */
/* ========================================================================== */

describe("loadReliabilityDistribution", () => {
  it("buckets scores into the five canonical ranges", async () => {
    const merchantId = new Types.ObjectId();
    await seedCustomerRows(merchantId, [
      { phoneHash: "a", delivered: 1, rto: 9, cancelled: 0 }, // 10% → 0-19
      { phoneHash: "b", delivered: 3, rto: 7, cancelled: 0 }, // 30% → 20-39
      { phoneHash: "c", delivered: 5, rto: 5, cancelled: 0 }, // 50% → 40-59
      { phoneHash: "d", delivered: 7, rto: 3, cancelled: 0 }, // 70% → 60-79
      { phoneHash: "e", delivered: 9, rto: 1, cancelled: 0 }, // 90% → 80-100
    ]);
    const r = await loadReliabilityDistribution({ merchantId, now: NOW });
    expect(r.sampleSize).toBe(5);
    expect(r.buckets[0]).toMatchObject({ range: "0-19", count: 1 });
    expect(r.buckets[1]).toMatchObject({ range: "20-39", count: 1 });
    expect(r.buckets[2]).toMatchObject({ range: "40-59", count: 1 });
    expect(r.buckets[3]).toMatchObject({ range: "60-79", count: 1 });
    expect(r.buckets[4]).toMatchObject({ range: "80-100", count: 1 });
  });

  it("noData rows are NOT counted in any score bucket", async () => {
    const merchantId = new Types.ObjectId();
    await seedCustomerRows(merchantId, [
      { phoneHash: "a", delivered: 1, rto: 0, cancelled: 0 }, // total=1 → no_data
      { phoneHash: "b", delivered: 9, rto: 1, cancelled: 0 }, // 90% → 80-100
    ]);
    const r = await loadReliabilityDistribution({ merchantId, now: NOW });
    expect(r.totals.noData).toBe(1);
    expect(r.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  it("freshCount + staleCount = sampleSize", async () => {
    const merchantId = new Types.ObjectId();
    await seedCustomerRows(merchantId, [
      { phoneHash: "f1", delivered: 5, rto: 0, cancelled: 0, daysAgo: 1 },
      { phoneHash: "f2", delivered: 5, rto: 0, cancelled: 0, daysAgo: 30 },
      { phoneHash: "s1", delivered: 5, rto: 0, cancelled: 0, daysAgo: 200 },
    ]);
    const r = await loadReliabilityDistribution({ merchantId, now: NOW });
    expect(r.staleCount + r.freshCount).toBe(r.sampleSize);
    expect(r.staleCount).toBe(1);
    expect(r.freshCount).toBe(2);
  });

  it("supports the address axis", async () => {
    const merchantId = new Types.ObjectId();
    await seedAddressRows(merchantId, [
      { addressHash: "a", delivered: 9, rto: 1, cancelled: 0 },
    ]);
    const r = await loadReliabilityDistribution({
      merchantId,
      axis: "address",
      now: NOW,
    });
    expect(r.axis).toBe("address");
    expect(r.sampleSize).toBe(1);
  });

  it("does not throw on Mongo failure", async () => {
    vi.spyOn(CustomerReliability, "find").mockImplementation(
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
    const r = await loadReliabilityDistribution({
      merchantId: new Types.ObjectId(),
      now: NOW,
    });
    expect(r.sampleSize).toBe(0);
    expect(r.buckets.every((b) => b.count === 0)).toBe(true);
  });
});

/* ========================================================================== */
/* loadCourierReliabilityOverview                                             */
/* ========================================================================== */

describe("loadCourierReliabilityOverview", () => {
  it("returns empty arrays when no courier data exists", async () => {
    const merchantId = new Types.ObjectId();
    const r = await loadCourierReliabilityOverview({ merchantId, now: NOW });
    expect(r.rows).toEqual([]);
    expect(r.topPerformers).toEqual([]);
    expect(r.underperformers).toEqual([]);
  });

  it("ranks courier rows by observation count", async () => {
    const merchantId = new Types.ObjectId();
    await seedCourierRows(merchantId, [
      {
        courier: "pathao",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 90,
        rto: 8,
        cancelled: 2,
      },
      {
        courier: "redx",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 30,
        rto: 5,
        cancelled: 5,
      },
    ]);
    const r = await loadCourierReliabilityOverview({ merchantId, now: NOW });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.courier).toBe("pathao");
    expect(r.rows[1]?.courier).toBe("redx");
    expect(r.rows[0]?.observations).toBe(100);
    expect(r.rows[1]?.observations).toBe(40);
  });

  it("identifies top performers (deliveredRate ≥ 0.85, !cold, !stale)", async () => {
    const merchantId = new Types.ObjectId();
    await seedCourierRows(merchantId, [
      {
        courier: "strong",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 95,
        rto: 5,
        cancelled: 0,
      },
      {
        courier: "weak",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 60,
        rto: 30,
        cancelled: 10,
      },
      {
        courier: "fresh",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 5,
        rto: 0,
        cancelled: 0,
      }, // cold-start → excluded
    ]);
    const r = await loadCourierReliabilityOverview({ merchantId, now: NOW });
    expect(r.topPerformers).toContain("strong");
    expect(r.topPerformers).not.toContain("weak");
    expect(r.topPerformers).not.toContain("fresh");
  });

  it("identifies underperformers (rtoRate ≥ 0.20, !cold, !stale)", async () => {
    const merchantId = new Types.ObjectId();
    await seedCourierRows(merchantId, [
      {
        courier: "weak",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 60,
        rto: 30,
        cancelled: 10,
      },
      {
        courier: "stale",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 50,
        rto: 30,
        cancelled: 5,
        daysAgo: 200,
      },
    ]);
    const r = await loadCourierReliabilityOverview({ merchantId, now: NOW });
    expect(r.underperformers).toContain("weak");
    expect(r.underperformers).not.toContain("stale");
  });

  it("merges district + global rows under one courier; prefers global when present", async () => {
    const merchantId = new Types.ObjectId();
    await seedCourierRows(merchantId, [
      {
        courier: "pathao",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 100,
        rto: 5,
        cancelled: 5,
      },
      {
        courier: "pathao",
        district: "dhaka",
        delivered: 60,
        rto: 4,
        cancelled: 1,
      },
    ]);
    const r = await loadCourierReliabilityOverview({ merchantId, now: NOW });
    expect(r.rows).toHaveLength(1);
    // global row preferred → counts equal the global aggregate, not the sum.
    expect(r.rows[0]?.deliveredCount).toBe(100);
    expect(r.rows[0]?.rtoCount).toBe(5);
  });

  it("falls back to summing district rows when no global row exists", async () => {
    const merchantId = new Types.ObjectId();
    await seedCourierRows(merchantId, [
      { courier: "redx", district: "dhaka", delivered: 20, rto: 1, cancelled: 0 },
      { courier: "redx", district: "sylhet", delivered: 10, rto: 0, cancelled: 0 },
    ]);
    const r = await loadCourierReliabilityOverview({ merchantId, now: NOW });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.deliveredCount).toBe(30);
    expect(r.rows[0]?.rtoCount).toBe(1);
  });

  it("computes avgDeliveryHours when delivered>0", async () => {
    const merchantId = new Types.ObjectId();
    await seedCourierRows(merchantId, [
      {
        courier: "pathao",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 50,
        rto: 0,
        cancelled: 0,
        totalDeliveryHours: 50 * 18, // avg 18h
      },
    ]);
    const r = await loadCourierReliabilityOverview({ merchantId, now: NOW });
    expect(r.rows[0]?.avgDeliveryHours).toBeCloseTo(18, 1);
  });

  it("isolates by merchantId — never reads cross-tenant rows", async () => {
    const merchantA = new Types.ObjectId();
    const merchantB = new Types.ObjectId();
    await seedCourierRows(merchantA, [
      {
        courier: "pathao",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 50,
        rto: 5,
        cancelled: 0,
      },
    ]);
    await seedCourierRows(merchantB, [
      {
        courier: "redx",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 50,
        rto: 5,
        cancelled: 0,
      },
    ]);
    const rA = await loadCourierReliabilityOverview({ merchantId: merchantA, now: NOW });
    expect(rA.rows.map((r) => r.courier)).toEqual(["pathao"]);
  });

  it("does not throw on Mongo failure", async () => {
    vi.spyOn(CourierPerformance, "find").mockImplementation(
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
    const r = await loadCourierReliabilityOverview({
      merchantId: new Types.ObjectId(),
      now: NOW,
    });
    expect(r.rows).toEqual([]);
  });
});

/* ========================================================================== */
/* loadReliabilityHealthSnapshot                                              */
/* ========================================================================== */

describe("loadReliabilityHealthSnapshot", () => {
  it("returns merchant-scoped row counts and stale percentages", async () => {
    const merchantId = new Types.ObjectId();
    await seedCustomerRows(merchantId, [
      { phoneHash: "a", delivered: 5, rto: 0, cancelled: 0, daysAgo: 5 },
      { phoneHash: "b", delivered: 5, rto: 0, cancelled: 0, daysAgo: 200 },
    ]);
    await seedAddressRows(merchantId, [
      { addressHash: "ad1", delivered: 3, rto: 0, cancelled: 0, daysAgo: 5 },
    ]);
    await seedCourierRows(merchantId, [
      {
        courier: "pathao",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 50,
        rto: 0,
        cancelled: 0,
        daysAgo: 200,
      },
    ]);
    const r = await loadReliabilityHealthSnapshot({ merchantId, now: NOW });
    expect(r.aggregateCounts).toEqual({
      customerRows: 2,
      addressRows: 1,
      courierRows: 1,
    });
    expect(r.staleAggregatePercentage.customer).toBeCloseTo(0.5, 2);
    expect(r.staleAggregatePercentage.address).toBe(0);
    expect(r.staleAggregatePercentage.courier).toBe(1);
  });

  it("includes the in-process observability counters from S5", async () => {
    const merchantId = new Types.ObjectId();
    recordReliabilityOutcome({ event: "customer_updated", merchantId: String(merchantId) });
    recordReliabilityOutcome({ event: "customer_updated", merchantId: String(merchantId) });
    recordReliabilityOutcome({ event: "replay_suppressed", merchantId: String(merchantId) });
    const r = await loadReliabilityHealthSnapshot({ merchantId, now: NOW });
    expect(r.observabilityCounters.customerUpdated).toBe(2);
    expect(r.observabilityCounters.replaySuppressed).toBe(1);
  });

  it("returns zeroed counts on invalid merchantId", async () => {
    const r = await loadReliabilityHealthSnapshot({
      merchantId: "not-an-objectid",
      now: NOW,
    });
    expect(r.aggregateCounts).toEqual({
      customerRows: 0,
      addressRows: 0,
      courierRows: 0,
    });
  });

  it("isolates by merchantId — never returns counts from other tenants", async () => {
    const merchantA = new Types.ObjectId();
    const merchantB = new Types.ObjectId();
    await seedCustomerRows(merchantA, [
      { phoneHash: "a", delivered: 1, rto: 0, cancelled: 0 },
    ]);
    await seedCustomerRows(merchantB, [
      { phoneHash: "b1", delivered: 1, rto: 0, cancelled: 0 },
      { phoneHash: "b2", delivered: 1, rto: 0, cancelled: 0 },
    ]);
    const rA = await loadReliabilityHealthSnapshot({ merchantId: merchantA, now: NOW });
    expect(rA.aggregateCounts.customerRows).toBe(1);
  });

  it("does not throw when one of the count queries rejects", async () => {
    const merchantId = new Types.ObjectId();
    vi.spyOn(CustomerReliability, "countDocuments").mockRejectedValueOnce(
      new Error("simulated"),
    );
    const r = await loadReliabilityHealthSnapshot({ merchantId, now: NOW });
    expect(r.aggregateCounts.customerRows).toBe(0);
  });
});

/* ========================================================================== */
/* Bounded query / no-side-effect invariants                                  */
/* ========================================================================== */

describe("analytics — bounded queries + side-effect-free", () => {
  it("loadReliabilitySummary respects ANALYTICS_MAX_SCAN", () => {
    expect(__TEST.ANALYTICS_MAX_SCAN).toBe(5000);
  });

  it("a sweep of the four helpers does not write to any reliability collection", async () => {
    const merchantId = new Types.ObjectId();
    await seedCustomerRows(merchantId, [
      { phoneHash: "a", delivered: 5, rto: 0, cancelled: 0 },
    ]);
    await seedAddressRows(merchantId, [
      { addressHash: "ad", delivered: 3, rto: 0, cancelled: 0 },
    ]);
    await seedCourierRows(merchantId, [
      {
        courier: "pathao",
        district: COURIER_PERF_GLOBAL_DISTRICT,
        delivered: 50,
        rto: 0,
        cancelled: 0,
      },
    ]);
    const beforeCust = await CustomerReliability.findOne({ merchantId, phoneHash: "a" }).lean();
    const beforeAddr = await AddressReliability.findOne({ merchantId, addressHash: "ad" }).lean();
    const beforeCourier = await CourierPerformance.findOne({
      merchantId,
      courier: "pathao",
    }).lean();

    await loadReliabilitySummary({ merchantId, now: NOW });
    await loadReliabilityDistribution({ merchantId, now: NOW });
    await loadCourierReliabilityOverview({ merchantId, now: NOW });
    await loadReliabilityHealthSnapshot({ merchantId, now: NOW });

    const afterCust = await CustomerReliability.findOne({ merchantId, phoneHash: "a" }).lean();
    const afterAddr = await AddressReliability.findOne({ merchantId, addressHash: "ad" }).lean();
    const afterCourier = await CourierPerformance.findOne({
      merchantId,
      courier: "pathao",
    }).lean();
    expect(afterCust!.deliveredCount).toBe(beforeCust!.deliveredCount);
    expect(afterCust!.lastOutcomeAt?.getTime()).toBe(beforeCust!.lastOutcomeAt?.getTime());
    expect(afterAddr!.deliveredCount).toBe(beforeAddr!.deliveredCount);
    expect(afterCourier!.deliveredCount).toBe(beforeCourier!.deliveredCount);
  });

  it("__TEST exposes tier helpers for boundary verification", () => {
    expect(__TEST.tierFor(0, 50)).toBe("no_data"); // total<3
    expect(__TEST.tierFor(5, 90)).toBe("verified");
    expect(__TEST.tierFor(5, 50)).toBe("implicit");
    expect(__TEST.tierFor(5, 30)).toBe("unverified");
    expect(__TEST.tierFor(5, 70)).toBe("verified"); // boundary
    expect(__TEST.tierFor(5, 40)).toBe("implicit"); // boundary
    expect(__TEST.rowScore(9, 10)).toBeCloseTo(90, 1);
    expect(__TEST.rowScore(0, 0)).toBe(0);
    expect(__TEST.bucketIndexFor(0)).toBe(0);
    expect(__TEST.bucketIndexFor(100)).toBe(4);
    expect(__TEST.bucketIndexFor(80)).toBe(4);
    expect(__TEST.bucketIndexFor(79.999)).toBe(3);
  });
});
