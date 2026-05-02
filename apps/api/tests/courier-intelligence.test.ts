import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { CourierPerformance, COURIER_PERF_GLOBAL_DISTRICT } from "@ecom/db";
import {
  __TEST,
  recordCourierOutcome,
  scoreCourierCandidate,
  selectBestCourier,
} from "../src/lib/courier-intelligence.js";
import { normalizeDistrict } from "../src/lib/district.js";
import { ensureDb, disconnectDb, resetDb } from "./helpers.js";

const { MIN_OBSERVATIONS, NEUTRAL_SCORE, PREFERRED_BONUS, SPEED_BASELINE_HOURS, SCORE_WEIGHTS } = __TEST;

/* -------------------------------------------------------------------------- */
/* Pure scoring                                                                */
/* -------------------------------------------------------------------------- */

describe("scoreCourierCandidate", () => {
  it("returns the cold-start neutral score below MIN_OBSERVATIONS", () => {
    const r = scoreCourierCandidate({
      courier: "steadfast",
      district: "Dhaka",
      deliveredCount: 3,
      rtoCount: 1,
      cancelledCount: 1,
      totalDeliveryHours: 60,
    });
    expect(r.breakdown.coldStart).toBe(true);
    expect(r.score).toBe(NEUTRAL_SCORE);
  });

  it("adds PREFERRED_BONUS to a cold-start preferred courier", () => {
    const r = scoreCourierCandidate(
      { courier: "steadfast", district: "Dhaka", deliveredCount: 0, rtoCount: 0, cancelledCount: 0, totalDeliveryHours: 0 },
      { isPreferred: true },
    );
    expect(r.score).toBe(NEUTRAL_SCORE + PREFERRED_BONUS);
  });

  it("scores a high-success / low-rto / fast courier well above 80", () => {
    const r = scoreCourierCandidate({
      courier: "good",
      district: "Dhaka",
      deliveredCount: 95,
      rtoCount: 5,
      cancelledCount: 0,
      totalDeliveryHours: 95 * 18, // avg 18h
    });
    expect(r.breakdown.coldStart).toBe(false);
    expect(r.breakdown.successRate).toBeCloseTo(0.95, 5);
    expect(r.breakdown.rtoRate).toBeCloseTo(0.05, 5);
    expect(r.score).toBeGreaterThan(60);
  });

  it("scores a high-RTO courier below the success-only baseline", () => {
    const high = scoreCourierCandidate({
      courier: "high_success",
      district: "Dhaka",
      deliveredCount: 80, rtoCount: 0, cancelledCount: 20, totalDeliveryHours: 80 * 24,
    });
    const bad = scoreCourierCandidate({
      courier: "high_rto",
      district: "Dhaka",
      deliveredCount: 60, rtoCount: 35, cancelledCount: 5, totalDeliveryHours: 60 * 24,
    });
    expect(high.score).toBeGreaterThan(bad.score);
  });

  it("rewards faster delivery", () => {
    const fast = scoreCourierCandidate({
      courier: "fast",
      district: "Dhaka",
      deliveredCount: 50, rtoCount: 0, cancelledCount: 0, totalDeliveryHours: 50 * 12,
    });
    const slow = scoreCourierCandidate({
      courier: "slow",
      district: "Dhaka",
      deliveredCount: 50, rtoCount: 0, cancelledCount: 0, totalDeliveryHours: 50 * 48,
    });
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it("clamps the score into [0, 100]", () => {
    const worst = scoreCourierCandidate({
      courier: "worst",
      district: "Dhaka",
      deliveredCount: 0, rtoCount: 100, cancelledCount: 0, totalDeliveryHours: 0,
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });

  it("isPreferred adds PREFERRED_BONUS post-clamp", () => {
    const a = scoreCourierCandidate(
      { courier: "x", district: "D", deliveredCount: 50, rtoCount: 0, cancelledCount: 0, totalDeliveryHours: 50 * 24 },
      { isPreferred: false },
    );
    const b = scoreCourierCandidate(
      { courier: "x", district: "D", deliveredCount: 50, rtoCount: 0, cancelledCount: 0, totalDeliveryHours: 50 * 24 },
      { isPreferred: true },
    );
    expect(b.score - a.score).toBeCloseTo(PREFERRED_BONUS, 5);
  });
});

/* -------------------------------------------------------------------------- */
/* recordCourierOutcome + selectBestCourier (DB-backed)                        */
/* -------------------------------------------------------------------------- */

async function seed(merchantId: Types.ObjectId, opts: {
  courier: string;
  district: string;
  delivered: number;
  rto?: number;
  cancelled?: number;
  totalHours?: number;
}) {
  // Storage is keyed on the canonical (lowercased / aliased) district form,
  // matching what `recordCourierOutcome` writes in production. Sentinel
  // districts (e.g. _GLOBAL_) skip normalization so the test seeds a row
  // with the literal sentinel as the engine would.
  const district =
    opts.district === COURIER_PERF_GLOBAL_DISTRICT
      ? opts.district
      : normalizeDistrict(opts.district);
  await CourierPerformance.create({
    merchantId,
    courier: opts.courier,
    district,
    deliveredCount: opts.delivered,
    rtoCount: opts.rto ?? 0,
    cancelledCount: opts.cancelled ?? 0,
    totalDeliveryHours: opts.totalHours ?? opts.delivered * 24,
    lastOutcomeAt: new Date(),
  });
}

describe("recordCourierOutcome", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
  });
  afterAll(disconnectDb);

  it("upserts both per-district and _GLOBAL_ rows on first record", async () => {
    const m = new Types.ObjectId();
    await recordCourierOutcome({
      merchantId: m,
      courier: "Steadfast",
      district: "Dhaka",
      outcome: "delivered",
      deliveryHours: 18,
    });
    // recordCourierOutcome normalizes the district at the write boundary, so
    // storage uses the canonical lowercase key — same form selectBestCourier
    // queries on. The query here mirrors what the engine would issue.
    const district = await CourierPerformance.findOne({ merchantId: m, courier: "steadfast", district: "dhaka" }).lean();
    const global = await CourierPerformance.findOne({ merchantId: m, courier: "steadfast", district: COURIER_PERF_GLOBAL_DISTRICT }).lean();
    expect(district!.deliveredCount).toBe(1);
    expect(district!.totalDeliveryHours).toBe(18);
    expect(global!.deliveredCount).toBe(1);
  });

  it("increments existing rows on subsequent outcomes", async () => {
    const m = new Types.ObjectId();
    for (let i = 0; i < 3; i++) {
      await recordCourierOutcome({ merchantId: m, courier: "redx", district: "Chittagong", outcome: "rto" });
    }
    const row = await CourierPerformance.findOne({ merchantId: m, courier: "redx", district: "chittagong" }).lean();
    expect(row!.rtoCount).toBe(3);
    expect(row!.deliveredCount).toBe(0);
  });

  it("ignores invalid input (no courier or district)", async () => {
    const m = new Types.ObjectId();
    await recordCourierOutcome({ merchantId: m, courier: "", district: "Dhaka", outcome: "delivered" });
    await recordCourierOutcome({ merchantId: m, courier: "redx", district: "", outcome: "delivered" });
    expect(await CourierPerformance.countDocuments()).toBe(0);
  });
});

describe("selectBestCourier", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
  });
  afterAll(disconnectDb);

  it("picks the highest-scoring courier when district stats exist", async () => {
    const m = new Types.ObjectId();
    await seed(m, { courier: "good", district: "Dhaka", delivered: 90, rto: 10, totalHours: 90 * 18 });
    await seed(m, { courier: "bad",  district: "Dhaka", delivered: 60, rto: 40, totalHours: 60 * 30 });

    const r = await selectBestCourier({
      merchantId: m,
      district: "Dhaka",
      candidates: ["good", "bad"],
    });
    expect(r.best).toBe("good");
    expect(r.ranked[0]!.courier).toBe("good");
    expect(r.ranked[0]!.matchedOn).toBe("district");
  });

  it("falls back to _GLOBAL_ when district has insufficient observations", async () => {
    const m = new Types.ObjectId();
    // Only 2 orders in the specific district — under MIN_OBSERVATIONS.
    await seed(m, { courier: "steadfast", district: "Sylhet", delivered: 2, totalHours: 48 });
    // 80 in the global aggregate.
    await seed(m, { courier: "steadfast", district: COURIER_PERF_GLOBAL_DISTRICT, delivered: 80, rto: 0, totalHours: 80 * 22 });

    const r = await selectBestCourier({
      merchantId: m,
      district: "Sylhet",
      candidates: ["steadfast"],
    });
    expect(r.ranked[0]!.matchedOn).toBe("global");
    expect(r.ranked[0]!.breakdown.observations).toBe(80);
  });

  it("emits a cold_start candidate when no data exists", async () => {
    const m = new Types.ObjectId();
    const r = await selectBestCourier({
      merchantId: m,
      district: "Dhaka",
      candidates: ["steadfast"],
      preferredCourier: "steadfast",
    });
    expect(r.best).toBe("steadfast");
    expect(r.ranked[0]!.matchedOn).toBe("cold_start");
    expect(r.ranked[0]!.breakdown.coldStart).toBe(true);
    // Cold-start preferred bonus should land in the score.
    expect(r.ranked[0]!.score).toBe(NEUTRAL_SCORE + PREFERRED_BONUS);
  });

  it("returns best=null with empty candidates", async () => {
    const r = await selectBestCourier({
      merchantId: new Types.ObjectId(),
      district: "Dhaka",
      candidates: [],
    });
    expect(r.best).toBeNull();
    expect(r.reason).toBe("no enabled couriers");
  });

  it("ranks the preferred courier above an equally-scoring alternative", async () => {
    const m = new Types.ObjectId();
    // Two couriers with IDENTICAL stats (no delivery-time difference).
    await seed(m, { courier: "a", district: "Dhaka", delivered: 50, rto: 0, totalHours: 50 * 24 });
    await seed(m, { courier: "b", district: "Dhaka", delivered: 50, rto: 0, totalHours: 50 * 24 });

    const r = await selectBestCourier({
      merchantId: m,
      district: "Dhaka",
      candidates: ["a", "b"],
      preferredCourier: "b",
    });
    expect(r.best).toBe("b");
  });
});
