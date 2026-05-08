import { Types } from "mongoose";
import {
  AddressReliability,
  COURIER_PERF_GLOBAL_DISTRICT,
  CourierPerformance,
  CustomerReliability,
} from "@ecom/db";
import { snapshotReliabilityCounters } from "./observability/delivery-reliability.js";

/**
 * delivery-reliability-analytics — bounded, merchant-scoped read-only
 * summary helpers for the Delivery Reliability layer (S7).
 *
 * Every helper:
 *   - is merchant-scoped (every Mongo query starts with `merchantId` and
 *     hits the unique compound index on its target collection)
 *   - is bounded (per-merchant scan capped via `.limit(MAX_SCAN)`)
 *   - never aggregates over `Order` (forbidden by S7 spec)
 *   - never writes anywhere (read-only by construction)
 *   - never throws — failures degrade to empty/zeroed results
 *
 * Tier-classification at this layer is INTENTIONALLY simpler than the
 * full `classifyDeliveryReliability` pure function: it scores each row
 * by raw `deliveredCount / total` only. Reasoning:
 *
 *   - The summary surface answers "across my customers / addresses, how
 *     reliable is the cohort?" The full classifier needs cross-axis
 *     joins (customer × address × courier × address-quality) which would
 *     turn the summary into an N×3 fanout over the whole row set.
 *   - The simpler bucketing is honest: a buyer with 9 deliveries and 1
 *     RTO sits at score=90 (verified band) under both the simple and
 *     full classifier. The cases that diverge involve cross-axis
 *     evidence that doesn't apply at the merchant-level summary
 *     granularity.
 *   - The full classifier remains the canonical per-order signal — used
 *     in `loadDeliveryReliability` (S6). The analytics layer is the
 *     cohort view.
 *
 * Tier thresholds mirror the classifier (`>=70 verified`, `>=40 implicit`,
 * `<40 unverified`, `<MIN_OBSERVATIONS no_data`) so the badge colours line
 * up between the order-detail drawer and the merchant dashboard.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type ReliabilityTier = "verified" | "implicit" | "unverified" | "no_data";

export interface ReliabilitySummaryResult {
  totals: {
    verified: number;
    implicit: number;
    unverified: number;
    noData: number;
  };
  averageScore: number;
  stalePercentage: number;
  sampleSize: number;
  generatedAt: Date;
}

export interface ReliabilityScoreBucket {
  range: string;
  /** Inclusive lower bound. */
  from: number;
  /** Exclusive upper bound except for the top bucket which is inclusive. */
  to: number;
  count: number;
}

export interface ReliabilityDistributionResult {
  axis: "customer" | "address";
  totals: ReliabilitySummaryResult["totals"];
  buckets: ReliabilityScoreBucket[];
  staleCount: number;
  freshCount: number;
  sampleSize: number;
  generatedAt: Date;
}

export interface CourierReliabilityRow {
  courier: string;
  observations: number;
  deliveredCount: number;
  rtoCount: number;
  cancelledCount: number;
  deliveredRate: number;
  rtoRate: number;
  avgDeliveryHours: number | null;
  coldStart: boolean;
  stale: boolean;
}

export interface CourierReliabilityOverviewResult {
  rows: CourierReliabilityRow[];
  topPerformers: string[];
  underperformers: string[];
  generatedAt: Date;
}

export interface ReliabilityHealthSnapshotResult {
  aggregateCounts: {
    customerRows: number;
    addressRows: number;
    courierRows: number;
  };
  staleAggregatePercentage: {
    customer: number;
    address: number;
    courier: number;
  };
  observabilityCounters: ReturnType<typeof snapshotReliabilityCounters>;
  generatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const MIN_OBSERVATIONS_FOR_TIER = 3;
const VERIFIED_THRESHOLD = 70;
const IMPLICIT_THRESHOLD = 40;
const STALE_DAYS = 180;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const COURIER_COLD_START_OBSERVATIONS = 10;
const COURIER_STRONG_DELIVERED_RATE = 0.85;
const COURIER_WEAK_RTO_RATE = 0.2;

/** Bounded scan cap per analytics call. Protects merchants with a long tail
 *  of unique customers from a runaway query. The cap is generous enough
 *  for typical merchant cohorts (5–10k active customers); merchants with
 *  larger tails will see a representative sample, not all rows. */
export const ANALYTICS_MAX_SCAN = 5000;

/** Score buckets for the distribution surface. Inclusive lower bound;
 *  upper bound is exclusive except for the top bucket. */
const SCORE_BUCKETS: Array<{ range: string; from: number; to: number }> = [
  { range: "0-19", from: 0, to: 20 },
  { range: "20-39", from: 20, to: 40 },
  { range: "40-59", from: 40, to: 60 },
  { range: "60-79", from: 60, to: 80 },
  { range: "80-100", from: 80, to: 101 },
];

/* -------------------------------------------------------------------------- */
/* Defensive helpers                                                          */
/* -------------------------------------------------------------------------- */

function safeMerchantOid(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  if (value == null) return null;
  try {
    const s = typeof value === "string" ? value : String(value);
    if (!Types.ObjectId.isValid(s)) return null;
    return new Types.ObjectId(s);
  } catch {
    return null;
  }
}

function safeNum(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return v;
}

function safeNow(value: Date | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  return new Date();
}

function isStale(lastOutcomeAt: Date | null | undefined, now: Date): boolean {
  if (!(lastOutcomeAt instanceof Date)) return false;
  const t = lastOutcomeAt.getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t > STALE_MS;
}

function rowScore(delivered: number, total: number): number {
  if (total <= 0) return 0;
  const raw = (delivered / total) * 100;
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return raw;
}

function tierFor(total: number, score: number): ReliabilityTier {
  if (total < MIN_OBSERVATIONS_FOR_TIER) return "no_data";
  if (score >= VERIFIED_THRESHOLD) return "verified";
  if (score >= IMPLICIT_THRESHOLD) return "implicit";
  return "unverified";
}

function bucketIndexFor(score: number): number {
  for (let i = 0; i < SCORE_BUCKETS.length; i++) {
    const b = SCORE_BUCKETS[i]!;
    if (score >= b.from && score < b.to) return i;
  }
  return SCORE_BUCKETS.length - 1;
}

function emptyTotals(): ReliabilitySummaryResult["totals"] {
  return { verified: 0, implicit: 0, unverified: 0, noData: 0 };
}

function bumpTotals(
  totals: ReliabilitySummaryResult["totals"],
  tier: ReliabilityTier,
): void {
  // Tier "no_data" maps to the camelCase `noData` totals key — explicit
  // switch keeps the type-safe property access through the totals shape.
  switch (tier) {
    case "verified":
      totals.verified += 1;
      break;
    case "implicit":
      totals.implicit += 1;
      break;
    case "unverified":
      totals.unverified += 1;
      break;
    case "no_data":
      totals.noData += 1;
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Customer / Address row shapes (lean reads only)                            */
/* -------------------------------------------------------------------------- */

interface CustomerOrAddressLeanRow {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  lastOutcomeAt?: Date | null;
}

interface CourierLeanRow {
  courier?: string;
  district?: string;
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  totalDeliveryHours?: number;
  lastOutcomeAt?: Date | null;
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

export async function loadReliabilitySummary(args: {
  merchantId: Types.ObjectId | string;
  axis?: "customer" | "address";
  now?: Date;
}): Promise<ReliabilitySummaryResult> {
  const merchantOid = safeMerchantOid(args.merchantId);
  const now = safeNow(args.now);
  const generatedAt = now;
  if (!merchantOid) {
    return {
      totals: emptyTotals(),
      averageScore: 0,
      stalePercentage: 0,
      sampleSize: 0,
      generatedAt,
    };
  }
  let rows: CustomerOrAddressLeanRow[] = [];
  try {
    const cursor =
      args.axis === "address"
        ? AddressReliability.find({ merchantId: merchantOid })
            .select("deliveredCount rtoCount cancelledCount lastOutcomeAt")
            .limit(ANALYTICS_MAX_SCAN)
            .lean()
            .exec()
        : CustomerReliability.find({ merchantId: merchantOid })
            .select("deliveredCount rtoCount cancelledCount lastOutcomeAt")
            .limit(ANALYTICS_MAX_SCAN)
            .lean()
            .exec();
    rows = (await cursor) as unknown as CustomerOrAddressLeanRow[];
  } catch {
    rows = [];
  }

  const totals = emptyTotals();
  let totalScore = 0;
  let staleCount = 0;
  let withScore = 0;

  for (const r of rows) {
    const delivered = safeNum(r.deliveredCount);
    const rto = safeNum(r.rtoCount);
    const cancelled = safeNum(r.cancelledCount);
    const total = delivered + rto + cancelled;
    const score = rowScore(delivered, total);
    const tier = tierFor(total, score);
    bumpTotals(totals, tier);
    if (tier !== "no_data") {
      totalScore += score;
      withScore += 1;
    }
    if (isStale(r.lastOutcomeAt ?? null, now)) staleCount += 1;
  }

  const sampleSize = rows.length;
  const averageScore = withScore > 0 ? totalScore / withScore : 0;
  const stalePercentage = sampleSize > 0 ? staleCount / sampleSize : 0;

  return {
    totals,
    averageScore,
    stalePercentage,
    sampleSize,
    generatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Distribution                                                               */
/* -------------------------------------------------------------------------- */

export async function loadReliabilityDistribution(args: {
  merchantId: Types.ObjectId | string;
  axis?: "customer" | "address";
  now?: Date;
}): Promise<ReliabilityDistributionResult> {
  const merchantOid = safeMerchantOid(args.merchantId);
  const now = safeNow(args.now);
  const axis: "customer" | "address" = args.axis === "address" ? "address" : "customer";
  const generatedAt = now;
  const buckets: ReliabilityScoreBucket[] = SCORE_BUCKETS.map((b) => ({
    ...b,
    count: 0,
  }));
  if (!merchantOid) {
    return {
      axis,
      totals: emptyTotals(),
      buckets,
      staleCount: 0,
      freshCount: 0,
      sampleSize: 0,
      generatedAt,
    };
  }
  let rows: CustomerOrAddressLeanRow[] = [];
  try {
    const cursor =
      axis === "address"
        ? AddressReliability.find({ merchantId: merchantOid })
            .select("deliveredCount rtoCount cancelledCount lastOutcomeAt")
            .limit(ANALYTICS_MAX_SCAN)
            .lean()
            .exec()
        : CustomerReliability.find({ merchantId: merchantOid })
            .select("deliveredCount rtoCount cancelledCount lastOutcomeAt")
            .limit(ANALYTICS_MAX_SCAN)
            .lean()
            .exec();
    rows = (await cursor) as unknown as CustomerOrAddressLeanRow[];
  } catch {
    rows = [];
  }

  const totals = emptyTotals();
  let staleCount = 0;
  for (const r of rows) {
    const delivered = safeNum(r.deliveredCount);
    const total =
      delivered + safeNum(r.rtoCount) + safeNum(r.cancelledCount);
    const score = rowScore(delivered, total);
    const tier = tierFor(total, score);
    bumpTotals(totals, tier);
    if (tier !== "no_data") {
      buckets[bucketIndexFor(score)]!.count += 1;
    }
    if (isStale(r.lastOutcomeAt ?? null, now)) staleCount += 1;
  }

  const sampleSize = rows.length;
  return {
    axis,
    totals,
    buckets,
    staleCount,
    freshCount: sampleSize - staleCount,
    sampleSize,
    generatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Courier overview                                                           */
/* -------------------------------------------------------------------------- */

export async function loadCourierReliabilityOverview(args: {
  merchantId: Types.ObjectId | string;
  now?: Date;
}): Promise<CourierReliabilityOverviewResult> {
  const merchantOid = safeMerchantOid(args.merchantId);
  const now = safeNow(args.now);
  const generatedAt = now;
  if (!merchantOid) {
    return {
      rows: [],
      topPerformers: [],
      underperformers: [],
      generatedAt,
    };
  }

  let raw: CourierLeanRow[] = [];
  try {
    raw = (await CourierPerformance.find({ merchantId: merchantOid })
      .select(
        "courier district deliveredCount rtoCount cancelledCount totalDeliveryHours lastOutcomeAt",
      )
      .limit(ANALYTICS_MAX_SCAN)
      .lean()
      .exec()) as CourierLeanRow[];
  } catch {
    raw = [];
  }

  // Group by courier — district + global rows merge into a single per-courier
  // row so the merchant sees one number per courier even when both
  // granularities exist. Mirrors the existing analytics.getCourierPerformance
  // surface (which groups by `logistics.courier` from the Order side).
  type Bucket = {
    courier: string;
    delivered: number;
    rto: number;
    cancelled: number;
    totalDeliveryHours: number;
    lastOutcomeAt: Date | null;
  };
  const byCourier = new Map<string, Bucket>();
  for (const r of raw) {
    const courier = typeof r.courier === "string" && r.courier.length > 0
      ? r.courier
      : "unknown";
    // Skip the _GLOBAL_ rows individually — they're already merged into
    // the per-courier total below since both rows share the same `courier`.
    let b = byCourier.get(courier);
    if (!b) {
      b = {
        courier,
        delivered: 0,
        rto: 0,
        cancelled: 0,
        totalDeliveryHours: 0,
        lastOutcomeAt: null,
      };
      byCourier.set(courier, b);
    }
    // Only count the GLOBAL aggregate (which is the merchant-wide total)
    // OR sum-by-courier if no global exists. Avoid double-counting district
    // + global. Strategy: prefer global for the courier when present, else
    // sum districts.
    void r.district;
    // Track the latest lastOutcomeAt across district + global rows.
    if (r.lastOutcomeAt instanceof Date) {
      if (!b.lastOutcomeAt || r.lastOutcomeAt > b.lastOutcomeAt) {
        b.lastOutcomeAt = r.lastOutcomeAt;
      }
    }
  }

  // Second pass: per courier, choose either the GLOBAL row's counters OR
  // the sum across non-GLOBAL rows. GLOBAL is preferred when it exists
  // because the writer keeps it as the authoritative merchant-wide aggregate.
  const globalByCourier = new Map<string, CourierLeanRow>();
  const districtsByCourier = new Map<string, CourierLeanRow[]>();
  for (const r of raw) {
    const courier = typeof r.courier === "string" && r.courier.length > 0
      ? r.courier
      : "unknown";
    if (r.district === COURIER_PERF_GLOBAL_DISTRICT) {
      globalByCourier.set(courier, r);
    } else {
      const arr = districtsByCourier.get(courier) ?? [];
      arr.push(r);
      districtsByCourier.set(courier, arr);
    }
  }

  for (const [courier, b] of byCourier) {
    const globalRow = globalByCourier.get(courier);
    if (globalRow) {
      b.delivered = safeNum(globalRow.deliveredCount);
      b.rto = safeNum(globalRow.rtoCount);
      b.cancelled = safeNum(globalRow.cancelledCount);
      b.totalDeliveryHours = safeNum(globalRow.totalDeliveryHours);
    } else {
      // Sum across district rows.
      for (const r of districtsByCourier.get(courier) ?? []) {
        b.delivered += safeNum(r.deliveredCount);
        b.rto += safeNum(r.rtoCount);
        b.cancelled += safeNum(r.cancelledCount);
        b.totalDeliveryHours += safeNum(r.totalDeliveryHours);
      }
    }
  }

  const rows: CourierReliabilityRow[] = [];
  for (const b of byCourier.values()) {
    const observations = b.delivered + b.rto + b.cancelled;
    const completed = b.delivered + b.rto;
    const deliveredRate = completed > 0 ? b.delivered / completed : 0;
    const rtoRate = completed > 0 ? b.rto / completed : 0;
    const avgDeliveryHours =
      b.delivered > 0 && b.totalDeliveryHours > 0
        ? b.totalDeliveryHours / b.delivered
        : null;
    rows.push({
      courier: b.courier,
      observations,
      deliveredCount: b.delivered,
      rtoCount: b.rto,
      cancelledCount: b.cancelled,
      deliveredRate,
      rtoRate,
      avgDeliveryHours,
      coldStart: observations < COURIER_COLD_START_OBSERVATIONS,
      stale: isStale(b.lastOutcomeAt, now),
    });
  }
  rows.sort((a, b) => b.observations - a.observations);

  const topPerformers = rows
    .filter((r) => !r.coldStart && !r.stale && r.deliveredRate >= COURIER_STRONG_DELIVERED_RATE)
    .map((r) => r.courier);
  const underperformers = rows
    .filter((r) => !r.coldStart && !r.stale && r.rtoRate >= COURIER_WEAK_RTO_RATE)
    .map((r) => r.courier);

  return { rows, topPerformers, underperformers, generatedAt };
}

/* -------------------------------------------------------------------------- */
/* Health snapshot                                                            */
/* -------------------------------------------------------------------------- */

export async function loadReliabilityHealthSnapshot(args: {
  merchantId: Types.ObjectId | string;
  now?: Date;
}): Promise<ReliabilityHealthSnapshotResult> {
  const merchantOid = safeMerchantOid(args.merchantId);
  const now = safeNow(args.now);
  const generatedAt = now;
  const empty: ReliabilityHealthSnapshotResult = {
    aggregateCounts: { customerRows: 0, addressRows: 0, courierRows: 0 },
    staleAggregatePercentage: { customer: 0, address: 0, courier: 0 },
    observabilityCounters: snapshotReliabilityCounters(),
    generatedAt,
  };
  if (!merchantOid) return empty;

  const cutoff = new Date(now.getTime() - STALE_MS);
  const safeCount = async (
    fn: () => Promise<number>,
  ): Promise<number> => {
    try {
      return await fn();
    } catch {
      return 0;
    }
  };

  const [
    customerRows,
    addressRows,
    courierRows,
    customerStale,
    addressStale,
    courierStale,
  ] = await Promise.all([
    safeCount(() => CustomerReliability.countDocuments({ merchantId: merchantOid })),
    safeCount(() => AddressReliability.countDocuments({ merchantId: merchantOid })),
    safeCount(() => CourierPerformance.countDocuments({ merchantId: merchantOid })),
    safeCount(() =>
      CustomerReliability.countDocuments({
        merchantId: merchantOid,
        lastOutcomeAt: { $lte: cutoff },
      }),
    ),
    safeCount(() =>
      AddressReliability.countDocuments({
        merchantId: merchantOid,
        lastOutcomeAt: { $lte: cutoff },
      }),
    ),
    safeCount(() =>
      CourierPerformance.countDocuments({
        merchantId: merchantOid,
        lastOutcomeAt: { $lte: cutoff },
      }),
    ),
  ]);

  return {
    aggregateCounts: { customerRows, addressRows, courierRows },
    staleAggregatePercentage: {
      customer: customerRows > 0 ? customerStale / customerRows : 0,
      address: addressRows > 0 ? addressStale / addressRows : 0,
      courier: courierRows > 0 ? courierStale / courierRows : 0,
    },
    observabilityCounters: snapshotReliabilityCounters(),
    generatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  MIN_OBSERVATIONS_FOR_TIER,
  VERIFIED_THRESHOLD,
  IMPLICIT_THRESHOLD,
  STALE_DAYS,
  STALE_MS,
  COURIER_COLD_START_OBSERVATIONS,
  COURIER_STRONG_DELIVERED_RATE,
  COURIER_WEAK_RTO_RATE,
  ANALYTICS_MAX_SCAN,
  SCORE_BUCKETS,
  rowScore,
  tierFor,
  bucketIndexFor,
  isStale,
};
