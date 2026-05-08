import { describe, it, expect } from "vitest";
import {
  classifyDeliveryReliability,
  DELIVERY_RELIABILITY_SIGNAL_KEYS,
  DELIVERY_RELIABILITY_TIERS,
  __TEST,
  type ClassifyDeliveryReliabilityInput,
  type DeliveryReliabilitySignalKey,
} from "../src/lib/delivery-reliability.js";

/**
 * delivery-reliability classifier — pure-function tests.
 *
 * Six groups (mirroring the engineering execution map §5.1):
 *   A. no-data semantics
 *   B. tier thresholds
 *   C. signal precedence + composition
 *   D. staleness
 *   E. degenerate input
 *   F. purity
 *
 * MUST be runnable without `mongodb-memory-server`. No DB, no env, no clock
 * except via the injectable `now`.
 */

const NOW = new Date("2026-05-08T12:00:00Z");

function withNow<T extends ClassifyDeliveryReliabilityInput>(input: T): T {
  return { now: NOW, ...input };
}

function recentDate(daysAgo: number): Date {
  return new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
}

function findSignal(
  result: ReturnType<typeof classifyDeliveryReliability>,
  key: DeliveryReliabilitySignalKey,
) {
  return result.signals.find((s) => s.key === key);
}

/* ========================================================================== */
/* GROUP A — no-data semantics                                                */
/* ========================================================================== */

describe("classifyDeliveryReliability — no-data semantics", () => {
  it("returns tier=no_data when all three primary stats are absent", () => {
    const r = classifyDeliveryReliability(withNow({}));
    expect(r.tier).toBe("no_data");
    expect(r.score).toBe(0);
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]?.key).toBe("no_history_data");
    expect(r.signals[0]?.weight).toBe(0);
    expect(r.samplesConsidered).toEqual({ customer: 0, address: 0, courier: 0 });
    expect(r.computedAt).toEqual(NOW);
  });

  it("returns tier=no_data when every axis has fewer than MIN_OBSERVATIONS_FOR_SIGNAL", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: { deliveredCount: 1, rtoCount: 0, cancelledCount: 1 },
        addressStats: { deliveredCount: 0, rtoCount: 1, cancelledCount: 0 },
        courierStats: { observations: 2, successRate: 1, rtoRate: 0 },
      }),
    );
    expect(r.tier).toBe("no_data");
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]?.key).toBe("no_history_data");
    expect(r.samplesConsidered).toEqual({ customer: 0, address: 0, courier: 0 });
  });

  it("does NOT return no_data when only customerStats has ≥3 evidenced observations", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(10),
        },
      }),
    );
    expect(r.tier).not.toBe("no_data");
    expect(r.samplesConsidered.customer).toBe(5);
    expect(r.samplesConsidered.address).toBe(0);
    expect(r.samplesConsidered.courier).toBe(0);
  });

  it("returns no_data when only networkAggregate is present (network is non-load-bearing)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        networkAggregate: { merchantCount: 5, rtoRate: 0.7 },
      }),
    );
    expect(r.tier).toBe("no_data");
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]?.key).toBe("no_history_data");
  });

  it("returns no_data when only addressQuality is present", () => {
    const r = classifyDeliveryReliability(
      withNow({ addressQuality: { completeness: "incomplete" } }),
    );
    expect(r.tier).toBe("no_data");
  });
});

/* ========================================================================== */
/* GROUP B — tier thresholds (via __TEST.classifyTier and end-to-end)         */
/* ========================================================================== */

describe("classifyDeliveryReliability — tier thresholds", () => {
  it("classifyTier(0) === unverified", () => {
    expect(__TEST.classifyTier(0)).toBe("unverified");
  });

  it("classifyTier(39) === unverified (just below implicit threshold)", () => {
    expect(__TEST.classifyTier(39)).toBe("unverified");
  });

  it("classifyTier(40) === implicit (threshold inclusive)", () => {
    expect(__TEST.classifyTier(40)).toBe("implicit");
  });

  it("classifyTier(69) === implicit (just below verified threshold)", () => {
    expect(__TEST.classifyTier(69)).toBe("implicit");
  });

  it("classifyTier(70) === verified (threshold inclusive)", () => {
    expect(__TEST.classifyTier(70)).toBe("verified");
  });

  it("classifyTier(100) === verified", () => {
    expect(__TEST.classifyTier(100)).toBe("verified");
  });

  it("classifyTier(-10) === unverified (defensive)", () => {
    expect(__TEST.classifyTier(-10)).toBe("unverified");
  });

  it("classifyTier(NaN) === unverified (defensive)", () => {
    expect(__TEST.classifyTier(Number.NaN)).toBe("unverified");
  });

  it("classifyTier(Infinity) does NOT collapse to verified silently", () => {
    // Infinity is not a finite score; the classifier must not treat it as
    // "very verified". The defensive check returns unverified.
    expect(__TEST.classifyTier(Number.POSITIVE_INFINITY)).toBe("unverified");
  });
});

/* ========================================================================== */
/* GROUP C — signal precedence + composition                                  */
/* ========================================================================== */

describe("classifyDeliveryReliability — signal composition", () => {
  it("verified path: rich customer history + strong courier lane lands at score ≥70", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 10,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(7),
        },
        courierStats: {
          successRate: 0.92,
          rtoRate: 0.05,
          observations: 100,
          coldStart: false,
          stale: false,
          matchedOn: "district",
        },
      }),
    );
    expect(r.tier).toBe("verified");
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(findSignal(r, "customer_repeat_success")).toBeDefined();
    expect(findSignal(r, "courier_lane_strong")).toBeDefined();
  });

  it("address_repeat_rto with otherwise sparse data lands as unverified-leaning", () => {
    const r = classifyDeliveryReliability(
      withNow({
        addressStats: {
          deliveredCount: 1,
          rtoCount: 2,
          cancelledCount: 0,
          distinctPhoneCount: 1,
          lastOutcomeAt: recentDate(15),
        },
      }),
    );
    expect(findSignal(r, "address_repeat_rto")).toBeDefined();
    // 50 + 0 (no clean) - 10 (2 RTOs * 5) = 40 (implicit boundary)
    // So tier should be implicit; document the actual outcome rather than
    // overconstrain the formula.
    expect(["implicit", "unverified"]).toContain(r.tier);
    expect(r.score).toBeLessThanOrEqual(50);
  });

  it("low_success_rate + strong courier lane → mixed (implicit or unverified)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 1,
          rtoCount: 4,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(10),
        },
        courierStats: {
          successRate: 0.92,
          rtoRate: 0.05,
          observations: 100,
          coldStart: false,
          stale: false,
          matchedOn: "district",
        },
      }),
    );
    expect(findSignal(r, "customer_low_success_rate")).toBeDefined();
    expect(findSignal(r, "courier_lane_strong")).toBeDefined();
    expect(r.tier).not.toBe("verified");
    expect(r.tier).not.toBe("no_data");
  });

  it("all positive signals → score caps at 100 (verified)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 20,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(2),
        },
        addressStats: {
          deliveredCount: 8,
          rtoCount: 0,
          cancelledCount: 0,
          distinctPhoneCount: 1,
          lastOutcomeAt: recentDate(2),
        },
        courierStats: {
          successRate: 0.97,
          rtoRate: 0.01,
          observations: 200,
          coldStart: false,
          stale: false,
          matchedOn: "district",
        },
        addressQuality: { completeness: "complete" },
      }),
    );
    expect(r.score).toBe(100);
    expect(r.tier).toBe("verified");
    expect(findSignal(r, "customer_repeat_success")?.weight).toBeGreaterThan(0);
    expect(findSignal(r, "address_clean_history")?.weight).toBeGreaterThan(0);
    expect(findSignal(r, "courier_lane_strong")?.weight).toBeGreaterThan(0);
  });

  it("all negative signals → score floors at 0 (unverified)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 0,
          rtoCount: 5,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(5),
        },
        addressStats: {
          deliveredCount: 0,
          rtoCount: 5,
          cancelledCount: 0,
          distinctPhoneCount: 4,
          lastOutcomeAt: recentDate(5),
        },
        courierStats: {
          successRate: 0.4,
          rtoRate: 0.5,
          observations: 100,
          coldStart: false,
          stale: false,
          matchedOn: "district",
        },
        networkAggregate: { merchantCount: 3, rtoRate: 0.7 },
        addressQuality: { completeness: "incomplete" },
      }),
    );
    expect(r.score).toBe(0);
    expect(r.tier).toBe("unverified");
    expect(findSignal(r, "customer_repeat_rto")).toBeDefined();
    expect(findSignal(r, "customer_low_success_rate")).toBeDefined();
    expect(findSignal(r, "address_repeat_rto")).toBeDefined();
    expect(findSignal(r, "address_multi_buyer")).toBeDefined();
    expect(findSignal(r, "courier_lane_weak")).toBeDefined();
    expect(findSignal(r, "network_warning")).toBeDefined();
    expect(findSignal(r, "address_quality_warning")).toBeDefined();
  });

  it("middle-ground courier (≥30 obs, neither strong nor weak) emits no courier signal but counts as evidenced", () => {
    const r = classifyDeliveryReliability(
      withNow({
        courierStats: {
          successRate: 0.7,
          rtoRate: 0.15,
          observations: 50,
          coldStart: false,
          stale: false,
          matchedOn: "district",
        },
      }),
    );
    expect(r.tier).not.toBe("no_data");
    expect(findSignal(r, "courier_lane_strong")).toBeUndefined();
    expect(findSignal(r, "courier_lane_weak")).toBeUndefined();
    expect(findSignal(r, "courier_lane_unknown")).toBeUndefined();
    expect(r.samplesConsidered.courier).toBe(50);
  });

  it("signal detail strings render specific values verbatim", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 4,
          rtoCount: 1,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(3),
        },
      }),
    );
    const success = findSignal(r, "customer_repeat_success");
    expect(success?.detail).toContain("4 of 5");
    expect(success?.detail).toContain("80%");
    const rto = findSignal(r, "customer_repeat_rto");
    expect(rto?.detail).toContain("1 prior return");
    // singular/plural — exactly one return is "1 prior return", not "1 prior returns"
    expect(rto?.detail).not.toContain("returns");
  });

  it("score equals BASELINE plus the sum of signal weights (within clamp)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 4,
          rtoCount: 1,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(3),
        },
      }),
    );
    const sum = r.signals.reduce((acc, s) => acc + s.weight, 0);
    const expectedScore = Math.max(0, Math.min(100, __TEST.BASELINE_SCORE + sum));
    expect(r.score).toBe(expectedScore);
  });

  it("network_warning fires only when rtoRate≥0.5 AND merchantCount≥2", () => {
    // Near-trigger: rate 0.49 should NOT fire.
    const r1 = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(5),
        },
        networkAggregate: { merchantCount: 5, rtoRate: 0.49 },
      }),
    );
    expect(findSignal(r1, "network_warning")).toBeUndefined();

    // Trigger: rate exactly 0.5, merchantCount 2.
    const r2 = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(5),
        },
        networkAggregate: { merchantCount: 2, rtoRate: 0.5 },
      }),
    );
    expect(findSignal(r2, "network_warning")).toBeDefined();
  });

  it("address_quality_warning fires only when completeness === 'incomplete'", () => {
    const buildInput = (
      completeness: "complete" | "partial" | "incomplete",
    ): ClassifyDeliveryReliabilityInput =>
      withNow({
        customerStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(5),
        },
        addressQuality: { completeness },
      });
    expect(
      findSignal(classifyDeliveryReliability(buildInput("complete")), "address_quality_warning"),
    ).toBeUndefined();
    expect(
      findSignal(classifyDeliveryReliability(buildInput("partial")), "address_quality_warning"),
    ).toBeUndefined();
    expect(
      findSignal(
        classifyDeliveryReliability(buildInput("incomplete")),
        "address_quality_warning",
      ),
    ).toBeDefined();
  });

  it("every emitted signal key is on the public stable list", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 4,
          rtoCount: 1,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(5),
        },
        addressStats: {
          deliveredCount: 0,
          rtoCount: 2,
          cancelledCount: 1,
          distinctPhoneCount: 4,
          lastOutcomeAt: recentDate(5),
        },
        courierStats: {
          successRate: 0.92,
          rtoRate: 0.05,
          observations: 100,
          coldStart: false,
          stale: false,
          matchedOn: "district",
        },
        networkAggregate: { merchantCount: 3, rtoRate: 0.6 },
        addressQuality: { completeness: "incomplete" },
      }),
    );
    for (const s of r.signals) {
      expect(DELIVERY_RELIABILITY_SIGNAL_KEYS).toContain(s.key);
    }
  });
});

/* ========================================================================== */
/* GROUP D — staleness                                                        */
/* ========================================================================== */

describe("classifyDeliveryReliability — staleness", () => {
  it("customerStats with lastOutcomeAt 200d ago is treated as cold-start (no signals fire)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 10,
          rtoCount: 1,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(200),
        },
      }),
    );
    // Customer signals must not fire.
    expect(findSignal(r, "customer_repeat_success")).toBeUndefined();
    expect(findSignal(r, "customer_repeat_rto")).toBeUndefined();
    expect(findSignal(r, "customer_low_success_rate")).toBeUndefined();
    // Without other axes, axis is not evidenced → no_data.
    expect(r.tier).toBe("no_data");
  });

  it("addressStats with lastOutcomeAt 200d ago is treated as cold-start", () => {
    const r = classifyDeliveryReliability(
      withNow({
        addressStats: {
          deliveredCount: 5,
          rtoCount: 1,
          cancelledCount: 0,
          distinctPhoneCount: 5,
          lastOutcomeAt: recentDate(200),
        },
      }),
    );
    expect(findSignal(r, "address_clean_history")).toBeUndefined();
    expect(findSignal(r, "address_repeat_rto")).toBeUndefined();
    expect(findSignal(r, "address_multi_buyer")).toBeUndefined();
    expect(r.tier).toBe("no_data");
  });

  it("courierStats with stale=true emits courier_lane_unknown (NOT strong/weak)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        courierStats: {
          successRate: 0.95,
          rtoRate: 0.02,
          observations: 100,
          coldStart: false,
          stale: true,
          matchedOn: "district",
        },
      }),
    );
    expect(findSignal(r, "courier_lane_unknown")).toBeDefined();
    expect(findSignal(r, "courier_lane_strong")).toBeUndefined();
    expect(findSignal(r, "courier_lane_weak")).toBeUndefined();
  });

  it("courierStats.coldStart=true emits courier_lane_unknown regardless of obs/rates", () => {
    const r = classifyDeliveryReliability(
      withNow({
        courierStats: {
          successRate: 0.92,
          rtoRate: 0.04,
          observations: 8,
          coldStart: true,
          stale: false,
          matchedOn: "global",
        },
      }),
    );
    expect(findSignal(r, "courier_lane_unknown")).toBeDefined();
    expect(findSignal(r, "courier_lane_strong")).toBeUndefined();
  });

  it("mixed stale-customer + fresh-courier uses only the courier signal", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 10,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(200), // stale
        },
        courierStats: {
          successRate: 0.92,
          rtoRate: 0.04,
          observations: 80,
          coldStart: false,
          stale: false,
          matchedOn: "district",
        },
      }),
    );
    expect(findSignal(r, "customer_repeat_success")).toBeUndefined();
    expect(findSignal(r, "courier_lane_strong")).toBeDefined();
    expect(r.tier).not.toBe("no_data");
  });

  it("freshness boundary: lastOutcomeAt exactly STALE_DAYS-1 ago is NOT stale", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(__TEST.STALE_DAYS - 1),
        },
      }),
    );
    expect(findSignal(r, "customer_repeat_success")).toBeDefined();
  });

  it("freshness boundary: lastOutcomeAt exactly STALE_DAYS+1 ago IS stale", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(__TEST.STALE_DAYS + 1),
        },
      }),
    );
    expect(findSignal(r, "customer_repeat_success")).toBeUndefined();
    expect(r.tier).toBe("no_data");
  });
});

/* ========================================================================== */
/* GROUP E — degenerate input                                                 */
/* ========================================================================== */

describe("classifyDeliveryReliability — degenerate input", () => {
  it("returns no_data without throwing when input is undefined", () => {
    expect(() => classifyDeliveryReliability(undefined)).not.toThrow();
    expect(classifyDeliveryReliability(undefined).tier).toBe("no_data");
  });

  it("returns no_data without throwing when input is null", () => {
    expect(() => classifyDeliveryReliability(null)).not.toThrow();
    expect(classifyDeliveryReliability(null).tier).toBe("no_data");
  });

  it("does not throw when optional fields are explicit null", () => {
    expect(() =>
      classifyDeliveryReliability(
        withNow({
          customerStats: null,
          addressStats: null,
          courierStats: null,
          thana: null,
          addressQuality: null,
          networkAggregate: null,
        }),
      ),
    ).not.toThrow();
  });

  it("clamps negative counts defensively to 0", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: -50,
          rtoCount: -10,
          cancelledCount: -3,
          lastOutcomeAt: recentDate(5),
        },
      }),
    );
    // Total samples = 0 → not evidenced → no_data.
    expect(r.tier).toBe("no_data");
    expect(r.samplesConsidered.customer).toBe(0);
  });

  it("clamps NaN counts defensively to 0", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: Number.NaN,
          rtoCount: Number.NaN,
          cancelledCount: 5,
          lastOutcomeAt: recentDate(5),
        },
      }),
    );
    // Only the cancelled count survives; rest go to 0 — samples = 5 (≥3).
    expect(r.tier).not.toBe("no_data");
    expect(r.samplesConsidered.customer).toBe(5);
  });

  it("clamps successRate / rtoRate to [0,1]", () => {
    expect(__TEST.safeRate(-0.5)).toBe(0);
    expect(__TEST.safeRate(1.5)).toBe(1);
    expect(__TEST.safeRate(Number.NaN)).toBe(0);
    expect(__TEST.safeRate(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("treats absurdly large distinctPhoneCount sanely (no overflow)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        addressStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          distinctPhoneCount: 1_000_000,
          lastOutcomeAt: recentDate(5),
        },
      }),
    );
    const multi = findSignal(r, "address_multi_buyer");
    expect(multi).toBeDefined();
    expect(multi?.weight).toBe(-__TEST.WEIGHTS.addressMultiBuyer);
    expect(multi?.detail).toContain("1000000");
  });

  it("ignores invalid lastOutcomeAt (string instead of Date) without throwing", () => {
    const r = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          // @ts-expect-error — exercising defensive runtime handling
          lastOutcomeAt: "not-a-date",
        },
      }),
    );
    // String is not a Date → isStaleAxis returns false → signals fire normally.
    expect(findSignal(r, "customer_repeat_success")).toBeDefined();
  });

  it("ignores invalid `now` (string) and falls back to system clock without throwing", () => {
    expect(() =>
      classifyDeliveryReliability(
        // @ts-expect-error — exercising defensive runtime handling
        { now: "not-a-date" },
      ),
    ).not.toThrow();
    // @ts-expect-error
    const r = classifyDeliveryReliability({ now: "not-a-date" });
    expect(r.tier).toBe("no_data");
    expect(r.computedAt).toBeInstanceOf(Date);
  });

  it("courierStats with negative observations clamps to 0 (axis not evidenced)", () => {
    const r = classifyDeliveryReliability(
      withNow({
        courierStats: { observations: -100, successRate: 1, rtoRate: 0 },
      }),
    );
    expect(r.tier).toBe("no_data");
    expect(r.samplesConsidered.courier).toBe(0);
  });
});

/* ========================================================================== */
/* GROUP F — purity                                                           */
/* ========================================================================== */

describe("classifyDeliveryReliability — purity", () => {
  const STABLE_INPUT: ClassifyDeliveryReliabilityInput = {
    now: NOW,
    customerStats: {
      deliveredCount: 5,
      rtoCount: 1,
      cancelledCount: 0,
      lastOutcomeAt: recentDate(5),
    },
    addressStats: {
      deliveredCount: 3,
      rtoCount: 0,
      cancelledCount: 0,
      distinctPhoneCount: 1,
      lastOutcomeAt: recentDate(5),
    },
    courierStats: {
      successRate: 0.9,
      rtoRate: 0.05,
      observations: 60,
      coldStart: false,
      stale: false,
      matchedOn: "district",
    },
    networkAggregate: { merchantCount: 1, rtoRate: 0.1 },
    addressQuality: { completeness: "complete" },
    thana: "Mirpur",
  };

  it("same inputs → same outputs (deterministic)", () => {
    const r1 = classifyDeliveryReliability(STABLE_INPUT);
    const r2 = classifyDeliveryReliability(STABLE_INPUT);
    // Drop computedAt (Date instance differs by reference) — compare every
    // other field deeply.
    const { computedAt: a, ...rest1 } = r1;
    const { computedAt: b, ...rest2 } = r2;
    expect(rest1).toEqual(rest2);
    expect(a.getTime()).toBe(b.getTime());
  });

  it("does not mutate the input object (frozen input runs cleanly)", () => {
    const frozen = Object.freeze({
      ...STABLE_INPUT,
      customerStats: Object.freeze({ ...STABLE_INPUT.customerStats }),
      addressStats: Object.freeze({ ...STABLE_INPUT.addressStats }),
      courierStats: Object.freeze({ ...STABLE_INPUT.courierStats }),
      addressQuality: Object.freeze({ ...STABLE_INPUT.addressQuality }),
      networkAggregate: Object.freeze({ ...STABLE_INPUT.networkAggregate }),
    });
    expect(() => classifyDeliveryReliability(frozen)).not.toThrow();

    // Snapshot before, run, snapshot after — bytes should match.
    const before = JSON.stringify(STABLE_INPUT);
    classifyDeliveryReliability(STABLE_INPUT);
    const after = JSON.stringify(STABLE_INPUT);
    expect(after).toBe(before);
  });

  it("multiple calls do not share state", () => {
    const r1 = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 5,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(5),
        },
      }),
    );
    const r2 = classifyDeliveryReliability(
      withNow({
        customerStats: {
          deliveredCount: 0,
          rtoCount: 5,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(5),
        },
      }),
    );
    // Ensure neither result leaked into the other.
    expect(r1.signals.find((s) => s.key === "customer_repeat_success")).toBeDefined();
    expect(r2.signals.find((s) => s.key === "customer_repeat_success")).toBeUndefined();
  });

  it("never throws for a sweep of plausible inputs", () => {
    const inputs: Array<ClassifyDeliveryReliabilityInput | null | undefined> = [
      undefined,
      null,
      {},
      { now: NOW },
      withNow({ customerStats: {} }),
      withNow({ addressStats: {} }),
      withNow({ courierStats: {} }),
      withNow({ networkAggregate: {} }),
      withNow({ addressQuality: {} }),
      withNow({
        customerStats: {
          deliveredCount: 0,
          rtoCount: 0,
          cancelledCount: 0,
          lastOutcomeAt: recentDate(0),
        },
      }),
    ];
    for (const i of inputs) {
      expect(() => classifyDeliveryReliability(i)).not.toThrow();
    }
  });
});

/* ========================================================================== */
/* Sanity invariants                                                          */
/* ========================================================================== */

describe("classifyDeliveryReliability — module surface invariants", () => {
  it("DELIVERY_RELIABILITY_TIERS includes the four spec tiers", () => {
    expect(new Set(DELIVERY_RELIABILITY_TIERS)).toEqual(
      new Set(["verified", "implicit", "unverified", "no_data"]),
    );
  });

  it("DELIVERY_RELIABILITY_SIGNAL_KEYS contains every constructible signal key", () => {
    // Sanity: the no_history_data sentinel and every primary/secondary key.
    for (const k of [
      "no_history_data",
      "customer_repeat_success",
      "customer_repeat_rto",
      "customer_low_success_rate",
      "address_clean_history",
      "address_repeat_rto",
      "address_multi_buyer",
      "courier_lane_strong",
      "courier_lane_weak",
      "courier_lane_unknown",
      "network_warning",
      "address_quality_warning",
    ] as const) {
      expect(DELIVERY_RELIABILITY_SIGNAL_KEYS).toContain(k);
    }
  });

  it("__TEST.WEIGHTS.* are all non-negative integers (sign is applied at emit-time)", () => {
    for (const [k, v] of Object.entries(__TEST.WEIGHTS)) {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(v)).toBe(true);
      void k;
    }
  });
});
