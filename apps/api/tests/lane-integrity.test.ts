import { describe, expect, it } from "vitest";
import {
  checkAreaReliabilityIntegrity,
  checkCourierLaneIntegrity,
  checkCourierPerformanceIntegrity,
  __TEST,
} from "../src/lib/lane-integrity.js";

const NOW = new Date("2026-05-09T12:00:00Z");

describe("lane-integrity — checkCourierPerformanceIntegrity", () => {
  it("clean row reports ok=true", () => {
    const r = checkCourierPerformanceIntegrity(
      {
        deliveredCount: 100,
        rtoCount: 5,
        cancelledCount: 2,
        totalDeliveryHours: 100 * 24,
        lastOutcomeAt: new Date(NOW.getTime() - 60_000),
      },
      { now: NOW },
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it("flags negative counter", () => {
    const r = checkCourierPerformanceIntegrity(
      { deliveredCount: -1, rtoCount: 0, cancelledCount: 0 },
      { now: NOW },
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "negative_counter")).toBe(true);
  });

  it("flags non-finite counter", () => {
    const r = checkCourierPerformanceIntegrity(
      { deliveredCount: Number.NaN, rtoCount: 0, cancelledCount: 0 },
      { now: NOW },
    );
    expect(r.violations.some((v) => v.code === "non_finite_counter")).toBe(true);
  });

  it("flags totalDeliveryHours > 0 with deliveredCount = 0", () => {
    const r = checkCourierPerformanceIntegrity(
      { deliveredCount: 0, rtoCount: 0, cancelledCount: 0, totalDeliveryHours: 24 },
      { now: NOW },
    );
    expect(
      r.violations.some(
        (v) => v.code === "total_delivery_hours_without_delivered",
      ),
    ).toBe(true);
  });

  it("flags lastOutcomeAt in the future beyond tolerance", () => {
    const r = checkCourierPerformanceIntegrity(
      {
        deliveredCount: 1,
        rtoCount: 0,
        cancelledCount: 0,
        totalDeliveryHours: 24,
        lastOutcomeAt: new Date(NOW.getTime() + 10 * 60_000),
      },
      { now: NOW },
    );
    expect(r.violations.some((v) => v.code === "lastOutcomeAt_in_future")).toBe(true);
  });

  it("undefined row passes through (ok=true)", () => {
    expect(checkCourierPerformanceIntegrity(null).ok).toBe(true);
    expect(checkCourierPerformanceIntegrity(undefined).ok).toBe(true);
  });
});

describe("lane-integrity — checkCourierLaneIntegrity", () => {
  const cleanRow = {
    deliveredCount: 80,
    rtoCount: 10,
    cancelledCount: 5,
    totalDeliveryHours: 80 * 20,
    attempt1Delivered: 70,
    attempt2Delivered: 8,
    attempt3PlusDelivered: 2,
    attempt1Rto: 6,
    attempt2Rto: 3,
    attempt3PlusRto: 1,
    firstOutcomeAt: new Date(NOW.getTime() - 30 * 86400_000),
    lastOutcomeAt: new Date(NOW.getTime() - 60_000),
    pipelineVersion: "v1",
  };

  it("clean row reports ok=true", () => {
    const r = checkCourierLaneIntegrity(cleanRow, { now: NOW });
    expect(r.ok).toBe(true);
  });

  it("flags missing pipelineVersion", () => {
    const r = checkCourierLaneIntegrity(
      { ...cleanRow, pipelineVersion: undefined },
      { now: NOW },
    );
    expect(r.violations.some((v) => v.code === "missing_pipeline_version")).toBe(true);
  });

  it("flags per-attempt delivered exceeding total delivered", () => {
    const r = checkCourierLaneIntegrity(
      {
        ...cleanRow,
        deliveredCount: 50,
        attempt1Delivered: 70, // > deliveredCount
      },
      { now: NOW },
    );
    expect(
      r.violations.some(
        (v) => v.code === "per_attempt_delivered_exceeds_total",
      ),
    ).toBe(true);
  });

  it("flags per-attempt rto exceeding total rto", () => {
    const r = checkCourierLaneIntegrity(
      {
        ...cleanRow,
        rtoCount: 5,
        attempt1Rto: 10,
        attempt2Rto: 0,
        attempt3PlusRto: 0,
      },
      { now: NOW },
    );
    expect(
      r.violations.some((v) => v.code === "per_attempt_rto_exceeds_total"),
    ).toBe(true);
  });

  it("flags lastOutcomeAt before firstOutcomeAt", () => {
    const r = checkCourierLaneIntegrity(
      {
        ...cleanRow,
        firstOutcomeAt: new Date(NOW.getTime() - 60_000),
        lastOutcomeAt: new Date(NOW.getTime() - 30 * 86400_000),
      },
      { now: NOW },
    );
    expect(
      r.violations.some(
        (v) => v.code === "lastOutcomeAt_before_firstOutcomeAt",
      ),
    ).toBe(true);
  });

  it("flags all-zero counters with populated timestamps", () => {
    const r = checkCourierLaneIntegrity(
      {
        deliveredCount: 0,
        rtoCount: 0,
        cancelledCount: 0,
        firstOutcomeAt: NOW,
        lastOutcomeAt: NOW,
        pipelineVersion: "v1",
      },
      { now: NOW },
    );
    expect(
      r.violations.some((v) => v.code === "all_zero_with_timestamps"),
    ).toBe(true);
  });
});

describe("lane-integrity — checkAreaReliabilityIntegrity", () => {
  const cleanRow = {
    deliveredCount: 200,
    rtoCount: 15,
    cancelledCount: 10,
    unreachableCount: 30,
    recent7dDelivered: 12,
    recent7dRto: 2,
    recent7dCancelled: 1,
    recent7dWindowStartedAt: new Date(NOW.getTime() - 3 * 86400_000),
    firstOutcomeAt: new Date(NOW.getTime() - 60 * 86400_000),
    lastOutcomeAt: new Date(NOW.getTime() - 60_000),
    pipelineVersion: "v1",
  };

  it("clean row reports ok=true", () => {
    const r = checkAreaReliabilityIntegrity(cleanRow, { now: NOW });
    expect(r.ok).toBe(true);
  });

  it("flags recent7d counters exceeding cumulative", () => {
    const r = checkAreaReliabilityIntegrity(
      { ...cleanRow, recent7dDelivered: 250 }, // > cumulative 200
      { now: NOW },
    );
    expect(
      r.violations.some((v) => v.code === "recent7d_exceeds_cumulative"),
    ).toBe(true);
  });

  it("flags recent7dWindowStartedAt in the future", () => {
    const r = checkAreaReliabilityIntegrity(
      {
        ...cleanRow,
        recent7dWindowStartedAt: new Date(NOW.getTime() + 10 * 60_000),
      },
      { now: NOW },
    );
    expect(
      r.violations.some((v) => v.code === "recent7d_window_in_future"),
    ).toBe(true);
  });

  it("flags missing pipelineVersion", () => {
    const r = checkAreaReliabilityIntegrity(
      { ...cleanRow, pipelineVersion: undefined },
      { now: NOW },
    );
    expect(r.violations.some((v) => v.code === "missing_pipeline_version")).toBe(true);
  });

  it("undefined row passes through (ok=true)", () => {
    expect(checkAreaReliabilityIntegrity(null).ok).toBe(true);
  });
});

describe("lane-integrity — helper exports", () => {
  it("counter-field constants are non-empty arrays", () => {
    expect(__TEST.COURIER_PERFORMANCE_COUNTER_FIELDS.length).toBeGreaterThan(0);
    expect(__TEST.COURIER_LANE_COUNTER_FIELDS.length).toBeGreaterThan(0);
    expect(__TEST.AREA_RELIABILITY_COUNTER_FIELDS.length).toBeGreaterThan(0);
  });
});
