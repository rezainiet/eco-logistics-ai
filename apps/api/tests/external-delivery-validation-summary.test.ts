import { describe, expect, it } from "vitest";
import {
  computeRolloutReadiness,
  summariseValidationRun,
  type ValidationLookupOutcome,
} from "../src/lib/external-delivery/validation-summary.js";
import type { ExternalProfileResult } from "../src/lib/external-delivery/fetch-profile.js";

const NOW = new Date("2026-05-09T12:00:00Z");

type ProfileOverrides = Omit<Partial<ExternalProfileResult>, "signals"> & {
  signals?: Partial<ExternalProfileResult["signals"]>;
};

function profile(partial: ProfileOverrides = {}): ExternalProfileResult {
  const signals: ExternalProfileResult["signals"] = {
    strong_delivery_history: false,
    elevated_return_pattern: false,
    sparse_history: true,
    mixed_delivery_history: false,
    ...partial.signals,
  };
  const aggregate = {
    total: 0,
    delivered: 0,
    rto: 0,
    cancelled: 0,
    successRate: null,
    contributingProviders: [],
    ...partial.aggregate,
  };
  return {
    merchantId: "507f1f77bcf86cd799439011",
    phoneHash: "phoneHash_default",
    normalizedPhone: "8801712345678",
    providers: partial.providers ?? {},
    aggregate,
    signals,
    freshness: partial.freshness ?? {
      fetchedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 86400_000),
      stale: false,
    },
    pipelineVersion: partial.pipelineVersion ?? "v1",
    source: partial.source ?? "providers",
  };
}

function bdok(total: number, delivered: number, cancelled: number) {
  return {
    configured: true,
    ok: true,
    total,
    delivered,
    rto: 0,
    cancelled,
    successRate: delivered / Math.max(1, total),
    lastFetchedAt: NOW,
    sourceVersion: "bdcourier-v1",
  };
}

/* -------------------------------------------------------------------------- */

describe("validation-summary — basic shape", () => {
  it("empty cohort produces zero counts but valid shape", () => {
    const s = summariseValidationRun([], { now: NOW });
    expect(s.cohortSize).toBe(0);
    expect(s.resolvedCount).toBe(0);
    expect(s.signalDistribution.strong_delivery_history).toBe(0);
    expect(s.coverage.zeroDataRate).toBeNull();
    expect(s.anomalies).toEqual([]);
  });

  it("never throws on degenerate input", () => {
    expect(() =>
      summariseValidationRun(
        // @ts-expect-error — exercising defensive runtime
        [null, undefined, "not-an-object", { resolved: true }],
      ),
    ).not.toThrow();
  });
});

describe("validation-summary — resolved cohort", () => {
  it("counts source distribution correctly", () => {
    const out: ValidationLookupOutcome[] = [
      {
        cohortLabel: "a",
        phoneHash: "h1",
        resolved: true,
        totalDurationMs: 100,
        source: "providers",
        profile: profile({ source: "providers" }),
      },
      {
        cohortLabel: "b",
        phoneHash: "h2",
        resolved: true,
        totalDurationMs: 50,
        source: "cache",
        profile: profile({ source: "cache" }),
      },
      {
        cohortLabel: "c",
        phoneHash: "h3",
        resolved: false,
        totalDurationMs: 10,
        failureReason: "all_providers_failed",
      },
    ];
    const s = summariseValidationRun(out, { now: NOW });
    expect(s.source.providers).toBe(1);
    expect(s.source.cache).toBe(1);
    expect(s.source.unresolved).toBe(1);
    expect(s.failureBreakdown.all_providers_failed).toBe(1);
    expect(s.resolvedCount).toBe(2);
    expect(s.unresolvedCount).toBe(1);
  });

  it("aggregates per-provider counters from ok results only", () => {
    const out: ValidationLookupOutcome[] = [
      {
        phoneHash: "h1",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({
          providers: {
            bdcourier: bdok(20, 18, 2),
            // configured but failed — counted in `failed`, not in sums
            pathao: {
              configured: true,
              ok: false,
              total: 0,
              delivered: 0,
              rto: 0,
              cancelled: 0,
              successRate: null,
              lastFetchedAt: NOW,
              sourceVersion: "pathao-stub-v1",
              error: "stub_unconfigured",
            },
            // unconfigured — not counted at all
            steadfast: {
              configured: false,
              ok: false,
              total: 0,
              delivered: 0,
              rto: 0,
              cancelled: 0,
              successRate: null,
              lastFetchedAt: null,
              sourceVersion: "steadfast-stub-v1",
            },
          },
        }),
      },
    ];
    const s = summariseValidationRun(out, { now: NOW });
    expect(s.providerOutcomes.bdcourier).toMatchObject({
      configured: 1,
      ok: 1,
      failed: 0,
      sumTotal: 20,
      sumDelivered: 18,
      sumCancelled: 2,
    });
    expect(s.providerOutcomes.pathao).toMatchObject({
      configured: 1,
      ok: 0,
      failed: 1,
      sumTotal: 0,
    });
    expect(s.providerOutcomes.steadfast).toBeUndefined();
  });

  it("computes signal distribution", () => {
    const out: ValidationLookupOutcome[] = [
      {
        phoneHash: "h1",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({
          signals: {
            strong_delivery_history: true,
            sparse_history: false,
          },
        }),
      },
      {
        phoneHash: "h2",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({
          signals: { elevated_return_pattern: true, sparse_history: false },
        }),
      },
      {
        phoneHash: "h3",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({ signals: { sparse_history: true } }),
      },
    ];
    const s = summariseValidationRun(out, { now: NOW });
    expect(s.signalDistribution.strong_delivery_history).toBe(1);
    expect(s.signalDistribution.elevated_return_pattern).toBe(1);
    expect(s.signalDistribution.sparse_history).toBe(1);
  });

  it("computes latency stats with p50/p95", () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000];
    const out: ValidationLookupOutcome[] = durations.map((d, i) => ({
      phoneHash: `h${i}`,
      resolved: true,
      totalDurationMs: d,
      profile: profile(),
    }));
    const s = summariseValidationRun(out, { now: NOW });
    expect(s.latencyMs.count).toBe(10);
    expect(s.latencyMs.maxMs).toBe(1000);
    expect(s.latencyMs.p95Ms).toBe(1000);
    expect(s.latencyMs.p50Ms).toBeGreaterThanOrEqual(40);
    expect(s.latencyMs.p50Ms).toBeLessThanOrEqual(60);
  });

  it("flags outlier-latency anomalies", () => {
    const out: ValidationLookupOutcome[] = [
      {
        phoneHash: "h1",
        resolved: true,
        totalDurationMs: 5000,
        profile: profile(),
      },
    ];
    const s = summariseValidationRun(out, { now: NOW, latencyOutlierMs: 3000 });
    expect(s.anomalies.some((a) => a.kind === "outlier_latency")).toBe(true);
  });
});

describe("validation-summary — anomaly detection", () => {
  it("flags 'all_providers_failed' when configured>0 ok=0", () => {
    const out: ValidationLookupOutcome[] = [
      {
        phoneHash: "h1",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({
          providers: {
            bdcourier: {
              configured: true,
              ok: false,
              total: 0,
              delivered: 0,
              rto: 0,
              cancelled: 0,
              successRate: null,
              lastFetchedAt: NOW,
              sourceVersion: "bdcourier-v1",
              error: "timeout",
            },
          },
        }),
      },
    ];
    const s = summariseValidationRun(out, { now: NOW });
    expect(s.anomalies.some((a) => a.kind === "all_providers_failed")).toBe(true);
  });

  it("flags 'all_providers_unconfigured' on misconfigured cohort", () => {
    const out: ValidationLookupOutcome[] = [
      {
        phoneHash: "h1",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({ providers: {} }),
      },
    ];
    const s = summariseValidationRun(out, { now: NOW });
    expect(
      s.anomalies.some((a) => a.kind === "all_providers_unconfigured"),
    ).toBe(true);
  });

  it("flags reseller-shaped 'high_volume_high_return' for manual review", () => {
    const out: ValidationLookupOutcome[] = [
      {
        phoneHash: "h1",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({
          aggregate: {
            total: 50,
            delivered: 30,
            rto: 0,
            cancelled: 20,
            successRate: 30 / 50,
            contributingProviders: ["bdcourier"],
          },
        }),
      },
    ];
    const s = summariseValidationRun(out, { now: NOW });
    expect(
      s.anomalies.some((a) => a.kind === "high_volume_high_return"),
    ).toBe(true);
  });

  it("caps anomalies at 50 to keep the report compact", () => {
    const many: ValidationLookupOutcome[] = Array.from({ length: 100 }, (_, i) => ({
      phoneHash: `h${i}`,
      resolved: true,
      totalDurationMs: 100,
      profile: profile({ providers: {} }), // each triggers all_providers_unconfigured
    }));
    const s = summariseValidationRun(many, { now: NOW });
    expect(s.anomalies.length).toBeLessThanOrEqual(50);
  });
});

describe("validation-summary — coverage", () => {
  it("computes zero-data / sparse / rich coverage tiers", () => {
    const out: ValidationLookupOutcome[] = [
      {
        phoneHash: "h_zero",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({
          aggregate: {
            total: 0,
            delivered: 0,
            rto: 0,
            cancelled: 0,
            successRate: null,
            contributingProviders: [],
          },
          signals: { sparse_history: true },
        }),
      },
      {
        phoneHash: "h_sparse",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({
          aggregate: {
            total: 3,
            delivered: 3,
            rto: 0,
            cancelled: 0,
            successRate: 1,
            contributingProviders: ["bdcourier"],
          },
          signals: { sparse_history: true },
        }),
      },
      {
        phoneHash: "h_rich",
        resolved: true,
        totalDurationMs: 100,
        profile: profile({
          aggregate: {
            total: 25,
            delivered: 23,
            rto: 0,
            cancelled: 2,
            successRate: 23 / 25,
            contributingProviders: ["bdcourier"],
          },
          signals: {
            strong_delivery_history: true,
            sparse_history: false,
          },
        }),
      },
    ];
    const s = summariseValidationRun(out, { now: NOW });
    expect(s.coverage.profilesWithAnyData).toBe(2); // sparse + rich
    expect(s.coverage.profilesWithSparseData).toBe(1); // 0 < 3 < 5
    expect(s.coverage.profilesWithRichData).toBe(1); // 25 >= 15
    expect(s.coverage.zeroDataRate).toBeCloseTo(1 / 3, 3);
    expect(s.coverage.sparseRate).toBeCloseTo(2 / 3, 3);
    expect(s.coverage.richRate).toBeCloseTo(1 / 3, 3);
  });
});

/* -------------------------------------------------------------------------- */

describe("computeRolloutReadiness — pre-rollout decision matrix", () => {
  function summary(
    partial: Partial<ReturnType<typeof summariseValidationRun>> = {},
  ) {
    const base = summariseValidationRun([], { now: NOW });
    return {
      ...base,
      cohortSize: 20,
      resolvedCount: 20,
      ...partial,
      providerOutcomes: {
        bdcourier: {
          configured: 20,
          ok: 19,
          failed: 1,
          sumTotal: 200,
          sumDelivered: 180,
          sumCancelled: 20,
          sumRto: 0,
        },
        ...(partial.providerOutcomes ?? {}),
      },
      latencyMs: {
        count: 20,
        meanMs: 600,
        p50Ms: 500,
        p95Ms: 1500,
        maxMs: 2500,
        ...(partial.latencyMs ?? {}),
      },
      coverage: {
        profilesWithAnyData: 18,
        profilesWithSparseData: 3,
        profilesWithRichData: 10,
        zeroDataRate: 0.1,
        sparseRate: 0.3,
        richRate: 0.5,
        ...(partial.coverage ?? {}),
      },
    };
  }

  it("clean cohort → ready=true with zero blockers", () => {
    const v = computeRolloutReadiness(summary());
    expect(v.ready).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it("BDCourier failure rate >15% → blocker", () => {
    const v = computeRolloutReadiness(
      summary({
        providerOutcomes: {
          bdcourier: {
            configured: 20,
            ok: 16,
            failed: 4,
            sumTotal: 0,
            sumDelivered: 0,
            sumCancelled: 0,
            sumRto: 0,
          },
        },
      }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers.some((b) => b.includes("BDCourier failure rate"))).toBe(true);
  });

  it("sparse rate >60% → blocker (BDCourier coverage too thin)", () => {
    const v = computeRolloutReadiness(
      summary({
        coverage: {
          profilesWithAnyData: 7,
          profilesWithSparseData: 3,
          profilesWithRichData: 1,
          zeroDataRate: 0.65,
          sparseRate: 0.7,
          richRate: 0.05,
        },
      }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers.some((b) => b.includes("sparse_history"))).toBe(true);
  });

  it("max latency >5s → blocker", () => {
    const v = computeRolloutReadiness(
      summary({
        latencyMs: {
          count: 20,
          meanMs: 800,
          p50Ms: 600,
          p95Ms: 4000,
          maxMs: 6000,
        },
      }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers.some((b) => b.includes("Max"))).toBe(true);
  });

  it("classifier-defect anomaly → blocker", () => {
    const v = computeRolloutReadiness(
      summary({
        anomalies: [
          {
            phoneHash: "x",
            kind: "elevated_with_sparse",
            detail: "test",
          },
        ],
      }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers.some((b) => b.includes("classifier defect"))).toBe(true);
  });

  it("warnings don't block but are surfaced", () => {
    const v = computeRolloutReadiness(
      summary({
        latencyMs: {
          count: 20,
          meanMs: 1500,
          p50Ms: 1300,
          p95Ms: 2500,
          maxMs: 3500,
        },
      }),
    );
    expect(v.ready).toBe(true);
    expect(v.warnings.length).toBeGreaterThan(0);
  });
});
