import { describe, expect, it } from "vitest";
import {
  __TEST,
  checkAddressReliabilityIntegrity,
  checkAggregateMismatch,
  checkCustomerReliabilityIntegrity,
  checkReplayAnomaly,
  DISTINCT_PHONE_HASHES_CAP,
  COUNTER_JUMP_THRESHOLD,
} from "../src/lib/delivery-reliability-integrity.js";

/**
 * Pure unit tests for the integrity / drift helpers. NO database — these
 * functions are compute-only.
 *
 * Coverage:
 *   - impossible counters (negative / non-finite)
 *   - all-zero-with-timestamps (corruption signature)
 *   - monotonic timestamp violations
 *   - bounded-set violations on distinctPhoneHashes
 *   - replay-anomaly counter jumps
 *   - aggregate-vs-source mismatch with tolerance
 */

const NOW = new Date("2026-05-08T12:00:00Z");

/* ========================================================================== */
/* CustomerReliability — impossible counters                                 */
/* ========================================================================== */

describe("checkCustomerReliabilityIntegrity — impossible counters", () => {
  it("clean row → ok", () => {
    const r = checkCustomerReliabilityIntegrity(
      {
        deliveredCount: 5,
        rtoCount: 0,
        cancelledCount: 0,
        firstOutcomeAt: new Date(NOW.getTime() - 100_000),
        lastOutcomeAt: NOW,
      },
      { now: NOW },
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("flags negative deliveredCount", () => {
    const r = checkCustomerReliabilityIntegrity(
      { deliveredCount: -1, rtoCount: 0, cancelledCount: 0 },
      { now: NOW },
    );
    expect(r.ok).toBe(false);
    expect(r.violations.find((v) => v.code === "negative_counter")).toBeDefined();
  });

  it("flags NaN counters", () => {
    const r = checkCustomerReliabilityIntegrity(
      { deliveredCount: Number.NaN, rtoCount: 1, cancelledCount: 0 },
      { now: NOW },
    );
    expect(r.violations.find((v) => v.code === "non_finite_counter")).toBeDefined();
  });

  it("flags Infinity counters", () => {
    const r = checkCustomerReliabilityIntegrity(
      { deliveredCount: Number.POSITIVE_INFINITY, rtoCount: 0, cancelledCount: 0 },
      { now: NOW },
    );
    expect(r.violations.find((v) => v.code === "non_finite_counter")).toBeDefined();
  });

  it("does NOT flag absent counters (legacy/incomplete rows are fine)", () => {
    const r = checkCustomerReliabilityIntegrity({}, { now: NOW });
    expect(r.ok).toBe(true);
  });

  it("does NOT flag zero counters when timestamps absent (insert race)", () => {
    const r = checkCustomerReliabilityIntegrity(
      { deliveredCount: 0, rtoCount: 0, cancelledCount: 0 },
      { now: NOW },
    );
    expect(r.ok).toBe(true);
  });

  it("flags all-zero counters WITH a populated lastOutcomeAt (likely corruption)", () => {
    const r = checkCustomerReliabilityIntegrity(
      {
        deliveredCount: 0,
        rtoCount: 0,
        cancelledCount: 0,
        lastOutcomeAt: NOW,
      },
      { now: NOW },
    );
    expect(r.violations.find((v) => v.code === "all_zero_with_timestamps")).toBeDefined();
  });
});

/* ========================================================================== */
/* CustomerReliability — monotonic timestamps                                */
/* ========================================================================== */

describe("checkCustomerReliabilityIntegrity — monotonic timestamps", () => {
  it("flags lastOutcomeAt before firstOutcomeAt", () => {
    const r = checkCustomerReliabilityIntegrity(
      {
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        firstOutcomeAt: new Date("2026-05-08T12:00:00Z"),
        lastOutcomeAt: new Date("2026-05-01T00:00:00Z"),
      },
      { now: NOW },
    );
    expect(r.violations.find((v) => v.code === "lastOutcomeAt_before_firstOutcomeAt")).toBeDefined();
  });

  it("flags far-future firstOutcomeAt (clock-skew alarm)", () => {
    const r = checkCustomerReliabilityIntegrity(
      {
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        firstOutcomeAt: new Date(NOW.getTime() + 24 * 60 * 60_000), // +1 day
        lastOutcomeAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      },
      { now: NOW },
    );
    expect(r.violations.find((v) => v.code === "firstOutcomeAt_in_future")).toBeDefined();
  });

  it("does NOT flag a small clock-skew (within tolerance)", () => {
    const r = checkCustomerReliabilityIntegrity(
      {
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        firstOutcomeAt: new Date(NOW.getTime() + 60_000), // +1 min
        lastOutcomeAt: new Date(NOW.getTime() + 60_000),
      },
      { now: NOW },
    );
    expect(r.ok).toBe(true);
  });

  it("ignores invalid Date instances (non-finite getTime)", () => {
    const r = checkCustomerReliabilityIntegrity(
      {
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        firstOutcomeAt: new Date("not-a-date"),
        lastOutcomeAt: NOW,
      },
      { now: NOW },
    );
    // Invalid dates are treated as absent → no violation.
    expect(r.violations.find((v) => v.code === "lastOutcomeAt_before_firstOutcomeAt")).toBeUndefined();
  });

  it("returns ok for null / undefined row", () => {
    expect(checkCustomerReliabilityIntegrity(null).ok).toBe(true);
    expect(checkCustomerReliabilityIntegrity(undefined).ok).toBe(true);
  });
});

/* ========================================================================== */
/* AddressReliability — bounded-set violations                                */
/* ========================================================================== */

describe("checkAddressReliabilityIntegrity — distinctPhoneHashes", () => {
  it("clean row with under-cap set → ok", () => {
    const r = checkAddressReliabilityIntegrity(
      {
        deliveredCount: 3,
        rtoCount: 0,
        cancelledCount: 0,
        distinctPhoneHashes: ["a", "b", "c"],
      },
      { now: NOW },
    );
    expect(r.ok).toBe(true);
  });

  it("flags array exceeding cap", () => {
    const oversized = Array.from(
      { length: DISTINCT_PHONE_HASHES_CAP + 5 },
      (_, i) => `ph_${i}`,
    );
    const r = checkAddressReliabilityIntegrity(
      {
        deliveredCount: 5,
        rtoCount: 0,
        cancelledCount: 0,
        distinctPhoneHashes: oversized,
      },
      { now: NOW },
    );
    expect(r.violations.find((v) => v.code === "distinctPhoneHashes_exceeds_cap")).toBeDefined();
  });

  it("flags non-array distinctPhoneHashes", () => {
    const r = checkAddressReliabilityIntegrity(
      {
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        distinctPhoneHashes: "not-an-array",
      },
      { now: NOW },
    );
    expect(r.violations.find((v) => v.code === "distinctPhoneHashes_not_array")).toBeDefined();
  });

  it("flags duplicate entries inside distinctPhoneHashes", () => {
    const r = checkAddressReliabilityIntegrity(
      {
        deliveredCount: 2,
        rtoCount: 0,
        cancelledCount: 0,
        distinctPhoneHashes: ["a", "b", "a"],
      },
      { now: NOW },
    );
    expect(r.violations.find((v) => v.code === "duplicate_phone_hash")).toBeDefined();
  });

  it("does not flag an empty distinctPhoneHashes array", () => {
    const r = checkAddressReliabilityIntegrity(
      {
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        distinctPhoneHashes: [],
      },
      { now: NOW },
    );
    expect(r.ok).toBe(true);
  });

  it("returns ok for null / undefined row", () => {
    expect(checkAddressReliabilityIntegrity(null).ok).toBe(true);
    expect(checkAddressReliabilityIntegrity(undefined).ok).toBe(true);
  });
});

/* ========================================================================== */
/* checkReplayAnomaly                                                         */
/* ========================================================================== */

describe("checkReplayAnomaly — counter jumps", () => {
  it("ok when delta is within threshold", () => {
    const r = checkReplayAnomaly({ priorTotal: 10, currentTotal: 11 });
    expect(r.ok).toBe(true);
  });

  it("ok when no priorTotal supplied", () => {
    const r = checkReplayAnomaly({ currentTotal: 50 });
    expect(r.ok).toBe(true);
  });

  it("flags suspicious jumps over threshold", () => {
    const r = checkReplayAnomaly({
      priorTotal: 5,
      currentTotal: 5 + COUNTER_JUMP_THRESHOLD + 1,
    });
    expect(r.violations.find((v) => v.code === "counter_jumped_unexpectedly")).toBeDefined();
  });

  it("does not flag jumps exactly at the threshold (boundary respect)", () => {
    const r = checkReplayAnomaly({
      priorTotal: 0,
      currentTotal: COUNTER_JUMP_THRESHOLD,
    });
    expect(r.ok).toBe(true);
  });
});

/* ========================================================================== */
/* checkAggregateMismatch                                                     */
/* ========================================================================== */

describe("checkAggregateMismatch — drift vs source-of-truth", () => {
  it("ok when within tolerance", () => {
    const r = checkAggregateMismatch({
      aggregate: { deliveredCount: 100, rtoCount: 10, cancelledCount: 5 },
      expected: { deliveredCount: 101, rtoCount: 10, cancelledCount: 5 },
      tolerance: 2,
    });
    expect(r.ok).toBe(true);
  });

  it("flags drift on a single axis", () => {
    const r = checkAggregateMismatch({
      aggregate: { deliveredCount: 100, rtoCount: 10, cancelledCount: 5 },
      expected: { deliveredCount: 100, rtoCount: 50, cancelledCount: 5 },
      tolerance: 2,
    });
    const drift = r.violations.find((v) => v.code === "expected_resolved_mismatch");
    expect(drift).toBeDefined();
    expect(drift!.detail).toContain("rtoCount");
  });

  it("flags drift on multiple axes", () => {
    const r = checkAggregateMismatch({
      aggregate: { deliveredCount: 100, rtoCount: 10, cancelledCount: 5 },
      expected: { deliveredCount: 200, rtoCount: 100, cancelledCount: 0 },
      tolerance: 2,
    });
    expect(r.violations.length).toBe(3);
  });

  it("treats missing aggregate counters as 0", () => {
    const r = checkAggregateMismatch({
      aggregate: {},
      expected: { deliveredCount: 5, rtoCount: 0, cancelledCount: 0 },
      tolerance: 0,
    });
    const drift = r.violations.find((v) => v.code === "expected_resolved_mismatch");
    expect(drift).toBeDefined();
    expect(drift!.detail).toContain("deliveredCount");
  });

  it("respects custom tolerance", () => {
    const r = checkAggregateMismatch({
      aggregate: { deliveredCount: 100, rtoCount: 10, cancelledCount: 5 },
      expected: { deliveredCount: 105, rtoCount: 10, cancelledCount: 5 },
      tolerance: 10,
    });
    expect(r.ok).toBe(true);
  });

  it("default tolerance is 2 when unspecified", () => {
    const within = checkAggregateMismatch({
      aggregate: { deliveredCount: 100, rtoCount: 10, cancelledCount: 5 },
      expected: { deliveredCount: 102, rtoCount: 10, cancelledCount: 5 },
    });
    expect(within.ok).toBe(true);

    const outside = checkAggregateMismatch({
      aggregate: { deliveredCount: 100, rtoCount: 10, cancelledCount: 5 },
      expected: { deliveredCount: 103, rtoCount: 10, cancelledCount: 5 },
    });
    expect(outside.ok).toBe(false);
  });
});

/* ========================================================================== */
/* Helper-level invariants                                                    */
/* ========================================================================== */

describe("integrity helpers — purity invariants", () => {
  it("does not mutate input row (frozen input runs cleanly)", () => {
    const row = Object.freeze({
      deliveredCount: 5,
      rtoCount: 1,
      cancelledCount: 0,
      distinctPhoneHashes: Object.freeze(["a", "b"]),
      firstOutcomeAt: new Date(NOW.getTime() - 100_000),
      lastOutcomeAt: NOW,
    });
    expect(() =>
      checkAddressReliabilityIntegrity(
        row as Parameters<typeof checkAddressReliabilityIntegrity>[0],
        { now: NOW },
      ),
    ).not.toThrow();
  });

  it("never throws on degenerate input", () => {
    const inputs = [
      null,
      undefined,
      {},
      { deliveredCount: "five" },
      { distinctPhoneHashes: 42 },
      { firstOutcomeAt: "yesterday" },
    ] as Array<Parameters<typeof checkCustomerReliabilityIntegrity>[0]>;
    for (const i of inputs) {
      expect(() => checkCustomerReliabilityIntegrity(i, { now: NOW })).not.toThrow();
      expect(() => checkAddressReliabilityIntegrity(i as never, { now: NOW })).not.toThrow();
    }
  });

  it("__TEST.checkCountersImpossible exposed for boundary tests", () => {
    expect(__TEST.checkCountersImpossible({ deliveredCount: -1 }).length).toBeGreaterThan(0);
    expect(__TEST.checkCountersImpossible({ deliveredCount: 5 }).length).toBe(0);
  });
});
