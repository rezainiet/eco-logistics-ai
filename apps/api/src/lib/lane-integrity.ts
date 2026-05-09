/**
 * lane-integrity — pure-function integrity / drift checks for the
 * Phase 3 aggregate rows (CourierPerformance / CourierLane /
 * AreaReliability). Sibling of `lib/delivery-reliability-integrity.ts`
 * — same shape, same hard rules:
 *
 *   - PURE — no I/O, no logging, no env reads, no Mongoose imports.
 *   - OBSERVE-only — never mutates input, never repairs, never enqueues.
 *   - Cheap — every check is O(1) over a single document.
 *
 * Output `IntegrityReport` lists every violation with a stable `code`
 * so consumers can route alerts by code without parsing detail strings.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type LaneIntegrityCode =
  | "negative_counter"
  | "non_finite_counter"
  | "all_zero_with_timestamps"
  | "lastOutcomeAt_before_firstOutcomeAt"
  | "firstOutcomeAt_in_future"
  | "lastOutcomeAt_in_future"
  | "total_delivery_hours_negative"
  | "total_delivery_hours_without_delivered"
  | "per_attempt_delivered_exceeds_total"
  | "per_attempt_rto_exceeds_total"
  | "recent7d_exceeds_cumulative"
  | "recent7d_window_in_future"
  | "missing_pipeline_version";

export interface LaneIntegrityViolation {
  code: LaneIntegrityCode;
  detail: string;
}

export interface LaneIntegrityReport {
  ok: boolean;
  violations: LaneIntegrityViolation[];
}

/* Structural shapes — independent of the Mongoose models so pure unit tests
 * don't need a DB. */

export interface CourierPerformanceRowShape {
  merchantId?: unknown;
  courier?: unknown;
  district?: unknown;
  deliveredCount?: unknown;
  rtoCount?: unknown;
  cancelledCount?: unknown;
  totalDeliveryHours?: unknown;
  lastOutcomeAt?: unknown;
}

export interface CourierLaneRowShape {
  merchantId?: unknown;
  courier?: unknown;
  district?: unknown;
  thana?: unknown;
  deliveredCount?: unknown;
  rtoCount?: unknown;
  cancelledCount?: unknown;
  totalDeliveryHours?: unknown;
  attempt1Delivered?: unknown;
  attempt1Rto?: unknown;
  attempt2Delivered?: unknown;
  attempt2Rto?: unknown;
  attempt3PlusDelivered?: unknown;
  attempt3PlusRto?: unknown;
  firstOutcomeAt?: unknown;
  lastOutcomeAt?: unknown;
  pipelineVersion?: unknown;
}

export interface AreaReliabilityRowShape {
  merchantId?: unknown;
  division?: unknown;
  district?: unknown;
  thana?: unknown;
  deliveredCount?: unknown;
  rtoCount?: unknown;
  cancelledCount?: unknown;
  unreachableCount?: unknown;
  recent7dDelivered?: unknown;
  recent7dRto?: unknown;
  recent7dCancelled?: unknown;
  recent7dWindowStartedAt?: unknown;
  firstOutcomeAt?: unknown;
  lastOutcomeAt?: unknown;
  pipelineVersion?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

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

function checkCountersImpossible(
  row: Record<string, unknown>,
  fields: ReadonlyArray<string>,
): LaneIntegrityViolation[] {
  const out: LaneIntegrityViolation[] = [];
  for (const field of fields) {
    const v = row[field];
    if (v === undefined) continue;
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

function checkAllZeroWithTimestamps(
  row: {
    deliveredCount?: unknown;
    rtoCount?: unknown;
    cancelledCount?: unknown;
    firstOutcomeAt?: unknown;
    lastOutcomeAt?: unknown;
  },
): LaneIntegrityViolation[] {
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
        detail:
          "every outcome counter is zero but firstOutcomeAt / lastOutcomeAt is populated",
      },
    ];
  }
  return [];
}

function checkMonotonicTimestamps(
  row: { firstOutcomeAt?: unknown; lastOutcomeAt?: unknown },
  now: Date,
): LaneIntegrityViolation[] {
  const out: LaneIntegrityViolation[] = [];
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

function checkTotalDeliveryHours(row: {
  deliveredCount?: unknown;
  totalDeliveryHours?: unknown;
}): LaneIntegrityViolation[] {
  const out: LaneIntegrityViolation[] = [];
  const tdh = row.totalDeliveryHours;
  const delivered = isFiniteNumber(row.deliveredCount) ? row.deliveredCount : 0;
  if (tdh === undefined) return out;
  if (!isFiniteNumber(tdh)) {
    return out; // already flagged by checkCountersImpossible
  }
  if (tdh < 0) {
    out.push({
      code: "total_delivery_hours_negative",
      detail: `totalDeliveryHours=${tdh} is negative`,
    });
  }
  if (tdh > 0 && delivered === 0) {
    out.push({
      code: "total_delivery_hours_without_delivered",
      detail: `totalDeliveryHours=${tdh} but deliveredCount=0`,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* CourierPerformance integrity                                               */
/* -------------------------------------------------------------------------- */

const COURIER_PERFORMANCE_COUNTER_FIELDS = [
  "deliveredCount",
  "rtoCount",
  "cancelledCount",
  "totalDeliveryHours",
] as const;

export function checkCourierPerformanceIntegrity(
  row: CourierPerformanceRowShape | null | undefined,
  options: { now?: Date } = {},
): LaneIntegrityReport {
  if (!row) return { ok: true, violations: [] };
  const now = options.now ?? new Date();
  // CourierPerformance has lastOutcomeAt only — no firstOutcomeAt anchor.
  const violations: LaneIntegrityViolation[] = [
    ...checkCountersImpossible(
      row as Record<string, unknown>,
      COURIER_PERFORMANCE_COUNTER_FIELDS,
    ),
    ...checkTotalDeliveryHours(row),
    ...checkMonotonicTimestamps(
      { firstOutcomeAt: undefined, lastOutcomeAt: row.lastOutcomeAt },
      now,
    ),
  ];
  return { ok: violations.length === 0, violations };
}

/* -------------------------------------------------------------------------- */
/* CourierLane integrity                                                      */
/* -------------------------------------------------------------------------- */

const COURIER_LANE_COUNTER_FIELDS = [
  "deliveredCount",
  "rtoCount",
  "cancelledCount",
  "totalDeliveryHours",
  "attempt1Delivered",
  "attempt1Rto",
  "attempt2Delivered",
  "attempt2Rto",
  "attempt3PlusDelivered",
  "attempt3PlusRto",
] as const;

function checkPerAttemptConsistency(
  row: CourierLaneRowShape,
): LaneIntegrityViolation[] {
  const out: LaneIntegrityViolation[] = [];
  const num = (v: unknown) => (isFiniteNumber(v) && v >= 0 ? v : 0);
  const delivered = num(row.deliveredCount);
  const rto = num(row.rtoCount);
  const a1d = num(row.attempt1Delivered);
  const a2d = num(row.attempt2Delivered);
  const a3d = num(row.attempt3PlusDelivered);
  const a1r = num(row.attempt1Rto);
  const a2r = num(row.attempt2Rto);
  const a3r = num(row.attempt3PlusRto);
  const sumAttDelivered = a1d + a2d + a3d;
  const sumAttRto = a1r + a2r + a3r;
  // Per-attempt counters are bumped only on delivered/rto outcomes and
  // strictly never exceed the cumulative counter for that outcome (they
  // partition the same set of orders by attempt index).
  if (sumAttDelivered > delivered) {
    out.push({
      code: "per_attempt_delivered_exceeds_total",
      detail: `attempt1+2+3+ delivered (${sumAttDelivered}) exceeds deliveredCount (${delivered})`,
    });
  }
  if (sumAttRto > rto) {
    out.push({
      code: "per_attempt_rto_exceeds_total",
      detail: `attempt1+2+3+ rto (${sumAttRto}) exceeds rtoCount (${rto})`,
    });
  }
  return out;
}

export function checkCourierLaneIntegrity(
  row: CourierLaneRowShape | null | undefined,
  options: { now?: Date } = {},
): LaneIntegrityReport {
  if (!row) return { ok: true, violations: [] };
  const now = options.now ?? new Date();
  const violations: LaneIntegrityViolation[] = [
    ...checkCountersImpossible(
      row as Record<string, unknown>,
      COURIER_LANE_COUNTER_FIELDS,
    ),
    ...checkAllZeroWithTimestamps(row),
    ...checkTotalDeliveryHours(row),
    ...checkMonotonicTimestamps(row, now),
    ...checkPerAttemptConsistency(row),
  ];
  if (row.pipelineVersion === undefined || row.pipelineVersion === null) {
    violations.push({
      code: "missing_pipeline_version",
      detail:
        "CourierLane row has no pipelineVersion — should always be stamped at write time",
    });
  }
  return { ok: violations.length === 0, violations };
}

/* -------------------------------------------------------------------------- */
/* AreaReliability integrity                                                  */
/* -------------------------------------------------------------------------- */

const AREA_RELIABILITY_COUNTER_FIELDS = [
  "deliveredCount",
  "rtoCount",
  "cancelledCount",
  "unreachableCount",
  "recent7dDelivered",
  "recent7dRto",
  "recent7dCancelled",
] as const;

function checkRecent7dWindow(
  row: AreaReliabilityRowShape,
  now: Date,
): LaneIntegrityViolation[] {
  const out: LaneIntegrityViolation[] = [];
  const num = (v: unknown) => (isFiniteNumber(v) && v >= 0 ? v : 0);
  const cumD = num(row.deliveredCount);
  const cumR = num(row.rtoCount);
  const cumC = num(row.cancelledCount);
  const recD = num(row.recent7dDelivered);
  const recR = num(row.recent7dRto);
  const recC = num(row.recent7dCancelled);
  // The rolling-7d counters are strictly a SUBSET of the cumulative
  // counters (they reset on window expiry but never grow beyond what the
  // cumulative has accumulated). Any inversion is a clear corruption.
  if (recD > cumD || recR > cumR || recC > cumC) {
    out.push({
      code: "recent7d_exceeds_cumulative",
      detail: `recent7d {d:${recD}, r:${recR}, c:${recC}} exceeds cumulative {d:${cumD}, r:${cumR}, c:${cumC}}`,
    });
  }
  const win = asDate(row.recent7dWindowStartedAt);
  if (win) {
    const futureCutoff = now.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS;
    if (win.getTime() > futureCutoff) {
      out.push({
        code: "recent7d_window_in_future",
        detail: `recent7dWindowStartedAt is more than ${FUTURE_TIMESTAMP_TOLERANCE_MS / 60000}m in the future`,
      });
    }
  }
  return out;
}

export function checkAreaReliabilityIntegrity(
  row: AreaReliabilityRowShape | null | undefined,
  options: { now?: Date } = {},
): LaneIntegrityReport {
  if (!row) return { ok: true, violations: [] };
  const now = options.now ?? new Date();
  const violations: LaneIntegrityViolation[] = [
    ...checkCountersImpossible(
      row as Record<string, unknown>,
      AREA_RELIABILITY_COUNTER_FIELDS,
    ),
    ...checkAllZeroWithTimestamps(row),
    ...checkMonotonicTimestamps(row, now),
    ...checkRecent7dWindow(row, now),
  ];
  if (row.pipelineVersion === undefined || row.pipelineVersion === null) {
    violations.push({
      code: "missing_pipeline_version",
      detail:
        "AreaReliability row has no pipelineVersion — should always be stamped at write time",
    });
  }
  return { ok: violations.length === 0, violations };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  COURIER_PERFORMANCE_COUNTER_FIELDS,
  COURIER_LANE_COUNTER_FIELDS,
  AREA_RELIABILITY_COUNTER_FIELDS,
  checkCountersImpossible,
  checkAllZeroWithTimestamps,
  checkMonotonicTimestamps,
  checkTotalDeliveryHours,
  checkPerAttemptConsistency,
  checkRecent7dWindow,
};
