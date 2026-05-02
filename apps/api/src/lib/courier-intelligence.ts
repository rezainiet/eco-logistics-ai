import { Types } from "mongoose";
import {
  CourierPerformance,
  COURIER_PERF_GLOBAL_DISTRICT,
  type CourierPerfOutcome,
} from "@ecom/db";
import { normalizeDistrict } from "./district.js";

/**
 * Courier intelligence — picks the best courier for an order using each
 * merchant's own delivery-outcome history.
 *
 * Two layers:
 *  1. `recordCourierOutcome(...)` — write side. Increments the per-(merchant,
 *     courier, district) bucket AND the merchant's `_GLOBAL_` aggregate
 *     for that courier. Atomic, idempotency-friendly, never throws.
 *  2. `selectBestCourier(...)` — read side. Loads stats for each candidate
 *     courier (district-level when available, global fallback otherwise),
 *     scores them via `scoreCourierCandidate`, returns the ranked list with
 *     transparency breakdown for audit / UI display.
 *
 * The scoring function is a pure mapping from `(deliveredCount, rtoCount,
 * cancelledCount, avgDeliveryHours)` to a number in [0, 100]. Three
 * weighted components:
 *
 *   successRate  → +60 weight  (delivered / completedTotal)
 *   rtoRate      → -30 weight  (rto / completedTotal)
 *   speedScore   → +10 weight  (faster = higher; 24h baseline → 1.0)
 *
 * Cold start: when a candidate has fewer than `MIN_OBSERVATIONS` completed
 * orders, the score collapses to a neutral 50 + a small "preferred-courier"
 * bonus, so a brand-new courier doesn't out-score a proven one solely
 * because it has no failures yet.
 */

export const SCORE_WEIGHTS = {
  success: 60,
  rto: 30,
  speed: 10,
} as const;

const MIN_OBSERVATIONS = 10;
const NEUTRAL_SCORE = 50;
const PREFERRED_BONUS = 5;
const SPEED_BASELINE_HOURS = 24;
/** Stats older than this are treated as stale (cold-start) at scoring time. */
const STALE_OUTCOME_DAYS = 180;
/** Rolling window for the recent-failure circuit breaker (1 hour). */
const RECENT_FAILURE_WINDOW_MS = 60 * 60 * 1000;
/** Per-failure penalty applied to the score, capped at FAILURE_PENALTY_CAP. */
const FAILURE_PENALTY_PER_HIT = 4;
const FAILURE_PENALTY_CAP = 20;

export interface CourierCandidateStats {
  courier: string;
  district: string;
  deliveredCount: number;
  rtoCount: number;
  cancelledCount: number;
  /** Sum of delivered-order delivery hours; divided by deliveredCount for avg. */
  totalDeliveryHours: number;
  /** Last time any outcome landed — used for staleness check. */
  lastOutcomeAt?: Date | null;
  /** Booking failures inside the rolling 1h window. */
  recentFailures?: number;
  recentFailureWindowAt?: Date | null;
}

export interface CourierScoreBreakdown {
  successRate: number;
  rtoRate: number;
  avgDeliveryHours: number | null;
  observations: number;
  /** Sub-scores summed into `score`. */
  successContribution: number;
  rtoPenalty: number;
  speedContribution: number;
  preferredBonus: number;
  /** True when stats were below the cold-start floor or older than STALE_OUTCOME_DAYS. */
  coldStart: boolean;
  /** Penalty subtracted for recent booking failures (capped). */
  failurePenalty: number;
  /** True when stats were dropped because lastOutcomeAt > STALE_OUTCOME_DAYS ago. */
  stale: boolean;
}

export interface CourierCandidateResult {
  courier: string;
  /** Source row used: per-district or _GLOBAL_ aggregate. */
  matchedOn: "district" | "global" | "cold_start";
  score: number;
  breakdown: CourierScoreBreakdown;
}

export function scoreCourierCandidate(
  stats: CourierCandidateStats,
  options: { isPreferred?: boolean } = {},
): { score: number; breakdown: CourierScoreBreakdown } {
  const completed =
    stats.deliveredCount + stats.rtoCount + stats.cancelledCount;
  const isPreferred = options.isPreferred === true;

  // Recent-failure penalty — applies to ANY tier (cold-start, stale, or
  // fully-evidenced). A courier failing right now is downranked
  // immediately; the penalty caps at FAILURE_PENALTY_CAP and decays via
  // the worker's window-reset logic.
  const failurePenalty = computeFailurePenalty(stats);

  // Staleness: if the row exists but lastOutcomeAt is older than
  // STALE_OUTCOME_DAYS, treat it as cold-start. Old data is worse than no
  // data for selection — couriers change ops, fleets, hubs.
  const stale =
    !!stats.lastOutcomeAt &&
    Date.now() - new Date(stats.lastOutcomeAt).getTime() >
      STALE_OUTCOME_DAYS * 24 * 60 * 60 * 1000;

  if (completed < MIN_OBSERVATIONS || stale) {
    const breakdown: CourierScoreBreakdown = {
      successRate: 0,
      rtoRate: 0,
      avgDeliveryHours: null,
      observations: completed,
      successContribution: 0,
      rtoPenalty: 0,
      speedContribution: 0,
      preferredBonus: isPreferred ? PREFERRED_BONUS : 0,
      coldStart: true,
      failurePenalty,
      stale,
    };
    return {
      score: Math.max(0, NEUTRAL_SCORE + breakdown.preferredBonus - failurePenalty),
      breakdown,
    };
  }

  const successRate = stats.deliveredCount / completed;
  const rtoRate = stats.rtoCount / completed;
  const avgDeliveryHours =
    stats.deliveredCount > 0 ? stats.totalDeliveryHours / stats.deliveredCount : null;

  // Speed score: 1.0 at 24h, falls off linearly. >48h → 0; <12h → ~1.5.
  // Clamped to [0, 1.5] so an unrealistically fast outlier can't dominate.
  let speedScore = 0;
  if (avgDeliveryHours !== null && avgDeliveryHours > 0) {
    speedScore = Math.max(0, Math.min(1.5, SPEED_BASELINE_HOURS / avgDeliveryHours));
  }

  const successContribution = successRate * SCORE_WEIGHTS.success;
  const rtoPenalty = rtoRate * SCORE_WEIGHTS.rto;
  const speedContribution = (speedScore / 1.5) * SCORE_WEIGHTS.speed;
  const preferredBonus = isPreferred ? PREFERRED_BONUS : 0;

  const score = Math.max(
    0,
    Math.min(
      100,
      successContribution - rtoPenalty + speedContribution + preferredBonus - failurePenalty,
    ),
  );

  return {
    score,
    breakdown: {
      successRate,
      rtoRate,
      avgDeliveryHours,
      observations: completed,
      successContribution,
      rtoPenalty,
      speedContribution,
      preferredBonus,
      coldStart: false,
      failurePenalty,
      stale: false,
    },
  };
}

function computeFailurePenalty(stats: CourierCandidateStats): number {
  const count = stats.recentFailures ?? 0;
  if (count <= 0) return 0;
  const windowAt = stats.recentFailureWindowAt
    ? new Date(stats.recentFailureWindowAt).getTime()
    : 0;
  // Window expired — caller's perspective; we treat as no penalty so a
  // stale window doesn't keep punishing forever. (The worker resets the
  // counter on its own loop too.)
  if (windowAt > 0 && Date.now() - windowAt > RECENT_FAILURE_WINDOW_MS) {
    return 0;
  }
  return Math.min(FAILURE_PENALTY_CAP, count * FAILURE_PENALTY_PER_HIT);
}

/**
 * Record a booking failure inside the rolling window. Increments the
 * counter; resets it (to 1) if the window has lapsed. Best-effort —
 * called by the auto-book worker on every failed attempt.
 */
export async function recordCourierBookFailure(args: {
  merchantId: Types.ObjectId | string;
  courier: string;
  district: string;
}): Promise<void> {
  const merchantOid = new Types.ObjectId(String(args.merchantId));
  const courier = args.courier.trim().toLowerCase();
  const district = normalizeDistrict(args.district);
  if (!courier) return;

  const cutoff = new Date(Date.now() - RECENT_FAILURE_WINDOW_MS);
  for (const districtKey of [district, COURIER_PERF_GLOBAL_DISTRICT]) {
    try {
      // First, if window is stale, reset before incrementing. Two-step
      // because a single update can't conditionally branch on a field
      // value in the same shape.
      await CourierPerformance.updateOne(
        {
          merchantId: merchantOid,
          courier,
          district: districtKey,
          recentFailureWindowAt: { $lt: cutoff },
        },
        {
          $set: {
            recentFailureCount: 0,
            recentFailureWindowAt: new Date(),
          },
        },
      );
      // Then atomically bump the counter (and seed the window if absent).
      await CourierPerformance.updateOne(
        { merchantId: merchantOid, courier, district: districtKey },
        {
          $setOnInsert: { merchantId: merchantOid, courier, district: districtKey },
          $set: { recentFailureWindowAt: new Date() },
          $inc: { recentFailureCount: 1 },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error(
        `[courier-intelligence] failure record failed (${districtKey}):`,
        (err as Error).message,
      );
    }
  }
}

export interface SelectBestCourierInput {
  merchantId: Types.ObjectId | string;
  district: string;
  /** Courier names allowed for this merchant (filtered by enabled flag). */
  candidates: string[];
  /** Merchant.automationConfig.autoBookCourier — gets a small score bonus. */
  preferredCourier?: string | null;
}

export interface SelectBestCourierResult {
  best: string | null;
  ranked: CourierCandidateResult[];
  reason: string;
}

/**
 * Load + score candidates and return them ranked. `best` is null only when
 * `candidates` is empty.
 *
 * Per-district stats are preferred when ≥MIN_OBSERVATIONS completed orders
 * exist. Otherwise the merchant's global aggregate for that courier is
 * used. Below both thresholds we emit a `cold_start` candidate at the
 * neutral score.
 */
export async function selectBestCourier(
  input: SelectBestCourierInput,
): Promise<SelectBestCourierResult> {
  const merchantOid = new Types.ObjectId(String(input.merchantId));
  const district = normalizeDistrict(input.district);
  const candidates = input.candidates.filter(Boolean);
  if (candidates.length === 0) {
    return { best: null, ranked: [], reason: "no enabled couriers" };
  }
  const preferred = input.preferredCourier?.trim().toLowerCase() ?? null;

  // Single round-trip read of every row that could matter.
  const rows = await CourierPerformance.find({
    merchantId: merchantOid,
    courier: { $in: candidates.map((c) => c.toLowerCase()) },
    district: { $in: [district, COURIER_PERF_GLOBAL_DISTRICT] },
  }).lean();

  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byKey.set(`${r.courier}|${r.district}`, r);

  const ranked: CourierCandidateResult[] = candidates.map((courier) => {
    const c = courier.toLowerCase();
    const districtRow = byKey.get(`${c}|${district}`);
    const globalRow = byKey.get(`${c}|${COURIER_PERF_GLOBAL_DISTRICT}`);

    let pickedRow: typeof districtRow | undefined;
    let matchedOn: CourierCandidateResult["matchedOn"];
    const districtCompleted =
      (districtRow?.deliveredCount ?? 0) +
      (districtRow?.rtoCount ?? 0) +
      (districtRow?.cancelledCount ?? 0);

    if (districtRow && districtCompleted >= MIN_OBSERVATIONS) {
      pickedRow = districtRow;
      matchedOn = "district";
    } else if (globalRow) {
      pickedRow = globalRow;
      matchedOn = "global";
    } else {
      matchedOn = "cold_start";
    }

    const isPreferred = preferred === c;
    const stats: CourierCandidateStats = pickedRow
      ? {
          courier: c,
          district: pickedRow.district,
          deliveredCount: pickedRow.deliveredCount,
          rtoCount: pickedRow.rtoCount,
          cancelledCount: pickedRow.cancelledCount,
          totalDeliveryHours: pickedRow.totalDeliveryHours,
          lastOutcomeAt: pickedRow.lastOutcomeAt ?? null,
          recentFailures: (pickedRow as { recentFailureCount?: number }).recentFailureCount ?? 0,
          recentFailureWindowAt:
            (pickedRow as { recentFailureWindowAt?: Date }).recentFailureWindowAt ?? null,
        }
      : {
          courier: c,
          district,
          deliveredCount: 0,
          rtoCount: 0,
          cancelledCount: 0,
          totalDeliveryHours: 0,
        };

    const { score, breakdown } = scoreCourierCandidate(stats, { isPreferred });
    return { courier: c, matchedOn, score, breakdown };
  });

  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0]!;
  const reason = top.breakdown.coldStart
    ? `cold start — neutral score${preferred ? ` + preferred courier (${preferred})` : ""}`
    : `success ${(top.breakdown.successRate * 100).toFixed(0)}% / rto ${(top.breakdown.rtoRate * 100).toFixed(0)}% over ${top.breakdown.observations} orders (${top.matchedOn})`;
  return { best: top.courier, ranked, reason };
}

/* -------------------------------------------------------------------------- */
/* Write side                                                                  */
/* -------------------------------------------------------------------------- */

export interface RecordCourierOutcomeInput {
  merchantId: Types.ObjectId | string;
  courier: string;
  district: string;
  outcome: CourierPerfOutcome;
  /** Optional delivered-order delivery hours. Ignored unless outcome==="delivered". */
  deliveryHours?: number;
}

const FIELD_FOR_OUTCOME: Record<CourierPerfOutcome, string> = {
  delivered: "deliveredCount",
  rto: "rtoCount",
  cancelled: "cancelledCount",
};

/**
 * Record one outcome onto BOTH the per-district row and the merchant's
 * `_GLOBAL_` aggregate. Atomic per row, never throws. Best-effort.
 */
export async function recordCourierOutcome(
  input: RecordCourierOutcomeInput,
): Promise<void> {
  const merchantOid = new Types.ObjectId(String(input.merchantId));
  const courier = input.courier.trim().toLowerCase();
  if (!courier || !input.district) return;
  // Normalize district at the write boundary so storage matches the canonical
  // form `selectBestCourier` queries on. Without this, "Dhaka" / "dhaka" /
  // "DHAKA" become separate buckets and the lookup falls through to cold_start.
  const district = normalizeDistrict(input.district);
  const counterField = FIELD_FOR_OUTCOME[input.outcome];
  const now = new Date();

  const inc: Record<string, number> = { [counterField]: 1 };
  if (input.outcome === "delivered" && input.deliveryHours && input.deliveryHours > 0) {
    inc.totalDeliveryHours = input.deliveryHours;
  }

  // Two upserts: per-district + per-merchant aggregate. Sequential is fine —
  // the caller `void`s this whole function so latency is irrelevant.
  for (const districtKey of [district, COURIER_PERF_GLOBAL_DISTRICT]) {
    try {
      await CourierPerformance.updateOne(
        { merchantId: merchantOid, courier, district: districtKey },
        {
          $setOnInsert: { merchantId: merchantOid, courier, district: districtKey },
          $set: { lastOutcomeAt: now },
          $inc: inc,
        },
        { upsert: true },
      );
    } catch (err) {
      console.error(
        `[courier-intelligence] outcome write failed (${districtKey}):`,
        (err as Error).message,
      );
    }
  }
}

export const __TEST = {
  SCORE_WEIGHTS,
  MIN_OBSERVATIONS,
  NEUTRAL_SCORE,
  PREFERRED_BONUS,
  SPEED_BASELINE_HOURS,
  STALE_OUTCOME_DAYS,
  RECENT_FAILURE_WINDOW_MS,
  FAILURE_PENALTY_PER_HIT,
  FAILURE_PENALTY_CAP,
  computeFailurePenalty,
};
