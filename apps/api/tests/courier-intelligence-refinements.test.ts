import { describe, expect, it } from "vitest";
import { __TEST as DISTRICT_TEST, normalizeDistrict, DISTRICT_GLOBAL } from "../src/lib/district.js";
import {
  __TEST as INTEL_TEST,
  scoreCourierCandidate,
} from "../src/lib/courier-intelligence.js";

describe("normalizeDistrict", () => {
  it("returns _GLOBAL_ for empty/whitespace input", () => {
    expect(normalizeDistrict(undefined)).toBe(DISTRICT_GLOBAL);
    expect(normalizeDistrict(null)).toBe(DISTRICT_GLOBAL);
    expect(normalizeDistrict("")).toBe(DISTRICT_GLOBAL);
    expect(normalizeDistrict("   ")).toBe(DISTRICT_GLOBAL);
  });

  it("canonicalises common case + whitespace variants", () => {
    expect(normalizeDistrict("Dhaka")).toBe("dhaka");
    expect(normalizeDistrict("  DHAKA  ")).toBe("dhaka");
    expect(normalizeDistrict("dhaka  city")).toBe("dhaka");
  });

  it("maps spelling variants and Bangla to a single key", () => {
    expect(normalizeDistrict("Chittagong")).toBe("chittagong");
    expect(normalizeDistrict("Chattogram")).toBe("chittagong");
    expect(normalizeDistrict("CTG")).toBe("chittagong");
    expect(normalizeDistrict("চট্টগ্রাম")).toBe("chittagong");
    expect(normalizeDistrict("Comilla")).toBe("comilla");
    expect(normalizeDistrict("Cumilla")).toBe("comilla");
    expect(normalizeDistrict("Barishal")).toBe("barisal");
  });

  it("strips trailing 'City' / 'District' / 'Division' qualifiers", () => {
    expect(normalizeDistrict("Sylhet District")).toBe("sylhet");
    expect(normalizeDistrict("Khulna Division")).toBe("khulna");
    expect(normalizeDistrict("Dhaka City")).toBe("dhaka");
  });

  it("falls through to trim+lowercase for unknown districts (still consistent)", () => {
    expect(normalizeDistrict("Faridpur")).toBe("faridpur");
    expect(normalizeDistrict("  FARIDPUR  ")).toBe("faridpur");
  });

  it("aliases dictionary covers the BD divisions", () => {
    const expected = ["dhaka", "chittagong", "sylhet", "khulna", "rajshahi", "barisal", "rangpur", "mymensingh"];
    for (const d of expected) {
      expect(Object.values(DISTRICT_TEST.ALIASES)).toContain(d);
    }
  });
});

describe("scoreCourierCandidate — staleness + failure penalty", () => {
  const { STALE_OUTCOME_DAYS, FAILURE_PENALTY_PER_HIT, FAILURE_PENALTY_CAP, NEUTRAL_SCORE } = INTEL_TEST;
  const baseStats = {
    courier: "x",
    district: "dhaka",
    deliveredCount: 80,
    rtoCount: 5,
    cancelledCount: 5,
    totalDeliveryHours: 80 * 20,
  };

  it("treats rows older than STALE_OUTCOME_DAYS as cold-start", () => {
    const longAgo = new Date(Date.now() - (STALE_OUTCOME_DAYS + 5) * 86_400_000);
    const r = scoreCourierCandidate({ ...baseStats, lastOutcomeAt: longAgo });
    expect(r.breakdown.stale).toBe(true);
    expect(r.breakdown.coldStart).toBe(true);
    expect(r.score).toBe(NEUTRAL_SCORE);
  });

  it("uses fresh evidence when lastOutcomeAt is recent", () => {
    const recent = new Date(Date.now() - 30 * 86_400_000);
    const r = scoreCourierCandidate({ ...baseStats, lastOutcomeAt: recent });
    expect(r.breakdown.stale).toBe(false);
    expect(r.breakdown.coldStart).toBe(false);
    expect(r.score).toBeGreaterThan(50);
  });

  it("applies a failure penalty proportional to recentFailures (capped)", () => {
    const recent = new Date(Date.now() - 30 * 86_400_000);
    const noFail = scoreCourierCandidate({ ...baseStats, lastOutcomeAt: recent, recentFailures: 0, recentFailureWindowAt: new Date() });
    const oneFail = scoreCourierCandidate({ ...baseStats, lastOutcomeAt: recent, recentFailures: 1, recentFailureWindowAt: new Date() });
    const sevenFail = scoreCourierCandidate({ ...baseStats, lastOutcomeAt: recent, recentFailures: 7, recentFailureWindowAt: new Date() });

    expect(noFail.breakdown.failurePenalty).toBe(0);
    expect(oneFail.breakdown.failurePenalty).toBe(FAILURE_PENALTY_PER_HIT);
    expect(sevenFail.breakdown.failurePenalty).toBe(FAILURE_PENALTY_CAP);

    expect(oneFail.score).toBeLessThan(noFail.score);
    expect(sevenFail.score).toBeLessThan(oneFail.score);
  });

  it("ignores expired failure windows (decay)", () => {
    const recent = new Date(Date.now() - 30 * 86_400_000);
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago, > 1h window
    const r = scoreCourierCandidate({
      ...baseStats,
      lastOutcomeAt: recent,
      recentFailures: 5,
      recentFailureWindowAt: stale,
    });
    expect(r.breakdown.failurePenalty).toBe(0);
  });

  it("applies failure penalty even on cold-start rows", () => {
    const r = scoreCourierCandidate({
      ...baseStats,
      deliveredCount: 0, rtoCount: 0, cancelledCount: 0,
      recentFailures: 3,
      recentFailureWindowAt: new Date(),
    });
    expect(r.breakdown.coldStart).toBe(true);
    expect(r.breakdown.failurePenalty).toBe(3 * FAILURE_PENALTY_PER_HIT);
    expect(r.score).toBeLessThan(NEUTRAL_SCORE);
  });

  it("score never goes negative even with max-out failure penalty + 100% RTO", () => {
    const recent = new Date(Date.now() - 30 * 86_400_000);
    const r = scoreCourierCandidate({
      courier: "x",
      district: "dhaka",
      deliveredCount: 0,
      rtoCount: 100,
      cancelledCount: 0,
      totalDeliveryHours: 0,
      lastOutcomeAt: recent,
      recentFailures: 100,
      recentFailureWindowAt: new Date(),
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});
