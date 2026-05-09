import { Types } from "mongoose";
import {
  AreaReliability,
  COURIER_PERF_GLOBAL_DISTRICT,
  CourierLane,
  CourierPerformance,
  Order,
} from "@ecom/db";
import { normalizeDistrict } from "./district.js";

/**
 * courier-reconciliation — read-only consistency checker for the
 * Phase 3 aggregates plus the legacy CourierPerformance.
 *
 * Sibling of `lib/delivery-reliability-reconciliation.ts`. Same shape:
 *
 *   - PURE READ. No writes to any collection. No queue dispatches. No
 *     replay triggers. No mutations of any kind.
 *   - Bounded. Per-merchant terminal-order scan capped at
 *     MAX_RECONCILE_SCAN. Merchants over the cap surface a
 *     `truncated: true` warning so operators know the report is partial.
 *   - Window-aware. Each aggregate's individual `firstOutcomeAt`
 *     anchors its recompute window. Pre-flag terminal orders are NOT
 *     expected in the aggregate and do NOT count as drift.
 *   - Defensive. Any per-row computation failure is logged and skipped;
 *     never throws back to the caller.
 *
 * What this module does NOT do:
 *   - Repair the aggregates (Phase 4 concern; same dry-run / bounded /
 *     idempotent $set discipline as `delivery-reliability-repair.ts`).
 *   - Trigger backfill of missing aggregates.
 *   - Reconcile per-attempt counters on CourierLane (would require
 *     re-deriving the attempt sequence from trackingEvents — out of
 *     scope here).
 *   - Reconcile unreachableCount or recent7d* on AreaReliability
 *     (CallLog joins are expensive; rolling-window math doesn't
 *     reconcile to a snapshot — both flagged for Phase 4).
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type CourierReconcileAxis =
  | "courier_performance"
  | "courier_lane"
  | "area_reliability";

export interface ReconcileCounters {
  delivered: number;
  rto: number;
  cancelled: number;
}

export interface ReconcileKeyDrift {
  axis: CourierReconcileAxis;
  /** Stringified composite key (e.g. "pathao|dhaka" or "pathao|dhaka|dhanmondi"). */
  key: string;
  exists: boolean;
  aggregate: ReconcileCounters;
  expected: ReconcileCounters;
  drift: ReconcileCounters;
  driftMagnitude: number;
  windowStart: Date | null;
  sampleSize: number;
}

export interface ReconcileSliceResult {
  merchantId: string;
  axis: CourierReconcileAxis;
  generatedAt: Date;
  entries: ReconcileKeyDrift[];
  driftedKeys: string[];
  ordersScanned: number;
  truncated: boolean;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

export const MAX_RECONCILE_SCAN = 10_000;
export const DRIFT_TOLERANCE = 2;
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_MS = DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeMerchantOid(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  if (value == null) return null;
  try {
    const s = typeof value === "string" ? value : String(value);
    return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
  } catch {
    return null;
  }
}

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function emptyCounters(): ReconcileCounters {
  return { delivered: 0, rto: 0, cancelled: 0 };
}

function counterDiff(
  expected: ReconcileCounters,
  aggregate: ReconcileCounters,
): ReconcileCounters {
  return {
    delivered: expected.delivered - aggregate.delivered,
    rto: expected.rto - aggregate.rto,
    cancelled: expected.cancelled - aggregate.cancelled,
  };
}

function magnitude(c: ReconcileCounters): number {
  return Math.abs(c.delivered) + Math.abs(c.rto) + Math.abs(c.cancelled);
}

interface OrderLeanRow {
  _id?: Types.ObjectId;
  customer?: { phone?: string; thana?: string; district?: string };
  source?: {
    addressHash?: string;
    canonicalAddress?: { thana?: string; district?: string; division?: string };
  };
  order?: { status?: string };
  logistics?: {
    courier?: string;
    deliveredAt?: Date | null;
    returnedAt?: Date | null;
  };
  updatedAt?: Date;
}

function terminalAt(o: OrderLeanRow): Date | null {
  const status = o.order?.status;
  if (status === "delivered") return o.logistics?.deliveredAt ?? o.updatedAt ?? null;
  if (status === "rto") return o.logistics?.returnedAt ?? o.updatedAt ?? null;
  if (status === "cancelled") return o.updatedAt ?? null;
  return null;
}

function bumpCounter(c: ReconcileCounters, status: string): void {
  if (status === "delivered") c.delivered += 1;
  else if (status === "rto") c.rto += 1;
  else if (status === "cancelled") c.cancelled += 1;
}

interface RawObservation {
  status: string;
  terminalMs: number;
  courier: string | null;
  district: string | null;
  thana: string | null;
  division: string | null;
}

function buildObservations(
  orders: OrderLeanRow[],
  unionWindowStart: Date,
  now: Date,
): { observations: RawObservation[]; scanned: number } {
  const observations: RawObservation[] = [];
  let scanned = 0;
  for (const o of orders) {
    scanned += 1;
    const status = o.order?.status;
    if (status !== "delivered" && status !== "rto" && status !== "cancelled") continue;
    const terminal = terminalAt(o);
    if (!terminal) continue;
    const terminalMs = terminal.getTime();
    if (!Number.isFinite(terminalMs)) continue;
    if (terminalMs > now.getTime()) continue;
    if (terminalMs < unionWindowStart.getTime()) continue;

    const courier = (() => {
      const c = o.logistics?.courier;
      return typeof c === "string" && c.trim().length > 0
        ? c.trim().toLowerCase()
        : null;
    })();
    const districtRaw =
      o.source?.canonicalAddress?.district ?? o.customer?.district ?? null;
    const district = districtRaw
      ? normalizeDistrict(districtRaw)
      : null;
    const thana =
      o.source?.canonicalAddress?.thana ?? o.customer?.thana ?? null;
    const division = o.source?.canonicalAddress?.division ?? null;

    observations.push({
      status,
      terminalMs,
      courier,
      district,
      thana: thana ? thana.toLowerCase().trim() : null,
      division: division ? division.toLowerCase().trim() : null,
    });
  }
  return { observations, scanned };
}

/* -------------------------------------------------------------------------- */
/* Shared per-merchant order scan                                             */
/* -------------------------------------------------------------------------- */

interface OrderScanResult {
  observations: RawObservation[];
  scanned: number;
  truncated: boolean;
  warnings: string[];
  unionWindowStart: Date;
}

async function scanTerminalOrders(args: {
  merchantId: Types.ObjectId;
  scanLimit: number;
  unionWindowStart: Date;
  now: Date;
  courierFilter?: string | null;
}): Promise<OrderScanResult> {
  const warnings: string[] = [];
  const filter: Record<string, unknown> = {
    merchantId: args.merchantId,
    "order.status": { $in: ["delivered", "rto", "cancelled"] },
  };
  if (args.courierFilter) {
    filter["logistics.courier"] = args.courierFilter.toLowerCase();
  }

  let orders: OrderLeanRow[] = [];
  try {
    orders = (await Order.find(filter)
      .select(
        "customer.phone customer.thana customer.district " +
          "source.canonicalAddress source.addressHash " +
          "order.status logistics.courier logistics.deliveredAt " +
          "logistics.returnedAt updatedAt",
      )
      .limit(args.scanLimit + 1)
      .lean()
      .exec()) as OrderLeanRow[];
  } catch (err) {
    warnings.push(`order scan failed: ${(err as Error).message ?? err}`);
    return {
      observations: [],
      scanned: 0,
      truncated: false,
      warnings,
      unionWindowStart: args.unionWindowStart,
    };
  }
  const truncated = orders.length > args.scanLimit;
  if (truncated) {
    orders = orders.slice(0, args.scanLimit);
    warnings.push(`order scan capped at ${args.scanLimit}; results may be partial`);
  }

  const { observations, scanned } = buildObservations(
    orders,
    args.unionWindowStart,
    args.now,
  );
  return {
    observations,
    scanned,
    truncated,
    warnings,
    unionWindowStart: args.unionWindowStart,
  };
}

/* -------------------------------------------------------------------------- */
/* CourierPerformance reconciliation                                          */
/* -------------------------------------------------------------------------- */

export interface ReconcileCourierPerformanceInput {
  merchantId: Types.ObjectId | string;
  /** Optional courier filter — defaults to all couriers for the merchant. */
  courier?: string;
  scanLimit?: number;
  now?: Date;
}

export async function reconcileCourierPerformanceSlice(
  input: ReconcileCourierPerformanceInput,
): Promise<ReconcileSliceResult> {
  const merchantOid = safeMerchantOid(input.merchantId);
  const now =
    input.now instanceof Date && Number.isFinite(input.now.getTime())
      ? input.now
      : new Date();
  const empty: ReconcileSliceResult = {
    merchantId: merchantOid?.toHexString() ?? String(input.merchantId ?? ""),
    axis: "courier_performance",
    generatedAt: now,
    entries: [],
    driftedKeys: [],
    ordersScanned: 0,
    truncated: false,
    warnings: [],
  };
  if (!merchantOid) {
    empty.warnings.push("invalid merchantId");
    return empty;
  }

  // 1. Load aggregate rows (district + _GLOBAL_).
  const aggregateFilter: Record<string, unknown> = { merchantId: merchantOid };
  if (input.courier) {
    aggregateFilter.courier = input.courier.toLowerCase();
  }
  let aggregates: Array<{
    courier: string;
    district: string;
    delivered: number;
    rto: number;
    cancelled: number;
    lastOutcomeAt: Date | null;
  }> = [];
  try {
    const rows = await CourierPerformance.find(aggregateFilter)
      .select("courier district deliveredCount rtoCount cancelledCount lastOutcomeAt")
      .lean()
      .exec();
    aggregates = rows.map((r) => ({
      courier: r.courier,
      district: r.district,
      delivered: safeNum(r.deliveredCount),
      rto: safeNum(r.rtoCount),
      cancelled: safeNum(r.cancelledCount),
      lastOutcomeAt: r.lastOutcomeAt ?? null,
    }));
  } catch (err) {
    empty.warnings.push(`aggregate read failed: ${(err as Error).message ?? err}`);
    return empty;
  }
  if (aggregates.length === 0) return empty;

  // 2. Window — CourierPerformance has no firstOutcomeAt, so use a fixed
  // 90-day window. Operators that need a tighter window run the
  // reconciler with a future-dated `now` against a fixed point in
  // history. We intentionally don't introduce a new schema field.
  const unionWindowStart = new Date(now.getTime() - DEFAULT_WINDOW_MS);

  // 3. Bounded order scan.
  const scan = await scanTerminalOrders({
    merchantId: merchantOid,
    scanLimit: Math.min(safeNum(input.scanLimit) || MAX_RECONCILE_SCAN, MAX_RECONCILE_SCAN),
    unionWindowStart,
    now,
    courierFilter: input.courier ?? null,
  });

  // 4. Bucket per (courier, district) AND track per-courier totals for the
  // _GLOBAL_ row comparison.
  type Bucket = ReconcileCounters;
  const perDistrict = new Map<string, Bucket>();
  const perCourierTotals = new Map<string, Bucket>();

  const ensure = (m: Map<string, Bucket>, k: string): Bucket => {
    let b = m.get(k);
    if (!b) {
      b = emptyCounters();
      m.set(k, b);
    }
    return b;
  };

  for (const obs of scan.observations) {
    if (!obs.courier) continue;
    if (input.courier && obs.courier !== input.courier.toLowerCase()) continue;
    if (obs.district) {
      const bucket = ensure(perDistrict, `${obs.courier}|${obs.district}`);
      bumpCounter(bucket, obs.status);
    }
    const totalsBucket = ensure(perCourierTotals, obs.courier);
    bumpCounter(totalsBucket, obs.status);
  }

  // 5. Drift compare — per district AND per _GLOBAL_ row.
  const entries: ReconcileKeyDrift[] = [];
  for (const agg of aggregates) {
    const isGlobal = agg.district === COURIER_PERF_GLOBAL_DISTRICT;
    const expectedBucket = isGlobal
      ? perCourierTotals.get(agg.courier) ?? emptyCounters()
      : perDistrict.get(`${agg.courier}|${agg.district}`) ?? emptyCounters();

    const aggregateCounters: ReconcileCounters = {
      delivered: agg.delivered,
      rto: agg.rto,
      cancelled: agg.cancelled,
    };
    const drift = counterDiff(expectedBucket, aggregateCounters);
    const sampleSize =
      expectedBucket.delivered + expectedBucket.rto + expectedBucket.cancelled;
    entries.push({
      axis: "courier_performance",
      key: `${agg.courier}|${agg.district}`,
      exists: true,
      aggregate: aggregateCounters,
      expected: expectedBucket,
      drift,
      driftMagnitude: magnitude(drift),
      windowStart: unionWindowStart,
      sampleSize,
    });
  }

  const driftedKeys = entries
    .filter((e) => e.driftMagnitude > DRIFT_TOLERANCE)
    .map((e) => e.key);

  return {
    merchantId: merchantOid.toHexString(),
    axis: "courier_performance",
    generatedAt: now,
    entries,
    driftedKeys,
    ordersScanned: scan.scanned,
    truncated: scan.truncated,
    warnings: scan.warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* CourierLane reconciliation                                                 */
/* -------------------------------------------------------------------------- */

export interface ReconcileCourierLaneInput {
  merchantId: Types.ObjectId | string;
  courier?: string;
  scanLimit?: number;
  now?: Date;
}

export async function reconcileCourierLaneSlice(
  input: ReconcileCourierLaneInput,
): Promise<ReconcileSliceResult> {
  const merchantOid = safeMerchantOid(input.merchantId);
  const now =
    input.now instanceof Date && Number.isFinite(input.now.getTime())
      ? input.now
      : new Date();
  const empty: ReconcileSliceResult = {
    merchantId: merchantOid?.toHexString() ?? String(input.merchantId ?? ""),
    axis: "courier_lane",
    generatedAt: now,
    entries: [],
    driftedKeys: [],
    ordersScanned: 0,
    truncated: false,
    warnings: [],
  };
  if (!merchantOid) {
    empty.warnings.push("invalid merchantId");
    return empty;
  }

  const aggregateFilter: Record<string, unknown> = { merchantId: merchantOid };
  if (input.courier) {
    aggregateFilter.courier = input.courier.toLowerCase();
  }
  let aggregates: Array<{
    courier: string;
    district: string;
    thana: string;
    delivered: number;
    rto: number;
    cancelled: number;
    firstOutcomeAt: Date | null;
  }> = [];
  try {
    const rows = await CourierLane.find(aggregateFilter)
      .select(
        "courier district thana deliveredCount rtoCount cancelledCount firstOutcomeAt",
      )
      .lean()
      .exec();
    aggregates = rows.map((r) => ({
      courier: r.courier,
      district: r.district,
      thana: r.thana,
      delivered: safeNum(r.deliveredCount),
      rto: safeNum(r.rtoCount),
      cancelled: safeNum(r.cancelledCount),
      firstOutcomeAt: r.firstOutcomeAt ?? null,
    }));
  } catch (err) {
    empty.warnings.push(`aggregate read failed: ${(err as Error).message ?? err}`);
    return empty;
  }
  if (aggregates.length === 0) return empty;

  // Union window — earliest firstOutcomeAt across selected lane rows.
  let unionWindowStart: Date | null = null;
  for (const a of aggregates) {
    if (a.firstOutcomeAt instanceof Date) {
      if (!unionWindowStart || a.firstOutcomeAt < unionWindowStart) {
        unionWindowStart = a.firstOutcomeAt;
      }
    }
  }
  if (!unionWindowStart) {
    unionWindowStart = new Date(now.getTime() - DEFAULT_WINDOW_MS);
  }

  const scan = await scanTerminalOrders({
    merchantId: merchantOid,
    scanLimit: Math.min(safeNum(input.scanLimit) || MAX_RECONCILE_SCAN, MAX_RECONCILE_SCAN),
    unionWindowStart,
    now,
    courierFilter: input.courier ?? null,
  });

  // Per-aggregate scoring. Each lane row uses its own firstOutcomeAt
  // window to avoid counting orders that landed before the lane was
  // first observed.
  const entries: ReconcileKeyDrift[] = [];
  for (const agg of aggregates) {
    const windowStart = agg.firstOutcomeAt ?? unionWindowStart;
    const expected = emptyCounters();
    let sampleSize = 0;
    for (const obs of scan.observations) {
      if (obs.courier !== agg.courier) continue;
      if (obs.district !== agg.district) continue;
      if (!obs.thana || obs.thana !== agg.thana) continue;
      if (obs.terminalMs < windowStart.getTime()) continue;
      bumpCounter(expected, obs.status);
      sampleSize += 1;
    }
    const aggregateCounters: ReconcileCounters = {
      delivered: agg.delivered,
      rto: agg.rto,
      cancelled: agg.cancelled,
    };
    const drift = counterDiff(expected, aggregateCounters);
    entries.push({
      axis: "courier_lane",
      key: `${agg.courier}|${agg.district}|${agg.thana}`,
      exists: true,
      aggregate: aggregateCounters,
      expected,
      drift,
      driftMagnitude: magnitude(drift),
      windowStart,
      sampleSize,
    });
  }

  const driftedKeys = entries
    .filter((e) => e.driftMagnitude > DRIFT_TOLERANCE)
    .map((e) => e.key);

  return {
    merchantId: merchantOid.toHexString(),
    axis: "courier_lane",
    generatedAt: now,
    entries,
    driftedKeys,
    ordersScanned: scan.scanned,
    truncated: scan.truncated,
    warnings: scan.warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* AreaReliability reconciliation                                             */
/* -------------------------------------------------------------------------- */

export interface ReconcileAreaReliabilityInput {
  merchantId: Types.ObjectId | string;
  scanLimit?: number;
  now?: Date;
}

export async function reconcileAreaReliabilitySlice(
  input: ReconcileAreaReliabilityInput,
): Promise<ReconcileSliceResult> {
  const merchantOid = safeMerchantOid(input.merchantId);
  const now =
    input.now instanceof Date && Number.isFinite(input.now.getTime())
      ? input.now
      : new Date();
  const empty: ReconcileSliceResult = {
    merchantId: merchantOid?.toHexString() ?? String(input.merchantId ?? ""),
    axis: "area_reliability",
    generatedAt: now,
    entries: [],
    driftedKeys: [],
    ordersScanned: 0,
    truncated: false,
    warnings: [],
  };
  if (!merchantOid) {
    empty.warnings.push("invalid merchantId");
    return empty;
  }

  let aggregates: Array<{
    division: string;
    district: string;
    thana: string;
    delivered: number;
    rto: number;
    cancelled: number;
    firstOutcomeAt: Date | null;
  }> = [];
  try {
    const rows = await AreaReliability.find({ merchantId: merchantOid })
      .select(
        "division district thana deliveredCount rtoCount cancelledCount firstOutcomeAt",
      )
      .lean()
      .exec();
    aggregates = rows.map((r) => ({
      division: r.division,
      district: r.district,
      thana: r.thana,
      delivered: safeNum(r.deliveredCount),
      rto: safeNum(r.rtoCount),
      cancelled: safeNum(r.cancelledCount),
      firstOutcomeAt: r.firstOutcomeAt ?? null,
    }));
  } catch (err) {
    empty.warnings.push(`aggregate read failed: ${(err as Error).message ?? err}`);
    return empty;
  }
  if (aggregates.length === 0) return empty;

  let unionWindowStart: Date | null = null;
  for (const a of aggregates) {
    if (a.firstOutcomeAt instanceof Date) {
      if (!unionWindowStart || a.firstOutcomeAt < unionWindowStart) {
        unionWindowStart = a.firstOutcomeAt;
      }
    }
  }
  if (!unionWindowStart) {
    unionWindowStart = new Date(now.getTime() - DEFAULT_WINDOW_MS);
  }

  const scan = await scanTerminalOrders({
    merchantId: merchantOid,
    scanLimit: Math.min(safeNum(input.scanLimit) || MAX_RECONCILE_SCAN, MAX_RECONCILE_SCAN),
    unionWindowStart,
    now,
  });

  const entries: ReconcileKeyDrift[] = [];
  for (const agg of aggregates) {
    const windowStart = agg.firstOutcomeAt ?? unionWindowStart;
    const expected = emptyCounters();
    let sampleSize = 0;
    for (const obs of scan.observations) {
      if (!obs.thana || !obs.district) continue;
      if (obs.thana !== agg.thana) continue;
      if (obs.district !== agg.district) continue;
      // Division: prefer matching when available; if obs.division is
      // null AND agg.division equals district (the chokepoint fallback
      // when canonical didn't resolve a division), match anyway.
      if (
        obs.division &&
        obs.division !== agg.division &&
        agg.division !== agg.district
      ) {
        continue;
      }
      if (obs.terminalMs < windowStart.getTime()) continue;
      bumpCounter(expected, obs.status);
      sampleSize += 1;
    }
    const aggregateCounters: ReconcileCounters = {
      delivered: agg.delivered,
      rto: agg.rto,
      cancelled: agg.cancelled,
    };
    const drift = counterDiff(expected, aggregateCounters);
    entries.push({
      axis: "area_reliability",
      key: `${agg.division}|${agg.district}|${agg.thana}`,
      exists: true,
      aggregate: aggregateCounters,
      expected,
      drift,
      driftMagnitude: magnitude(drift),
      windowStart,
      sampleSize,
    });
  }

  const driftedKeys = entries
    .filter((e) => e.driftMagnitude > DRIFT_TOLERANCE)
    .map((e) => e.key);

  return {
    merchantId: merchantOid.toHexString(),
    axis: "area_reliability",
    generatedAt: now,
    entries,
    driftedKeys,
    ordersScanned: scan.scanned,
    truncated: scan.truncated,
    warnings: scan.warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  MAX_RECONCILE_SCAN,
  DRIFT_TOLERANCE,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_WINDOW_MS,
  terminalAt,
  counterDiff,
  magnitude,
  bumpCounter,
  buildObservations,
};
