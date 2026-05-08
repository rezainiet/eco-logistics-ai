import { Types } from "mongoose";
import {
  AddressReliability,
  CustomerReliability,
  Order,
} from "@ecom/db";
import { hashPhoneForNetwork } from "./fraud-network.js";
import { recordReliabilityOutcome } from "./observability/delivery-reliability.js";

/**
 * delivery-reliability-reconciliation — read-only consistency checker.
 *
 * Compares the per-merchant aggregate row counters
 * (`customer_reliabilities`, `address_reliabilities`) against a
 * recomputed expected count from `Order` over the same key, restricted
 * to the window the aggregate covers (`[aggregate.firstOutcomeAt, now]`).
 *
 * Hard rules (binding):
 *   - PURE READ. No writes to any collection. No queue dispatches. No
 *     replay triggers. No mutations of any kind.
 *   - Bounded. Per-merchant terminal-order scan capped at
 *     `MAX_RECONCILE_SCAN` (default 10000). The cap protects against
 *     pathological merchant cohorts; merchants over the cap surface a
 *     `truncated: true` warning so operators know the report is partial.
 *   - Window-aware. The reconciler only counts Orders whose terminal-
 *     transition time falls inside `[aggregate.firstOutcomeAt, now]`.
 *     Pre-flag terminal orders are NOT expected to be in the aggregate
 *     and are therefore NOT counted as drift.
 *   - Defensive. Any per-row computation failure is logged and skipped;
 *     never throws back to the caller.
 *
 * What this module does NOT do:
 *   - Repair the aggregate (see `delivery-reliability-repair.ts`).
 *   - Trigger a backfill (out of v1 scope).
 *   - Recompute via the chokepoint (would mutate side-effects).
 *   - Modify Order or any other collection.
 *
 * Used by:
 *   - `apps/api/src/scripts/reconcileDeliveryReliability.ts` — CLI.
 *   - `apps/api/src/lib/delivery-reliability-repair.ts` — supplies the
 *     "expected" totals the repair engine writes via `$set`.
 *   - The admin tRPC `deliveryReliabilityDriftSample` procedure.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type ReliabilityAxis = "customer" | "address";

export interface ReliabilityCounters {
  delivered: number;
  rto: number;
  cancelled: number;
}

export interface ReliabilityKeyDrift {
  axis: ReliabilityAxis;
  hashKey: string;
  exists: boolean;
  /** Counters as currently recorded on the aggregate row (or zeros if absent). */
  aggregate: ReliabilityCounters;
  /** Counters recomputed from `Order` over the aggregate's anchor window. */
  expected: ReliabilityCounters;
  /** `expected - aggregate` per axis. Positive = aggregate is missing observations. */
  drift: ReliabilityCounters;
  /** Total drift magnitude (sum of absolute per-counter differences). */
  driftMagnitude: number;
  /** Lower bound of the recompute window — `aggregate.firstOutcomeAt`. */
  windowStart: Date | null;
  /** Number of Orders inspected for this key. */
  sampleSize: number;
}

export interface ReconcileSliceResult {
  merchantId: string;
  axis: ReliabilityAxis;
  generatedAt: Date;
  /** Drift entries — one per aggregate key inspected. */
  entries: ReliabilityKeyDrift[];
  /** Aggregates with non-zero `driftMagnitude`. */
  driftedKeys: string[];
  /** Aggregates with `exists: false` AND non-zero `expected` — the chokepoint
   *  missed observations. */
  missingKeys: string[];
  /** Total Order rows scanned. */
  ordersScanned: number;
  /** True when the per-merchant Order scan hit the bounded cap. */
  truncated: boolean;
  /** Warnings (non-fatal). */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** Per-merchant terminal-order scan cap. Protects production from runaway
 *  scans during admin-triggered reconciliation runs. Operators override via
 *  the CLI if a merchant genuinely has a larger terminal cohort. */
export const MAX_RECONCILE_SCAN = 10_000;

/** Drift tolerance (absolute) below which a key is considered "in sync".
 *  Mirrors the integrity tolerance from S5. */
export const DRIFT_TOLERANCE = 2;

/** Window-bound floor for keys whose aggregate has no `firstOutcomeAt` yet
 *  (defensive — reachable only on legacy / corrupted rows). */
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

function emptyCounters(): ReliabilityCounters {
  return { delivered: 0, rto: 0, cancelled: 0 };
}

interface OrderLeanRow {
  _id?: Types.ObjectId;
  customer?: { phone?: string };
  source?: { addressHash?: string };
  order?: { status?: string };
  logistics?: { deliveredAt?: Date | null; returnedAt?: Date | null };
  updatedAt?: Date;
}

/** Resolve the canonical "terminal moment" for an order — used to gate
 *  reconciliation by the aggregate's `firstOutcomeAt` window. */
function terminalAt(o: OrderLeanRow): Date | null {
  const status = o.order?.status;
  if (status === "delivered") {
    return o.logistics?.deliveredAt ?? o.updatedAt ?? null;
  }
  if (status === "rto") {
    return o.logistics?.returnedAt ?? o.updatedAt ?? null;
  }
  if (status === "cancelled") {
    return o.updatedAt ?? null;
  }
  return null;
}

function bumpCounter(c: ReliabilityCounters, status: string): void {
  if (status === "delivered") c.delivered += 1;
  else if (status === "rto") c.rto += 1;
  else if (status === "cancelled") c.cancelled += 1;
}

function counterDiff(
  expected: ReliabilityCounters,
  aggregate: ReliabilityCounters,
): ReliabilityCounters {
  return {
    delivered: expected.delivered - aggregate.delivered,
    rto: expected.rto - aggregate.rto,
    cancelled: expected.cancelled - aggregate.cancelled,
  };
}

function magnitude(c: ReliabilityCounters): number {
  return Math.abs(c.delivered) + Math.abs(c.rto) + Math.abs(c.cancelled);
}

/* -------------------------------------------------------------------------- */
/* Slice reconciliation                                                       */
/* -------------------------------------------------------------------------- */

export interface ReconcileSliceInput {
  merchantId: Types.ObjectId | string;
  axis: ReliabilityAxis;
  /** Cap on the order scan size. Defaults to `MAX_RECONCILE_SCAN`. */
  scanLimit?: number;
  /** Reference time. Defaults to `new Date()`. Injectable for tests. */
  now?: Date;
  /** Optional single-key filter — only the matching aggregate is reconciled. */
  hashKey?: string;
}

/**
 * Reconcile every aggregate row for a merchant on the chosen axis.
 *
 * Algorithm:
 *   1. Load all aggregate rows for the merchant on `axis`.
 *   2. Determine the union window — earliest `firstOutcomeAt` across all rows.
 *   3. Pull bounded terminal Orders for the merchant whose terminal moment
 *      falls in `[unionWindowStart, now]`.
 *   4. In JS, hash each Order's relevant key (phone for customer, addressHash
 *      for address) and bucket into `expected` per (key, status).
 *   5. For each aggregate row, compute `drift = expected - aggregate` over
 *      the row's individual `firstOutcomeAt` window.
 */
export async function reconcileSlice(
  input: ReconcileSliceInput,
): Promise<ReconcileSliceResult> {
  const merchantOid = safeMerchantOid(input.merchantId);
  const axis = input.axis === "address" ? "address" : "customer";
  const now = input.now instanceof Date && Number.isFinite(input.now.getTime())
    ? input.now
    : new Date();
  const generatedAt = now;
  const warnings: string[] = [];

  const empty: ReconcileSliceResult = {
    merchantId: merchantOid?.toHexString() ?? String(input.merchantId ?? ""),
    axis,
    generatedAt,
    entries: [],
    driftedKeys: [],
    missingKeys: [],
    ordersScanned: 0,
    truncated: false,
    warnings,
  };
  if (!merchantOid) {
    warnings.push("invalid merchantId");
    return empty;
  }

  // 1. Load aggregates.
  let aggregates: Array<{
    hashKey: string;
    delivered: number;
    rto: number;
    cancelled: number;
    firstOutcomeAt: Date | null;
  }> = [];
  try {
    if (axis === "customer") {
      const filter: Record<string, unknown> = { merchantId: merchantOid };
      if (input.hashKey) filter.phoneHash = input.hashKey;
      const rows = await CustomerReliability.find(filter)
        .select("phoneHash deliveredCount rtoCount cancelledCount firstOutcomeAt")
        .lean()
        .exec();
      aggregates = rows.map((r) => ({
        hashKey: r.phoneHash,
        delivered: safeNum(r.deliveredCount),
        rto: safeNum(r.rtoCount),
        cancelled: safeNum(r.cancelledCount),
        firstOutcomeAt: r.firstOutcomeAt ?? null,
      }));
    } else {
      const filter: Record<string, unknown> = { merchantId: merchantOid };
      if (input.hashKey) filter.addressHash = input.hashKey;
      const rows = await AddressReliability.find(filter)
        .select(
          "addressHash deliveredCount rtoCount cancelledCount firstOutcomeAt",
        )
        .lean()
        .exec();
      aggregates = rows.map((r) => ({
        hashKey: r.addressHash,
        delivered: safeNum(r.deliveredCount),
        rto: safeNum(r.rtoCount),
        cancelled: safeNum(r.cancelledCount),
        firstOutcomeAt: r.firstOutcomeAt ?? null,
      }));
    }
  } catch (err) {
    warnings.push(`aggregate read failed: ${(err as Error).message ?? err}`);
    return empty;
  }

  if (aggregates.length === 0 && !input.hashKey) {
    return empty;
  }

  // 2. Union window — earliest firstOutcomeAt across selected aggregates.
  let unionWindowStart: Date | null = null;
  for (const a of aggregates) {
    if (a.firstOutcomeAt instanceof Date) {
      if (!unionWindowStart || a.firstOutcomeAt < unionWindowStart) {
        unionWindowStart = a.firstOutcomeAt;
      }
    }
  }
  // Fallback when every aggregate lacks firstOutcomeAt (defensive). Use
  // a 90-day window so we still produce a meaningful report.
  if (!unionWindowStart) {
    unionWindowStart = new Date(now.getTime() - DEFAULT_WINDOW_MS);
    if (aggregates.length > 0) {
      warnings.push("no firstOutcomeAt anchor across aggregates — using 90d fallback window");
    }
  }

  // Single-key reconciliation: even if no aggregate exists, scan to detect
  // missing aggregate (chokepoint missed all writes for this key).
  const aggregateByHash = new Map(aggregates.map((a) => [a.hashKey, a]));

  // 3. Bounded scan over terminal Orders for the merchant.
  const scanLimit = Math.max(
    1,
    Math.min(safeNum(input.scanLimit) || MAX_RECONCILE_SCAN, MAX_RECONCILE_SCAN),
  );
  let orders: OrderLeanRow[] = [];
  try {
    orders = (await Order.find({
      merchantId: merchantOid,
      "order.status": { $in: ["delivered", "rto", "cancelled"] },
    })
      .select(
        "customer.phone source.addressHash order.status logistics.deliveredAt logistics.returnedAt updatedAt",
      )
      .limit(scanLimit + 1)
      .lean()
      .exec()) as OrderLeanRow[];
  } catch (err) {
    warnings.push(`order scan failed: ${(err as Error).message ?? err}`);
    return empty;
  }
  const truncated = orders.length > scanLimit;
  if (truncated) {
    orders = orders.slice(0, scanLimit);
    warnings.push(`order scan capped at ${scanLimit}; results may be partial`);
  }

  // 4. Build per-(hashKey, window) expected counters.
  // We accumulate UNION expected counts in a single pass; the window check is
  // applied per-aggregate in step 5 to honour each aggregate's own anchor.
  type ExpectedBucket = { delivered: number; rto: number; cancelled: number; samples: number };
  const expectedByKey = new Map<string, Map<string, ExpectedBucket>>(); // hashKey → terminalMs-bucket
  // Simpler: just accumulate per hashKey, track the orders' terminalAt so we
  // can re-apply individual aggregate windows at scoring time.
  type RawObservation = { hashKey: string; status: string; terminalMs: number };
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

    let hashKey: string | null = null;
    if (axis === "customer") {
      hashKey = hashPhoneForNetwork(o.customer?.phone);
    } else {
      const addr = o.source?.addressHash;
      hashKey = typeof addr === "string" && addr.length > 0 ? addr : null;
    }
    if (!hashKey) continue;
    observations.push({ hashKey, status, terminalMs });
  }

  // 5. Per-aggregate, score expected counters using the row's individual window.
  const entries: ReliabilityKeyDrift[] = [];
  const seen = new Set<string>();

  for (const agg of aggregates) {
    seen.add(agg.hashKey);
    const windowStart = agg.firstOutcomeAt ?? unionWindowStart;
    const expected = emptyCounters();
    let sampleSize = 0;
    for (const obs of observations) {
      if (obs.hashKey !== agg.hashKey) continue;
      if (obs.terminalMs < windowStart.getTime()) continue;
      bumpCounter(expected, obs.status);
      sampleSize += 1;
    }
    const aggregateCounters: ReliabilityCounters = {
      delivered: agg.delivered,
      rto: agg.rto,
      cancelled: agg.cancelled,
    };
    const drift = counterDiff(expected, aggregateCounters);
    entries.push({
      axis,
      hashKey: agg.hashKey,
      exists: true,
      aggregate: aggregateCounters,
      expected,
      drift,
      driftMagnitude: magnitude(drift),
      windowStart,
      sampleSize,
    });
  }

  // 5b. Detect MISSING aggregates — orders observed for a key with no
  // aggregate row at all. (Single-key mode only — the union scan would
  // surface noise for full-merchant scans.)
  if (input.hashKey && !seen.has(input.hashKey)) {
    const expected = emptyCounters();
    let sampleSize = 0;
    for (const obs of observations) {
      if (obs.hashKey !== input.hashKey) continue;
      bumpCounter(expected, obs.status);
      sampleSize += 1;
    }
    if (magnitude(expected) > 0) {
      entries.push({
        axis,
        hashKey: input.hashKey,
        exists: false,
        aggregate: emptyCounters(),
        expected,
        drift: expected,
        driftMagnitude: magnitude(expected),
        windowStart: unionWindowStart,
        sampleSize,
      });
    }
  }

  const driftedKeys = entries
    .filter((e) => e.driftMagnitude > DRIFT_TOLERANCE && e.exists)
    .map((e) => e.hashKey);
  const missingKeys = entries.filter((e) => !e.exists).map((e) => e.hashKey);

  // Observability — bump `drift_detected` once per reconciler run that
  // surfaced any drift-above-tolerance OR any missing aggregate. The
  // runbook §4 instructs operators to watch `observabilityCounters
  // .driftDetected` as a defect signal; this is the single emit-point.
  // Emit-on-detect is single-shot per slice (not per-key) so a noisy
  // merchant cohort doesn't flood the structured-log stream.
  if (driftedKeys.length > 0 || missingKeys.length > 0) {
    recordReliabilityOutcome({
      event: "drift_detected",
      merchantId: merchantOid.toHexString(),
      axis,
      reason: missingKeys.length > 0 ? "missing_aggregate" : "counter_drift",
      meta: {
        drifted: driftedKeys.length,
        missing: missingKeys.length,
        ordersScanned: scanned,
        truncated,
      },
    });
  }

  return {
    merchantId: merchantOid.toHexString(),
    axis,
    generatedAt,
    entries,
    driftedKeys,
    missingKeys,
    ordersScanned: scanned,
    truncated,
    warnings,
  };
}

/**
 * Single-key convenience over `reconcileSlice` — used by the repair tooling
 * to fetch the expected counters for one key.
 */
export async function reconcileKey(args: {
  merchantId: Types.ObjectId | string;
  axis: ReliabilityAxis;
  hashKey: string;
  scanLimit?: number;
  now?: Date;
}): Promise<ReliabilityKeyDrift | null> {
  const slice = await reconcileSlice({
    merchantId: args.merchantId,
    axis: args.axis,
    hashKey: args.hashKey,
    scanLimit: args.scanLimit,
    now: args.now,
  });
  if (slice.entries.length === 0) return null;
  return slice.entries[0]!;
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
};
