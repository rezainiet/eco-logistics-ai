import { Types } from "mongoose";
import {
  AddressReliability,
  CustomerReliability,
} from "@ecom/db";
import {
  reconcileKey,
  reconcileSlice,
  DRIFT_TOLERANCE,
  type ReliabilityAxis,
  type ReliabilityKeyDrift,
  type ReconcileSliceResult,
} from "./delivery-reliability-reconciliation.js";
import { recordReliabilityOutcome } from "./observability/delivery-reliability.js";

/**
 * delivery-reliability-repair — bounded, explicit-invocation aggregate
 * repair tooling.
 *
 * Hard rules (binding):
 *   - **Dry-run by default.** Every entry point requires `dryRun: false`
 *     to actually mutate. The default behavior is to plan + return what
 *     WOULD be written.
 *   - **Bounded scope only.** No global "repair every aggregate" entry
 *     point. Repairs are explicitly scoped to one merchant + one axis +
 *     one key, OR a small slice cap (`MAX_REPAIR_BATCH`).
 *   - **Idempotent writes.** Repair uses `$set` of absolute counter
 *     values (NOT `$inc`) — re-running with the same Order state
 *     produces byte-identical writes.
 *   - **Drift threshold gate.** Repair refuses to mutate a row whose
 *     drift magnitude is below `DRIFT_TOLERANCE` (=2). Catches the case
 *     where a transient race produced a 1-count discrepancy that will
 *     self-heal via the next chokepoint flip.
 *   - **Never enqueues, never replays, never reads/writes Order, never
 *     triggers automation.** Repair only TOUCHES `customer_reliabilities`
 *     and `address_reliabilities` rows that already exist.
 *   - **Emits observability** via `recordReliabilityOutcome("integrity_warning"`)
 *     so every repair attempt is traceable in the structured-log stream.
 *
 * Source of truth: `reconcileKey` / `reconcileSlice` from
 * `delivery-reliability-reconciliation.ts` — the read-only consistency
 * checker. Repair NEVER computes its own expected counters; it consumes
 * the reconciler's output verbatim.
 */

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** Hard cap on slice repair operations per invocation. Operators that
 *  legitimately need to repair more than this run multiple bounded
 *  invocations rather than a global rebuild. */
export const MAX_REPAIR_BATCH = 100;

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type RepairAction =
  /** Drift below tolerance — no mutation needed. */
  | { kind: "noop"; reason: "drift_within_tolerance" }
  /** Aggregate row absent and the key has observed Orders. v1 does NOT
   *  recreate missing aggregates (that would constitute backfill). */
  | { kind: "noop"; reason: "missing_aggregate_skipped" }
  /** Caller did not invoke with `dryRun: false`. */
  | { kind: "noop"; reason: "dry_run" }
  /** Drift exists and the repair was applied. */
  | { kind: "applied"; mutatedFields: string[] }
  /** Mongo write rejected. */
  | { kind: "failed"; error: string };

export interface RepairKeyResult {
  axis: ReliabilityAxis;
  merchantId: string;
  hashKey: string;
  driftBefore: ReliabilityKeyDrift | null;
  action: RepairAction;
  /** The exact counter values that would have been written (or were written). */
  proposed: {
    deliveredCount: number;
    rtoCount: number;
    cancelledCount: number;
  } | null;
}

export interface RepairSliceResult {
  axis: ReliabilityAxis;
  merchantId: string;
  generatedAt: Date;
  /** Per-key repair outcomes, capped at `MAX_REPAIR_BATCH`. */
  perKey: RepairKeyResult[];
  /** Number of keys skipped because the slice exceeded the cap. */
  capped: number;
  warnings: string[];
}

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

function buildProposedFromExpected(drift: ReliabilityKeyDrift): {
  deliveredCount: number;
  rtoCount: number;
  cancelledCount: number;
} {
  return {
    deliveredCount: Math.max(0, drift.expected.delivered),
    rtoCount: Math.max(0, drift.expected.rto),
    cancelledCount: Math.max(0, drift.expected.cancelled),
  };
}

async function applyKeyRepair(
  axis: ReliabilityAxis,
  merchantOid: Types.ObjectId,
  hashKey: string,
  proposed: { deliveredCount: number; rtoCount: number; cancelledCount: number },
): Promise<{ ok: true; mutatedFields: string[] } | { ok: false; error: string }> {
  const filter =
    axis === "customer"
      ? { merchantId: merchantOid, phoneHash: hashKey }
      : { merchantId: merchantOid, addressHash: hashKey };
  const update = { $set: proposed };
  try {
    const res =
      axis === "customer"
        ? await CustomerReliability.updateOne(filter, update)
        : await AddressReliability.updateOne(filter, update);
    if (res.matchedCount === 0) {
      return { ok: false, error: "row not found at write time" };
    }
    return {
      ok: true,
      mutatedFields: Object.keys(proposed),
    };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Single-key repair                                                          */
/* -------------------------------------------------------------------------- */

export interface RebuildAggregateForKeyInput {
  merchantId: Types.ObjectId | string;
  axis: ReliabilityAxis;
  hashKey: string;
  /** Default `true`. Set explicitly to `false` to mutate. */
  dryRun?: boolean;
  /** Optional pre-computed drift report — bypasses the reconciler call. */
  precomputed?: ReliabilityKeyDrift;
  /** Reference time. Defaults to `new Date()`. */
  now?: Date;
}

export async function rebuildAggregateForKey(
  input: RebuildAggregateForKeyInput,
): Promise<RepairKeyResult> {
  const merchantOid = safeMerchantOid(input.merchantId);
  const axis = input.axis === "address" ? "address" : "customer";
  const merchantIdHex = merchantOid?.toHexString() ?? String(input.merchantId ?? "");
  const baseResult: RepairKeyResult = {
    axis,
    merchantId: merchantIdHex,
    hashKey: input.hashKey,
    driftBefore: null,
    action: { kind: "noop", reason: "drift_within_tolerance" },
    proposed: null,
  };
  if (!merchantOid || !input.hashKey) {
    return {
      ...baseResult,
      action: { kind: "failed", error: "invalid input" },
    };
  }

  // 1. Fetch / consume the drift report.
  let drift: ReliabilityKeyDrift | null;
  if (input.precomputed) {
    drift = input.precomputed;
  } else {
    drift = await reconcileKey({
      merchantId: merchantOid,
      axis,
      hashKey: input.hashKey,
      now: input.now,
    });
  }
  baseResult.driftBefore = drift;

  // 2. Decide on action.
  if (!drift || !drift.exists) {
    // v1 does not recreate missing aggregates — that would constitute
    // backfill, which is explicitly out of v1 scope.
    return {
      ...baseResult,
      action: { kind: "noop", reason: "missing_aggregate_skipped" },
    };
  }

  if (drift.driftMagnitude <= DRIFT_TOLERANCE) {
    return {
      ...baseResult,
      action: { kind: "noop", reason: "drift_within_tolerance" },
    };
  }

  const proposed = buildProposedFromExpected(drift);
  baseResult.proposed = proposed;

  // 3. Dry-run gate.
  if (input.dryRun !== false) {
    return { ...baseResult, action: { kind: "noop", reason: "dry_run" } };
  }

  // 4. Apply.
  const apply = await applyKeyRepair(axis, merchantOid, input.hashKey, proposed);
  if (!apply.ok) {
    recordReliabilityOutcome({
      event: "integrity_warning",
      merchantId: merchantIdHex,
      axis,
      reason: "repair_failed",
      error: apply.error,
      meta: { hashKeyPrefix: input.hashKey.slice(0, 12), driftMagnitude: drift.driftMagnitude },
    });
    return { ...baseResult, action: { kind: "failed", error: apply.error } };
  }

  recordReliabilityOutcome({
    event: "integrity_warning",
    merchantId: merchantIdHex,
    axis,
    reason: "repair_applied",
    meta: {
      hashKeyPrefix: input.hashKey.slice(0, 12),
      driftMagnitude: drift.driftMagnitude,
      delivered: proposed.deliveredCount,
      rto: proposed.rtoCount,
      cancelled: proposed.cancelledCount,
    },
  });

  return {
    ...baseResult,
    action: { kind: "applied", mutatedFields: apply.mutatedFields },
  };
}

/* -------------------------------------------------------------------------- */
/* Bounded slice repair                                                       */
/* -------------------------------------------------------------------------- */

export interface RebuildSliceForMerchantInput {
  merchantId: Types.ObjectId | string;
  axis: ReliabilityAxis;
  /** Default `true`. */
  dryRun?: boolean;
  /** Cap on number of keys to repair in this invocation. Default + max
   *  is `MAX_REPAIR_BATCH`. */
  limit?: number;
  /** Pre-computed slice report — bypasses the reconciler call. */
  precomputed?: ReconcileSliceResult;
  now?: Date;
}

/**
 * Bounded slice repair. Per-merchant, per-axis. Repair is applied (or
 * planned, in dry-run) to at most `limit` keys whose `driftMagnitude`
 * exceeds `DRIFT_TOLERANCE`.
 *
 * NEVER repairs more than `MAX_REPAIR_BATCH` keys in one invocation. If
 * the merchant has more drifted keys than the cap, the remainder is
 * surfaced via `capped` and the operator runs again.
 */
export async function rebuildSliceForMerchant(
  input: RebuildSliceForMerchantInput,
): Promise<RepairSliceResult> {
  const merchantOid = safeMerchantOid(input.merchantId);
  const axis = input.axis === "address" ? "address" : "customer";
  const generatedAt = input.now ?? new Date();
  const warnings: string[] = [];
  const merchantIdHex = merchantOid?.toHexString() ?? String(input.merchantId ?? "");

  if (!merchantOid) {
    return {
      axis,
      merchantId: merchantIdHex,
      generatedAt,
      perKey: [],
      capped: 0,
      warnings: ["invalid merchantId"],
    };
  }

  const cap = Math.max(
    1,
    Math.min(
      typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
        ? Math.floor(input.limit)
        : MAX_REPAIR_BATCH,
      MAX_REPAIR_BATCH,
    ),
  );

  // 1. Fetch / consume the slice drift report.
  const slice =
    input.precomputed ??
    (await reconcileSlice({
      merchantId: merchantOid,
      axis,
      now: input.now,
    }));
  warnings.push(...slice.warnings);

  // 2. Filter to drifted, existing aggregates with magnitude > tolerance.
  const candidates = slice.entries.filter(
    (e) => e.exists && e.driftMagnitude > DRIFT_TOLERANCE,
  );
  // Sort largest-drift first — repair the worst offenders within the cap.
  candidates.sort((a, b) => b.driftMagnitude - a.driftMagnitude);

  const toRepair = candidates.slice(0, cap);
  const capped = Math.max(0, candidates.length - toRepair.length);

  const perKey: RepairKeyResult[] = [];
  for (const entry of toRepair) {
    const result = await rebuildAggregateForKey({
      merchantId: merchantOid,
      axis,
      hashKey: entry.hashKey,
      dryRun: input.dryRun,
      precomputed: entry,
      now: input.now,
    });
    perKey.push(result);
  }

  return {
    axis,
    merchantId: merchantIdHex,
    generatedAt,
    perKey,
    capped,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  MAX_REPAIR_BATCH,
  DRIFT_TOLERANCE,
  buildProposedFromExpected,
};
