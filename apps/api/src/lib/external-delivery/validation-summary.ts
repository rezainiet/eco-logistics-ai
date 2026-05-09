/**
 * external-delivery / validation-summary — pure aggregator that
 * turns a list of orchestrator lookup results (from a staging
 * validation run) into the analytical-framework metrics: signal
 * distribution, provider outcome breakdown, latency stats,
 * coverage analysis.
 *
 * Pure — same input → same output. No DB, no I/O, no env reads.
 *
 * Used by:
 *   - apps/api/src/scripts/validateBdCourier.ts (one-shot CLI).
 *   - Any future admin endpoint that wants to surface cohort-level
 *     diagnostics without hand-rolling the maths.
 *
 * Hard rules (binding):
 *   - Output contains NO raw provider payloads, NO API keys, NO
 *     phone numbers (only phoneHash). Safe to write to disk.
 *   - Numeric inputs are safe-coerced; degenerate input never throws.
 */

import type { ExternalProfileResult } from "./fetch-profile.js";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface ValidationLookupOutcome {
  /** Cohort label assigned by the operator (e.g. "reseller_test_phone"). */
  cohortLabel?: string;
  /** SHA-256[:32] of the canonical phone. NEVER the raw phone. */
  phoneHash: string | null;
  /** True when the orchestrator returned a profile (not null). */
  resolved: boolean;
  /** Per-call timing (ms). */
  totalDurationMs: number;
  /** Source of the result, only present on resolved=true. */
  source?: "cache" | "mongo" | "providers";
  /** Mirror of profile.aggregate when resolved=true. */
  profile?: ExternalProfileResult;
  /** When resolved=false, the orchestrator returned null. Captures
   *  the cause so the summary can report it. */
  failureReason?:
    | "master_flag_off"
    | "invalid_merchant_id"
    | "unusable_phone"
    | "all_providers_failed"
    | "persist_failed"
    | "unknown";
}

export interface ValidationSummary {
  cohortSize: number;
  resolvedCount: number;
  unresolvedCount: number;
  /** Distribution by orchestrator source. */
  source: { cache: number; mongo: number; providers: number; unresolved: number };
  /** Per-signal flag count across resolved profiles. */
  signalDistribution: {
    strong_delivery_history: number;
    elevated_return_pattern: number;
    sparse_history: number;
    mixed_delivery_history: number;
  };
  /**
   * Per-provider counts: configured + ok + failed (configured-but-not-ok).
   * Drives the "is BDCourier returning data at all" rollout gate.
   */
  providerOutcomes: Record<string, {
    configured: number;
    ok: number;
    failed: number;
    /** Sum of total / delivered / cancelled across ok results — gives
     *  a rough "is the data coming back substantive" view. */
    sumTotal: number;
    sumDelivered: number;
    sumCancelled: number;
    sumRto: number;
  }>;
  /** Roll-up over per-call orchestrator timings. */
  latencyMs: {
    count: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  };
  /**
   * Counts of unresolved cohort entries by cause — surfaces ops
   * issues like "master flag is off" before claiming providers
   * are at fault.
   */
  failureBreakdown: Record<string, number>;
  /**
   * Coverage analysis — answers the "is BDCourier coverage good
   * enough for this cohort to be meaningful" question.
   */
  coverage: {
    profilesWithAnyData: number;       // aggregate.total > 0
    profilesWithSparseData: number;    // 0 < total < 5
    profilesWithRichData: number;      // total >= 15
    zeroDataRate: number | null;       // count(total=0) / resolved
    sparseRate: number | null;         // count(sparse_history) / resolved
    richRate: number | null;           // count(total>=15) / resolved
  };
  /**
   * Anomalies surfaced for operator inspection. Capped at 50 to keep
   * the report a reasonable size; first-N is fine — anomaly hunting
   * is a manual follow-up, not a complete index.
   */
  anomalies: ValidationAnomaly[];
  computedAt: Date;
}

export interface ValidationAnomaly {
  phoneHash: string;
  cohortLabel?: string;
  kind:
    | "all_providers_failed"
    | "all_providers_unconfigured"
    | "elevated_with_sparse"
    | "strong_AND_elevated"
    | "high_volume_high_return"
    | "outlier_latency";
  detail: string;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeNonNeg(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Nearest-rank percentile — returns the actual data point at the
 *  pth quantile rather than interpolating. Better for outlier
 *  visibility (a single 5s call shows up at p95 of a 20-call run). */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(sortedAsc.length * p) - 1),
  );
  return sortedAsc[idx]!;
}

function ensureProviderBucket(
  bucketMap: Record<string, ValidationSummary["providerOutcomes"][string]>,
  name: string,
): ValidationSummary["providerOutcomes"][string] {
  let b = bucketMap[name];
  if (!b) {
    b = {
      configured: 0,
      ok: 0,
      failed: 0,
      sumTotal: 0,
      sumDelivered: 0,
      sumCancelled: 0,
      sumRto: 0,
    };
    bucketMap[name] = b;
  }
  return b;
}

/* -------------------------------------------------------------------------- */
/* Public aggregator                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Aggregate a list of lookup outcomes into the validation-summary
 * shape. Pure function. Safe to call on degenerate input — invalid
 * entries are skipped, never throw.
 */
export function summariseValidationRun(
  outcomes: ReadonlyArray<ValidationLookupOutcome>,
  options: { now?: Date; latencyOutlierMs?: number } = {},
): ValidationSummary {
  const now = options.now ?? new Date();
  const latencyOutlierMs = options.latencyOutlierMs ?? 3000;

  const cohortSize = Array.isArray(outcomes) ? outcomes.length : 0;
  let resolved = 0;
  const sourceBuckets = { cache: 0, mongo: 0, providers: 0, unresolved: 0 };
  const signalDist = {
    strong_delivery_history: 0,
    elevated_return_pattern: 0,
    sparse_history: 0,
    mixed_delivery_history: 0,
  };
  const providerOutcomes: ValidationSummary["providerOutcomes"] = {};
  const latencies: number[] = [];
  const failureBreakdown: Record<string, number> = {};
  let profilesWithAnyData = 0;
  let profilesWithSparseData = 0;
  let profilesWithRichData = 0;
  const anomalies: ValidationAnomaly[] = [];
  const ANOMALY_CAP = 50;

  const pushAnomaly = (a: ValidationAnomaly): void => {
    if (anomalies.length < ANOMALY_CAP) anomalies.push(a);
  };

  for (const o of outcomes ?? []) {
    if (!o || typeof o !== "object") continue;
    const dur = safeNonNeg(o.totalDurationMs);
    latencies.push(dur);
    if (dur >= latencyOutlierMs && o.phoneHash) {
      pushAnomaly({
        phoneHash: o.phoneHash,
        cohortLabel: o.cohortLabel,
        kind: "outlier_latency",
        detail: `total ${dur}ms exceeds outlier threshold ${latencyOutlierMs}ms`,
      });
    }

    if (!o.resolved || !o.profile) {
      sourceBuckets.unresolved += 1;
      const reason = o.failureReason ?? "unknown";
      failureBreakdown[reason] = (failureBreakdown[reason] ?? 0) + 1;
      continue;
    }
    resolved += 1;
    const src = o.profile.source ?? "providers";
    if (src === "cache") sourceBuckets.cache += 1;
    else if (src === "mongo") sourceBuckets.mongo += 1;
    else sourceBuckets.providers += 1;

    // Signals.
    const s = o.profile.signals;
    if (s?.strong_delivery_history) signalDist.strong_delivery_history += 1;
    if (s?.elevated_return_pattern) signalDist.elevated_return_pattern += 1;
    if (s?.sparse_history) signalDist.sparse_history += 1;
    if (s?.mixed_delivery_history) signalDist.mixed_delivery_history += 1;

    // Coverage tier.
    const total = safeNonNeg(o.profile.aggregate?.total);
    if (total > 0) profilesWithAnyData += 1;
    if (total > 0 && total < 5) profilesWithSparseData += 1;
    if (total >= 15) profilesWithRichData += 1;

    // Per-provider outcome counts. Unconfigured providers are skipped
    // entirely — the bucket only exists for providers we actually
    // tried to call, so the cohort summary stays focused on real
    // upstream behaviour.
    let allConfigured = 0;
    let allOk = 0;
    for (const [name, snap] of Object.entries(o.profile.providers ?? {})) {
      if (!snap.configured) continue;
      const bucket = ensureProviderBucket(providerOutcomes, name);
      bucket.configured += 1;
      allConfigured += 1;
      if (snap.ok) {
        bucket.ok += 1;
        allOk += 1;
        bucket.sumTotal += safeNonNeg(snap.total);
        bucket.sumDelivered += safeNonNeg(snap.delivered);
        bucket.sumCancelled += safeNonNeg(snap.cancelled);
        bucket.sumRto += safeNonNeg(snap.rto);
      } else {
        bucket.failed += 1;
      }
    }

    // Anomaly: configured providers all failed for this profile.
    if (o.phoneHash && allConfigured > 0 && allOk === 0) {
      pushAnomaly({
        phoneHash: o.phoneHash,
        cohortLabel: o.cohortLabel,
        kind: "all_providers_failed",
        detail: `${allConfigured} configured provider(s); 0 ok`,
      });
    }
    // Anomaly: nothing was configured (probably env misconfig).
    if (o.phoneHash && allConfigured === 0) {
      pushAnomaly({
        phoneHash: o.phoneHash,
        cohortLabel: o.cohortLabel,
        kind: "all_providers_unconfigured",
        detail: "no provider reported configured=true",
      });
    }
    // Anomaly: contradictory signals.
    if (
      o.phoneHash &&
      s?.elevated_return_pattern &&
      s?.sparse_history
    ) {
      // Should not happen — signals.ts short-circuits both when
      // sparse. Surfacing this as a defect signal.
      pushAnomaly({
        phoneHash: o.phoneHash,
        cohortLabel: o.cohortLabel,
        kind: "elevated_with_sparse",
        detail: "both elevated_return_pattern AND sparse_history fired — classifier defect",
      });
    }
    if (
      o.phoneHash &&
      s?.strong_delivery_history &&
      s?.elevated_return_pattern
    ) {
      pushAnomaly({
        phoneHash: o.phoneHash,
        cohortLabel: o.cohortLabel,
        kind: "strong_AND_elevated",
        detail: "both strong_delivery_history AND elevated_return_pattern fired — review buyer manually",
      });
    }
    // Anomaly: high volume + high return — likely a reseller pattern,
    // worth manual inspection before merchant rollout.
    const cancelled = safeNonNeg(o.profile.aggregate?.cancelled);
    const totalProfile = safeNonNeg(o.profile.aggregate?.total);
    if (
      o.phoneHash &&
      totalProfile >= 30 &&
      cancelled / Math.max(1, totalProfile) >= 0.30
    ) {
      pushAnomaly({
        phoneHash: o.phoneHash,
        cohortLabel: o.cohortLabel,
        kind: "high_volume_high_return",
        detail: `total=${totalProfile} cancelled=${cancelled} (${Math.round((cancelled / totalProfile) * 100)}%) — possible reseller, verify manually`,
      });
    }
  }

  // Latency stats.
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const meanMs =
    latencies.length > 0
      ? Math.round(
          sortedLatencies.reduce((a, b) => a + b, 0) / sortedLatencies.length,
        )
      : 0;
  const p50Ms = Math.round(percentile(sortedLatencies, 0.5));
  const p95Ms = Math.round(percentile(sortedLatencies, 0.95));
  const maxMs = sortedLatencies[sortedLatencies.length - 1] ?? 0;

  const coverage: ValidationSummary["coverage"] = {
    profilesWithAnyData,
    profilesWithSparseData,
    profilesWithRichData,
    zeroDataRate:
      resolved > 0 ? (resolved - profilesWithAnyData) / resolved : null,
    sparseRate:
      resolved > 0 ? signalDist.sparse_history / resolved : null,
    richRate:
      resolved > 0 ? profilesWithRichData / resolved : null,
  };

  return {
    cohortSize,
    resolvedCount: resolved,
    unresolvedCount: cohortSize - resolved,
    source: sourceBuckets,
    signalDistribution: signalDist,
    providerOutcomes,
    latencyMs: {
      count: latencies.length,
      meanMs,
      p50Ms,
      p95Ms,
      maxMs,
    },
    failureBreakdown,
    coverage,
    anomalies,
    computedAt: now,
  };
}

/* -------------------------------------------------------------------------- */
/* Pre-rollout decision matrix                                                */
/* -------------------------------------------------------------------------- */

export interface RolloutReadinessVerdict {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  passed: string[];
}

/**
 * Translate a ValidationSummary into a yes/no rollout decision plus
 * an explanatory blocker/warning list. Pure — same summary → same
 * verdict. The thresholds encode the analytical framework documented
 * in the validation guide; tweak them deliberately, not casually.
 */
export function computeRolloutReadiness(
  s: ValidationSummary,
): RolloutReadinessVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const passed: string[] = [];

  // Provider stability — bdcourier-specific, but pattern-extensible.
  const bd = s.providerOutcomes.bdcourier;
  if (!bd) {
    blockers.push("BDCourier provider produced zero results in the cohort run.");
  } else {
    const total = bd.configured;
    if (total === 0) {
      blockers.push("BDCourier reported configured=false on every cohort entry.");
    } else {
      const failureRate = bd.failed / total;
      if (failureRate > 0.15) {
        blockers.push(
          `BDCourier failure rate ${Math.round(failureRate * 100)}% exceeds 15% hard fail.`,
        );
      } else if (failureRate > 0.05) {
        warnings.push(
          `BDCourier failure rate ${Math.round(failureRate * 100)}% — soft fail (5–15% band).`,
        );
      } else {
        passed.push(`BDCourier failure rate ${Math.round(failureRate * 100)}%.`);
      }
    }
  }

  // Latency.
  if (s.latencyMs.maxMs > 5000) {
    blockers.push(`Max orchestrator latency ${s.latencyMs.maxMs}ms exceeds 5s hard fail.`);
  } else if (s.latencyMs.maxMs > 3000) {
    warnings.push(`Max latency ${s.latencyMs.maxMs}ms — soft fail.`);
  } else {
    passed.push(`Max latency ${s.latencyMs.maxMs}ms.`);
  }
  if (s.latencyMs.meanMs > 2000) {
    blockers.push(`Mean latency ${s.latencyMs.meanMs}ms exceeds 2s hard fail.`);
  } else if (s.latencyMs.meanMs > 800) {
    warnings.push(`Mean latency ${s.latencyMs.meanMs}ms — soft fail (800–2000 band).`);
  } else {
    passed.push(`Mean latency ${s.latencyMs.meanMs}ms.`);
  }

  // Coverage.
  if (s.coverage.sparseRate !== null && s.coverage.sparseRate > 0.6) {
    blockers.push(
      `sparse_history rate ${Math.round(s.coverage.sparseRate * 100)}% exceeds 60% — BDCourier coverage too thin for the cohort.`,
    );
  } else if (s.coverage.sparseRate !== null && s.coverage.sparseRate > 0.4) {
    warnings.push(
      `sparse_history rate ${Math.round(s.coverage.sparseRate * 100)}% — soft fail (40-60%).`,
    );
  } else if (s.coverage.sparseRate !== null) {
    passed.push(`sparse_history rate ${Math.round(s.coverage.sparseRate * 100)}%.`);
  }

  // Anomalies — any contradictory signal indicates a classifier defect.
  const classifierDefects = s.anomalies.filter(
    (a) => a.kind === "elevated_with_sparse",
  );
  if (classifierDefects.length > 0) {
    blockers.push(
      `${classifierDefects.length} entries fired both elevated_return_pattern AND sparse_history — classifier defect.`,
    );
  }

  // Resolved-share — too many unresolved profiles is a misconfig signal.
  if (s.cohortSize > 0) {
    const resolvedRate = s.resolvedCount / s.cohortSize;
    if (resolvedRate < 0.5) {
      blockers.push(
        `Only ${Math.round(resolvedRate * 100)}% of cohort resolved — orchestrator returning null too often.`,
      );
    } else if (resolvedRate < 0.9) {
      warnings.push(
        `${Math.round(resolvedRate * 100)}% of cohort resolved — investigate failureBreakdown.`,
      );
    } else {
      passed.push(`${Math.round(resolvedRate * 100)}% resolved.`);
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    passed,
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  percentile,
};
