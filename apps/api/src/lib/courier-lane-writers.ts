import { Types } from "mongoose";
import {
  AreaReliability,
  CourierLane,
  type AreaReliabilityOutcome,
  type CourierLaneOutcome,
} from "@ecom/db";
import { ADDRESS_PIPELINE_VERSION } from "./address-canonical.js";
import { normalizeDistrict } from "./district.js";
import { env } from "../env.js";

/* -------------------------------------------------------------------------- */
/* Observability — lightweight structured-log emit for the new writers.       */
/* The reliability-observability counter store has a closed enum we don't     */
/* extend in this phase; lane/area events log with a stable shape so the      */
/* admin observability surface can adopt them later without breaking          */
/* schema parity.                                                              */
/* -------------------------------------------------------------------------- */

type LaneObsEvent =
  | "lane_updated"
  | "area_updated"
  | "lane_write_failed"
  | "area_write_failed";

function emitLaneObs(event: LaneObsEvent, payload: Record<string, unknown>): void {
  if (!env.DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED) return;
  try {
    const line = JSON.stringify({ msg: "lane_intelligence", event, ...payload });
    if (event === "lane_write_failed" || event === "area_write_failed") {
      console.error(line);
    } else {
      console.log(line);
    }
  } catch {
    /* defence-in-depth — never throw back into a chokepoint fan-out */
  }
}

/**
 * Phase 3 — courier-lane + area-reliability writers.
 *
 * Single intended caller: `applyTrackingEvents`'s terminal-transition
 * fan-out (S3 wiring). The chokepoint already enforces at-most-once
 * invocation per real `(prevStatus → terminalStatus)` transition via
 * its existing `$nin newKeys` + status guard + `nextStatus !== prevStatus`
 * gate. These helpers do NOT dedupe; they trust the caller's gating.
 *
 * Forbidden behaviour (binding contract):
 *   - ❌ read Order, Merchant, or any other model
 *   - ❌ enqueue BullMQ jobs
 *   - ❌ mutate fraud / automation / MerchantStats / FraudPrediction /
 *        FraudSignal / CourierPerformance / CustomerReliability /
 *        AddressReliability
 *   - ❌ invoke `applyTrackingEvents` (cyclic)
 *   - ❌ throw back into the caller — every error path resolves silently
 *   - ❌ return data the caller is supposed to use (return type `void`)
 *
 * Replay-safety contract (binding):
 *   - ADDITIVE writes only. The legacy CourierPerformance writes (via
 *     `recordCourierOutcome`) are UNCHANGED.
 *   - Per-document atomic upserts with $setOnInsert + $inc + $max.
 *     Identical replay-storm characteristics to the existing reliability
 *     writers.
 *   - The 7d rolling window on AreaReliability uses a CAS-style two-step
 *     write: a guarded reset that fires only when the window has lapsed,
 *     followed by an unconditional $inc. Mirrors
 *     `recordCourierBookFailure` in `lib/courier-intelligence.ts`.
 */

const COURIER_LANE_COUNTER_FIELD: Record<CourierLaneOutcome, string> = {
  delivered: "deliveredCount",
  rto: "rtoCount",
  cancelled: "cancelledCount",
};

const AREA_COUNTER_FIELD: Record<AreaReliabilityOutcome, string> = {
  delivered: "deliveredCount",
  rto: "rtoCount",
  cancelled: "cancelledCount",
};

const AREA_RECENT_FIELD: Record<AreaReliabilityOutcome, string> = {
  delivered: "recent7dDelivered",
  rto: "recent7dRto",
  cancelled: "recent7dCancelled",
};

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const VALID_OUTCOMES = ["delivered", "rto", "cancelled"] as const;

/* -------------------------------------------------------------------------- */
/* Defensive normalizers                                                      */
/* -------------------------------------------------------------------------- */

function normalizeMerchantOid(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  if (value == null) return null;
  try {
    const s = typeof value === "string" ? value : String(value);
    return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
  } catch {
    return null;
  }
}

function normalizeOutcome(
  value: unknown,
): CourierLaneOutcome | null {
  if (typeof value !== "string") return null;
  return (VALID_OUTCOMES as readonly string[]).includes(value)
    ? (value as CourierLaneOutcome)
    : null;
}

function normalizeShortString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function normalizeNow(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  return new Date();
}

function normalizeNonNeg(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/* -------------------------------------------------------------------------- */
/* recordCourierLaneOutcome                                                   */
/* -------------------------------------------------------------------------- */

export interface RecordCourierLaneOutcomeInput {
  merchantId: Types.ObjectId | string;
  courier: string;
  /** Order destination district (raw merchant input or canonical). */
  district: string;
  /** Canonical thana — REQUIRED. Skip the write entirely when not known. */
  thana: string;
  outcome: CourierLaneOutcome;
  /** Optional delivered-order delivery hours. Ignored unless outcome === "delivered". */
  deliveryHours?: number;
  /**
   * Attempt index — 1-based. Derived by the caller at the chokepoint from
   * `Order.automation.attemptedCouriers.length`. Out-of-range values clamp
   * to 1 (not provided / unknown) or 3 (3+).
   */
  attemptIndex?: 1 | 2 | 3;
  /** Reference timestamp; defaults to `new Date()`. Injectable for tests. */
  now?: Date;
}

/**
 * Record one courier outcome for a (merchant, courier, district, thana)
 * lane. Atomic per-document upsert. Best-effort; never throws back.
 *
 * Idempotency contract: the helper does NOT dedupe by orderId. The
 * chokepoint gate is the source of replay-safety; calling this helper
 * outside that gate WILL double-count.
 */
export async function recordCourierLaneOutcome(
  input: RecordCourierLaneOutcomeInput,
): Promise<void> {
  if (!input || typeof input !== "object") return;

  const merchantOid = normalizeMerchantOid(input.merchantId);
  const courier = normalizeShortString(input.courier, 60);
  const districtRaw = normalizeShortString(input.district, 100);
  const district = districtRaw ? normalizeDistrict(districtRaw) : null;
  const thana = normalizeShortString(input.thana, 100);
  const outcome = normalizeOutcome(input.outcome);
  if (!merchantOid || !courier || !district || !thana || !outcome) return;

  const now = normalizeNow(input.now);
  const counterField = COURIER_LANE_COUNTER_FIELD[outcome];
  const deliveryHours = normalizeNonNeg(input.deliveryHours);

  const inc: Record<string, number> = { [counterField]: 1 };
  if (outcome === "delivered" && deliveryHours > 0) {
    inc.totalDeliveryHours = deliveryHours;
  }
  // Per-attempt counters — record only delivered / rto (cancelled doesn't
  // belong to an attempt — the order never reached the rider). Clamp the
  // attempt index to 1 / 2 / 3+ buckets.
  const attempt = (() => {
    const n = input.attemptIndex;
    if (n === 2) return 2 as const;
    if (n === 3) return 3 as const;
    return 1 as const;
  })();
  if (outcome === "delivered" || outcome === "rto") {
    const suffix = outcome === "delivered" ? "Delivered" : "Rto";
    const field =
      attempt === 1
        ? `attempt1${suffix}`
        : attempt === 2
          ? `attempt2${suffix}`
          : `attempt3Plus${suffix}`;
    inc[field] = 1;
  }

  const startedAt = Date.now();
  try {
    await CourierLane.updateOne(
      { merchantId: merchantOid, courier, district, thana },
      {
        $setOnInsert: {
          merchantId: merchantOid,
          courier,
          district,
          thana,
          firstOutcomeAt: now,
          pipelineVersion: ADDRESS_PIPELINE_VERSION,
        },
        $max: { lastOutcomeAt: now },
        $inc: inc,
      },
      { upsert: true },
    );
    emitLaneObs("lane_updated", {
      merchantId: merchantOid.toHexString(),
      reason: outcome,
      durationMs: Date.now() - startedAt,
      courier,
      district,
      thana,
      attempt,
    });
  } catch (err) {
    console.error(
      "[courier-lane] outcome write failed:",
      (err as Error)?.message ?? err,
    );
    emitLaneObs("lane_write_failed", {
      merchantId: merchantOid.toHexString(),
      reason: outcome,
      durationMs: Date.now() - startedAt,
      error: (err as Error)?.message?.slice(0, 200),
      courier,
      district,
      thana,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* recordAreaOutcome                                                          */
/* -------------------------------------------------------------------------- */

export interface RecordAreaOutcomeInput {
  merchantId: Types.ObjectId | string;
  division: string;
  district: string;
  thana: string;
  outcome: AreaReliabilityOutcome;
  /**
   * Optional flag — when true, the unreachableCount is bumped alongside
   * the outcome counter. Set by the caller when the order had at least
   * one CallLog answered=false attempt before its terminal status flip.
   */
  unreachable?: boolean;
  now?: Date;
}

/**
 * Record one area outcome. Two-step CAS pattern handles the rolling-7d
 * window:
 *   1. Reset window counters when (now - recent7dWindowStartedAt) > 7d.
 *      Filter is `recent7dWindowStartedAt: { $lt: cutoff }` so the reset
 *      fires only when the window has actually lapsed — replay-safe.
 *   2. Atomically bump cumulative + window counters. Window start is
 *      seeded on $setOnInsert; only ever advanced by step 1.
 *
 * Best-effort; never throws back.
 */
export async function recordAreaOutcome(
  input: RecordAreaOutcomeInput,
): Promise<void> {
  if (!input || typeof input !== "object") return;

  const merchantOid = normalizeMerchantOid(input.merchantId);
  const division = normalizeShortString(input.division, 100);
  const districtRaw = normalizeShortString(input.district, 100);
  const district = districtRaw ? normalizeDistrict(districtRaw) : null;
  const thana = normalizeShortString(input.thana, 100);
  const outcome = normalizeOutcome(input.outcome);
  if (!merchantOid || !division || !district || !thana || !outcome) return;

  const now = normalizeNow(input.now);
  const counterField = AREA_COUNTER_FIELD[outcome];
  const recentField = AREA_RECENT_FIELD[outcome];
  const cutoff = new Date(now.getTime() - RECENT_WINDOW_MS);

  const startedAt = Date.now();
  try {
    // Step 1 — guarded window reset. Fires only when the existing window
    // has lapsed. Idempotent: if the window was already advanced, the
    // filter rejects and no write occurs.
    await AreaReliability.updateOne(
      {
        merchantId: merchantOid,
        division,
        district,
        thana,
        recent7dWindowStartedAt: { $lt: cutoff },
      },
      {
        $set: {
          recent7dDelivered: 0,
          recent7dRto: 0,
          recent7dCancelled: 0,
          recent7dWindowStartedAt: now,
        },
      },
    );

    // Step 2 — atomic cumulative + window bump. $setOnInsert seeds the
    // window start on first contact; subsequent contacts hit the path
    // above to advance it.
    const inc: Record<string, number> = {
      [counterField]: 1,
      [recentField]: 1,
    };
    if (input.unreachable === true) inc.unreachableCount = 1;

    await AreaReliability.updateOne(
      { merchantId: merchantOid, division, district, thana },
      {
        $setOnInsert: {
          merchantId: merchantOid,
          division,
          district,
          thana,
          firstOutcomeAt: now,
          recent7dWindowStartedAt: now,
          pipelineVersion: ADDRESS_PIPELINE_VERSION,
        },
        $max: { lastOutcomeAt: now },
        $inc: inc,
      },
      { upsert: true },
    );

    emitLaneObs("area_updated", {
      merchantId: merchantOid.toHexString(),
      reason: outcome,
      durationMs: Date.now() - startedAt,
      division,
      district,
      thana,
      unreachable: input.unreachable === true,
    });
  } catch (err) {
    emitLaneObs("area_write_failed", {
      merchantId: merchantOid.toHexString(),
      reason: outcome,
      durationMs: Date.now() - startedAt,
      error: (err as Error)?.message?.slice(0, 200),
      division,
      district,
      thana,
    });
  }
}

export const __TEST = {
  COURIER_LANE_COUNTER_FIELD,
  AREA_COUNTER_FIELD,
  AREA_RECENT_FIELD,
  RECENT_WINDOW_MS,
};
