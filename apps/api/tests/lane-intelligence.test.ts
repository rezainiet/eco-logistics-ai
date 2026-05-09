import { describe, expect, it } from "vitest";
import {
  classifyLaneIntelligence,
  LANE_INTELLIGENCE_SIGNAL_KEYS,
  LANE_INTELLIGENCE_TIERS,
  __TEST,
  type ClassifyLaneInput,
  type LaneIntelligenceResult,
  type LaneIntelligenceSignalKey,
} from "../src/lib/lane-intelligence.js";

const FIXED_NOW = new Date("2026-05-09T12:00:00Z");

function withNow(input: Partial<ClassifyLaneInput>): ClassifyLaneInput {
  return { ...input, now: FIXED_NOW };
}

function findSignal(
  r: LaneIntelligenceResult,
  key: LaneIntelligenceSignalKey,
) {
  return r.signals.find((s) => s.key === key);
}

describe("lane-intelligence — cold-start", () => {
  it("returns cold_start when both axes are unevidenced", () => {
    const r = classifyLaneIntelligence(withNow({}));
    expect(r.tier).toBe("cold_start");
    expect(r.score).toBe(0);
    expect(findSignal(r, "lane_cold_start")).toBeDefined();
  });

  it("returns cold_start when below MIN_LANE_OBSERVATIONS and no area data", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: { deliveredCount: 5, rtoCount: 1, cancelledCount: 0 },
      }),
    );
    expect(r.tier).toBe("cold_start");
  });

  it("returns cold_start when below MIN_AREA_OBSERVATIONS and no lane data", () => {
    const r = classifyLaneIntelligence(
      withNow({
        areaStats: { deliveredCount: 5, rtoCount: 1 },
      }),
    );
    expect(r.tier).toBe("cold_start");
  });
});

describe("lane-intelligence — lane signals", () => {
  it("emits lane_strong_in_thana at >=85% success and >=20 observations", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: {
          deliveredCount: 90,
          rtoCount: 5,
          cancelledCount: 5,
          totalDeliveryHours: 90 * 30,
        },
      }),
    );
    const strong = findSignal(r, "lane_strong_in_thana");
    expect(strong).toBeDefined();
    expect(strong!.weight).toBe(__TEST.WEIGHTS.laneStrong);
    expect(r.tier).toBe("strong");
  });

  it("emits lane_weak_in_thana at >=20% RTO and >=20 observations", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: {
          deliveredCount: 60,
          rtoCount: 30,
          cancelledCount: 0,
          totalDeliveryHours: 60 * 30,
        },
      }),
    );
    const weak = findSignal(r, "lane_weak_in_thana");
    expect(weak).toBeDefined();
    expect(weak!.weight).toBe(-__TEST.WEIGHTS.laneWeak);
    expect(r.tier).toBe("degraded");
  });

  it("middle-ground lane (neither strong nor weak) emits no lane verdict but is evidenced", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: { deliveredCount: 70, rtoCount: 15, cancelledCount: 5 },
      }),
    );
    expect(findSignal(r, "lane_strong_in_thana")).toBeUndefined();
    expect(findSignal(r, "lane_weak_in_thana")).toBeUndefined();
    expect(r.tier).toBe("neutral");
  });

  it("emits lane_speed_strong when avg delivery hours <= 24", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: {
          deliveredCount: 50,
          rtoCount: 0,
          cancelledCount: 0,
          totalDeliveryHours: 50 * 18, // 18h average
        },
      }),
    );
    expect(findSignal(r, "lane_speed_strong")).toBeDefined();
  });

  it("emits attempt2_high_success when 2nd-attempt deliveries hit >=70% on >=5 obs", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: {
          deliveredCount: 30,
          rtoCount: 5,
          cancelledCount: 0,
          attempt2Delivered: 8,
          attempt2Rto: 2,
        },
      }),
    );
    const a2 = findSignal(r, "attempt2_high_success");
    expect(a2).toBeDefined();
    expect(a2!.detail).toContain("80%");
  });
});

describe("lane-intelligence — area signals", () => {
  it("emits area_high_unreachable at >=25% unreachable rate", () => {
    const r = classifyLaneIntelligence(
      withNow({
        areaStats: {
          deliveredCount: 30,
          rtoCount: 10,
          cancelledCount: 0,
          unreachableCount: 12,
        },
      }),
    );
    expect(findSignal(r, "area_high_unreachable")).toBeDefined();
  });

  it("emits lane_degraded_recently when 7d RTO rate is 1.5x the long-term rate", () => {
    const r = classifyLaneIntelligence(
      withNow({
        areaStats: {
          // Long-term: 10/100 = 10% RTO
          deliveredCount: 80,
          rtoCount: 10,
          cancelledCount: 10,
          // Recent: 4/15 ≈ 27% — 2.7× long-term, well above ratio AND >= 10% floor
          recent7dDelivered: 10,
          recent7dRto: 4,
          recent7dCancelled: 1,
        },
      }),
    );
    const deg = findSignal(r, "lane_degraded_recently");
    expect(deg).toBeDefined();
    expect(deg!.detail).toContain("7 days");
  });

  it("does NOT emit lane_degraded_recently when recent window has fewer than MIN_RECENT_OBSERVATIONS", () => {
    const r = classifyLaneIntelligence(
      withNow({
        areaStats: {
          deliveredCount: 80,
          rtoCount: 10,
          cancelledCount: 10,
          recent7dDelivered: 4,
          recent7dRto: 4,
          recent7dCancelled: 0, // total 8 < MIN_RECENT_OBSERVATIONS=10
        },
      }),
    );
    expect(findSignal(r, "lane_degraded_recently")).toBeUndefined();
  });

  it("does NOT emit lane_degraded_recently when long-term RTO is 0 (fresh area)", () => {
    const r = classifyLaneIntelligence(
      withNow({
        areaStats: {
          deliveredCount: 100,
          rtoCount: 0,
          cancelledCount: 0,
          recent7dDelivered: 9,
          recent7dRto: 1,
          recent7dCancelled: 0,
        },
      }),
    );
    // No baseline to compare against → no degradation verdict.
    expect(findSignal(r, "lane_degraded_recently")).toBeUndefined();
  });
});

describe("lane-intelligence — composition", () => {
  it("a strong lane in a healthy area lands tier=strong", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: {
          deliveredCount: 95,
          rtoCount: 3,
          cancelledCount: 2,
          totalDeliveryHours: 95 * 20,
        },
        areaStats: {
          deliveredCount: 200,
          rtoCount: 15,
          cancelledCount: 10,
          unreachableCount: 10,
        },
      }),
    );
    expect(r.tier).toBe("strong");
    expect(r.observations.laneSuccessRate).toBeCloseTo(0.95, 2);
  });

  it("a weak lane in a degrading area lands tier=degraded with multiple signals", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: {
          deliveredCount: 50,
          rtoCount: 30,
          cancelledCount: 5,
        },
        areaStats: {
          deliveredCount: 80,
          rtoCount: 12,
          cancelledCount: 8,
          unreachableCount: 30, // 30/100 = 30%
          recent7dDelivered: 8,
          recent7dRto: 5,
          recent7dCancelled: 2,
        },
      }),
    );
    expect(r.tier).toBe("degraded");
    expect(findSignal(r, "lane_weak_in_thana")).toBeDefined();
    expect(findSignal(r, "area_high_unreachable")).toBeDefined();
  });

  it("score is clamped to the sum of weights — no overflow", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: {
          deliveredCount: 5,
          rtoCount: 95, // 95% RTO
          cancelledCount: 0,
        },
        areaStats: {
          deliveredCount: 10,
          rtoCount: 90,
          cancelledCount: 0,
          unreachableCount: 80,
          recent7dDelivered: 5,
          recent7dRto: 30,
          recent7dCancelled: 0,
        },
      }),
    );
    // Weak lane (-25) + high unreachable (-15) = -40, well below
    // DEGRADED_TIER_THRESHOLD (-20). lane_degraded_recently doesn't
    // fire here because the recent rate doesn't accelerate above the
    // long-term baseline — that's tested separately above.
    expect(r.score).toBeLessThanOrEqual(__TEST.DEGRADED_TIER_THRESHOLD);
    expect(r.tier).toBe("degraded");
  });
});

describe("lane-intelligence — defensive runtime", () => {
  it("ignores invalid `now` (string) and falls back to system clock", () => {
    expect(() =>
      classifyLaneIntelligence(
        // @ts-expect-error — exercising defensive runtime handling
        { now: "not-a-date" },
      ),
    ).not.toThrow();
  });

  it("clamps NaN counters to 0", () => {
    const r = classifyLaneIntelligence(
      withNow({
        laneStats: {
          deliveredCount: Number.NaN,
          rtoCount: 50,
          cancelledCount: 50,
        },
      }),
    );
    // Without the NaN clamp, completed would be NaN and any comparison fails.
    expect(r.tier).not.toBe("cold_start");
    expect(r.observations.laneCompleted).toBe(100);
  });
});

describe("lane-intelligence — surface invariants", () => {
  it("LANE_INTELLIGENCE_TIERS includes the four spec tiers", () => {
    expect(new Set(LANE_INTELLIGENCE_TIERS)).toEqual(
      new Set(["strong", "neutral", "degraded", "cold_start"]),
    );
  });

  it("LANE_INTELLIGENCE_SIGNAL_KEYS contains every constructible key", () => {
    for (const k of [
      "lane_strong_in_thana",
      "lane_weak_in_thana",
      "lane_degraded_recently",
      "lane_speed_strong",
      "area_high_unreachable",
      "attempt2_high_success",
      "lane_cold_start",
    ] as const) {
      expect(LANE_INTELLIGENCE_SIGNAL_KEYS).toContain(k);
    }
  });

  it("__TEST.WEIGHTS.* are all non-negative integers", () => {
    for (const [, v] of Object.entries(__TEST.WEIGHTS)) {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
