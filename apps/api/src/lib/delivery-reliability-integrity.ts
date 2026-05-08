/**
 * delivery-reliability-integrity — pure-function integrity / drift checks
 * for `CustomerReliability` and `AddressReliability` aggregate rows.
 *
 * Designed to be:
 *   - PURE — no I/O, no logging, no env reads, no Mongoose imports.
 *   - OBSERVE-only — never mutates input, never repairs, never enqueues.
 *   - Cheap — every check is O(1) over a single document.
 *
 * Callers are expected to be:
 *   - admin diagnostic surfaces ("audit one row")
 *   - future scheduled drift detector (out of v1 scope)
 *   - integration test harnesses
 *
 * The output `IntegrityReport` lists every violation with a stable `code`
 * so consumers can route alerts by code without parsing detail strings.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type IntegrityCode =
  | "negative_counter"
  | "non_finite_counter"
  | "all_zero_with_timestamps"
  | "lastOutcomeAt_before_firstOutcomeAt"
  | "firstOutcomeAt_in_future"
  | "lastOutcomeAt_in_future"
  | "distinctPhoneHashes_exceeds_cap"
  | "distinctPhoneHashes_not_array"
  | "duplicate_phone_hash"
  | "counter_jumped_unexpectedly"
  | "expected_resolved_mismatch";

export interface IntegrityViolation {
  code: IntegrityCode;
  detail: string;
}

export interface IntegrityReport {
  ok: boolean;
  violations: IntegrityViolation[];
}

/* Structural shapes — independent of the Mongoose models so pure unit tests
 * don't need a DB. */

export interface CustomerReliabilityRowShape {
  merchantId?: unknown;
  phoneHash?: unknown;
  deliveredCount?: unknown;
  rtoCount?: unknown;
  cancelledCount?: unknown;
  firstOutcomeAt?: unknown;
  lastOutcomeAt?: unknown;
  lastDistrict?: unknown;
  lastOrderId?: unknown;
}

export interface AddressReliabilityRowShape {
  merchantId?: unknown;
  addressHash?: unknown;
  deliveredCount?: unknown;
  rtoCount?: unknown;
  cancelledCount?: unknown;
  distinctPhoneHashes?: unknown;
  firstOutcomeAt?: unknown;
  lastOutcomeAt?: unknown;
  lastDistrict?: unknown;
  lastOrderId?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

export const DISTINCT_PHONE_HASHES_CAP = 32;
/**
 * If a single observation arrives that would advance a counter by more than
 * this many in one update, that's structurally impossible under normal
 * `$inc: 1` usage and indicates either a buggy writer or a corrupted row.
 */
export const COUNTER_JUMP_THRESHOLD = 100;
/**
 * Reasonable clock-skew tolerance — Mongo and the API clock can disagree by
 * a few seconds. A timestamp this far in the future is anomalous.
 */
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asDate(value: unknown): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function pushIfDuplicate(
  arr: ReadonlyArray<unknown>,
): IntegrityViolation | null {
  const seen = new Set<unknown>();
  for (const v of arr) {
    if (seen.has(v)) {
      return {
        code: "duplicate_phone_hash",
        detail: `distinctPhoneHashes contains a duplicate entry`,
      };
    }
    seen.add(v);
  }
  return null;
}

function checkCountersImpossible(
  row: { deliveredCount?: unknown; rtoCount?: unknown; cancelledCount?: unknown },
): IntegrityViolation[] {
  const out: IntegrityViolation[] = [];
  for (const field of ["deliveredCount", "rtoCount", "cancelledCount"] as const) {
    const v = row[field];
    if (v === undefined) continue; // missing is acceptable on legacy/incomplete rows
    if (!isFiniteNumber(v)) {
      out.push({
        code: "non_finite_counter",
        detail: `${field} is not a finite number (${String(v)})`,
      });
      continue;
    }
    if (v < 0) {
      out.push({
        code: "negative_counter",
        detail: `${field}=${v} is negative; counters must be ≥0`,
      });
    }
  }
  return out;
}

function checkAllZeroWithTimestamps(row: {
  deliveredCount?: unknown;
  rtoCount?: unknown;
  cancelledCount?: unknown;
  firstOutcomeAt?: unknown;
  lastOutcomeAt?: unknown;
}): IntegrityViolation[] {
  const d = isFiniteNumber(row.deliveredCount) ? row.deliveredCount : 0;
  const r = isFiniteNumber(row.rtoCount) ? row.rtoCount : 0;
  const c = isFiniteNumber(row.cancelledCount) ? row.cancelledCount : 0;
  const total = d + r + c;
  const hasFirst = asDate(row.firstOutcomeAt) !== null;
  const hasLast = asDate(row.lastOutcomeAt) !== null;
  if (total === 0 && (hasFirst || hasLast)) {
    return [
      {
        code: "all_zero_with_timestamps",
        detail: "every counter is zero but firstOutcomeAt / lastOutcomeAt is populated",
      },
    ];
  }
  return [];
}

function checkMonotonicTimestamps(
  row: { firstOutcomeAt?: unknown; lastOutcomeAt?: unknown },
  now: Date,
): IntegrityViolation[] {
  const out: IntegrityViolation[] = [];
  const first = asDate(row.firstOutcomeAt);
  const last = asDate(row.lastOutcomeAt);
  if (first && last && last.getTime() < first.getTime()) {
    out.push({
      code: "lastOutcomeAt_before_firstOutcomeAt",
      detail: `lastOutcomeAt (${last.toISOString()}) precedes firstOutcomeAt (${first.toISOString()})`,
    });
  }
  const futureCutoff = now.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS;
  if (first && first.getTime() > futureCutoff) {
    out.push({
      code: "firstOutcomeAt_in_future",
      detail: `firstOutcomeAt is more than ${FUTURE_TIMESTAMP_TOLERANCE_MS / 60000}m in the future`,
    });
  }
  if (last && last.getTime() > futureCutoff) {
    out.push({
      code: "lastOutcomeAt_in_future",
      detail: `lastOutcomeAt is more than ${FUTURE_TIMESTAMP_TOLERANCE_MS / 60000}m in the future`,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Customer integrity                                                         */
/* -------------------------------------------------------------------------- */

export function checkCustomerReliabilityIntegrity(
  row: CustomerReliabilityRowShape | null | undefined,
  options: { now?: Date } = {},
): IntegrityReport {
  if (!row) return { ok: true, violations: [] };
  const now = options.now ?? new Date();
  const violations: IntegrityViolation[] = [
    ...checkCountersImpossible(row),
    ...checkAllZeroWithTimestamps(row),
    ...checkMonotonicTimestamps(row, now),
  ];
  return { ok: violations.length === 0, violations };
}

/* -------------------------------------------------------------------------- */
/* Address integrity                                                          */
/* -------------------------------------------------------------------------- */

export function checkAddressReliabilityIntegrity(
  row: AddressReliabilityRowShape | null | undefined,
  options: { now?: Date } = {},
): IntegrityReport {
  if (!row) return { ok: true, violations: [] };
  const now = options.now ?? new Date();
  const violations: IntegrityViolation[] = [
    ...checkCountersImpossible(row),
    ...checkAllZeroWithTimestamps(row),
    ...checkMonotonicTimestamps(row, now),
  ];

  const set = row.distinctPhoneHashes;
  if (set !== undefined) {
    if (!Array.isArray(set)) {
      violations.push({
        code: "distinctPhoneHashes_not_array",
        detail: `distinctPhoneHashes is not an array (got ${typeof set})`,
      });
    } else {
      if (set.length > DISTINCT_PHONE_HASHES_CAP) {
        violations.push({
          code: "distinctPhoneHashes_exceeds_cap",
          detail: `distinctPhoneHashes length ${set.length} exceeds cap ${DISTINCT_PHONE_HASHES_CAP}`,
        });
      }
      const dupe = pushIfDuplicate(set);
      if (dupe) violations.push(dupe);
    }
  }

  return { ok: violations.length === 0, violations };
}

/* -------------------------------------------------------------------------- */
/* Replay-anomaly check                                                       */
/* -------------------------------------------------------------------------- */

export interface ReplayAnomalyInput {
  /** Counter value before the most recent observed write, when known. */
  priorTotal?: number;
  /** Counter value after the most recent observed write. */
  currentTotal: number;
}

/**
 * Detect a counter that jumped further than a single $inc would explain in
 * one observed transition. Used by replay-storm detectors that can sample
 * a row before/after a known terminal-flip event.
 */
export function checkReplayAnomaly(
  input: ReplayAnomalyInput,
): IntegrityReport {
  const violations: IntegrityViolation[] = [];
  if (
    isFiniteNumber(input.priorTotal) &&
    isFiniteNumber(input.currentTotal)
  ) {
    const delta = input.currentTotal - input.priorTotal;
    if (delta > COUNTER_JUMP_THRESHOLD) {
      violations.push({
        code: "counter_jumped_unexpectedly",
        detail: `counter advanced by ${delta} between observations (threshold ${COUNTER_JUMP_THRESHOLD})`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/* -------------------------------------------------------------------------- */
/* Aggregate-vs-source mismatch check                                         */
/* -------------------------------------------------------------------------- */

export interface AggregateMismatchInput {
  /** Counters as currently recorded on the aggregate row. */
  aggregate: {
    deliveredCount?: unknown;
    rtoCount?: unknown;
    cancelledCount?: unknown;
  };
  /** Counters recomputed from the source-of-truth (typically a sampled
   *  Order.aggregate over the buyer/address+merchant cohort). */
  expected: {
    deliveredCount: number;
    rtoCount: number;
    cancelledCount: number;
  };
  /**
   * Absolute tolerance — how many counts of slack to accept before flagging.
   * The chokepoint fan-out has a small race window where a terminal flip
   * fires the new helper before the aggregator's read snapshot completes;
   * defaults of 2 cover the common case without false positives.
   */
  tolerance?: number;
}

/**
 * Compare a row's counters against an externally-recomputed expectation.
 * Emits one violation per drifted axis. Never decides what to DO about
 * drift — just flags it.
 */
export function checkAggregateMismatch(
  input: AggregateMismatchInput,
): IntegrityReport {
  const violations: IntegrityViolation[] = [];
  const tol = isFiniteNumber(input.tolerance) ? Math.abs(input.tolerance) : 2;
  for (const field of ["deliveredCount", "rtoCount", "cancelledCount"] as const) {
    const actualRaw = input.aggregate[field];
    const expected = input.expected[field];
    const actual = isFiniteNumber(actualRaw) ? actualRaw : 0;
    if (Math.abs(actual - expected) > tol) {
      violations.push({
        code: "expected_resolved_mismatch",
        detail: `${field}: aggregate=${actual} vs expected=${expected} (tolerance ${tol})`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  DISTINCT_PHONE_HASHES_CAP,
  COUNTER_JUMP_THRESHOLD,
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  checkCountersImpossible,
  checkAllZeroWithTimestamps,
  checkMonotonicTimestamps,
};
