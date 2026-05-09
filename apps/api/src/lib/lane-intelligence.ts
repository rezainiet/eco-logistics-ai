/**
 * lane-intelligence — pure-function classifier that turns Phase 3
 * aggregates (CourierLane + AreaReliability) plus the legacy
 * CourierPerformance row into explainable operational signals for the
 * merchant-facing lane health surface.
 *
 * Same shape as `lib/delivery-reliability.ts` and `lib/intent.ts`:
 *   - Pure function. Same inputs → same outputs.
 *   - Never reads DB, never enqueues, never writes.
 *   - Stable signal keys + integer weights + operator-readable details.
 *   - No ML, no LLM, no opaque heuristics. Every signal has a fixed
 *     trigger condition the merchant can debug.
 *
 * Hard rules (binding):
 *   - VISIBILITY ONLY. Output is a list of signals + a tier label; the
 *     caller decides whether to act on them.
 *   - Conservative. When evidence is insufficient, emit `lane_cold_start`
 *     and STOP — never invent a verdict from sparse data.
 *   - Operationally framed. Detail strings describe what's being
 *     observed, never accuse a courier or a buyer.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export const LANE_INTELLIGENCE_TIERS = [
  "strong",
  "neutral",
  "degraded",
  "cold_start",
] as const;
export type LaneIntelligenceTier = (typeof LANE_INTELLIGENCE_TIERS)[number];

/** Stable signal keys — UI maps these to localized copy. */
export const LANE_INTELLIGENCE_SIGNAL_KEYS = [
  "lane_strong_in_thana",
  "lane_weak_in_thana",
  "lane_degraded_recently",
  "lane_speed_strong",
  "area_high_unreachable",
  "attempt2_high_success",
  "lane_cold_start",
] as const;
export type LaneIntelligenceSignalKey =
  (typeof LANE_INTELLIGENCE_SIGNAL_KEYS)[number];

export interface LaneIntelligenceSignal {
  key: LaneIntelligenceSignalKey;
  /** Signed integer. Positive = trust signal, negative = caution signal. */
  weight: number;
  /** Operator-readable rationale — surfaced verbatim. */
  detail: string;
}

export interface LaneIntelligenceResult {
  tier: LaneIntelligenceTier;
  /** Net score in [-100, 100]. >= +20 = strong; <= -20 = degraded. */
  score: number;
  signals: LaneIntelligenceSignal[];
  observations: {
    laneCompleted: number;
    laneSuccessRate: number | null;
    laneRtoRate: number | null;
    areaCompleted: number;
    areaUnreachableRate: number | null;
    recent7dRtoRate: number | null;
  };
  computedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Input shapes — STRUCTURAL, not Mongoose. Tests run without mongodb-mem.   */
/* -------------------------------------------------------------------------- */

export interface CourierLaneStats {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  totalDeliveryHours?: number;
  attempt1Delivered?: number;
  attempt1Rto?: number;
  attempt2Delivered?: number;
  attempt2Rto?: number;
  attempt3PlusDelivered?: number;
  attempt3PlusRto?: number;
  lastOutcomeAt?: Date | null;
}

export interface AreaReliabilityStats {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  unreachableCount?: number;
  recent7dDelivered?: number;
  recent7dRto?: number;
  recent7dCancelled?: number;
  recent7dWindowStartedAt?: Date | null;
  lastOutcomeAt?: Date | null;
}

export interface ClassifyLaneInput {
  laneStats?: CourierLaneStats | null;
  areaStats?: AreaReliabilityStats | null;
  /** Reference time — defaults to `new Date()`. Injectable for tests. */
  now?: Date;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const MIN_LANE_OBSERVATIONS = 20;
const MIN_AREA_OBSERVATIONS = 10;

const STRONG_SUCCESS_RATE = 0.85;
const WEAK_RTO_RATE = 0.20;
const SPEED_STRONG_HOURS = 24; // average delivery hours <= 24 → speed-strong

const HIGH_UNREACHABLE_RATE = 0.25;

const RECENT_DEGRADE_RATIO = 1.5; // recent7dRtoRate / longTermRtoRate
const MIN_RECENT_OBSERVATIONS = 10;

const STRONG_TIER_THRESHOLD = 20;
const DEGRADED_TIER_THRESHOLD = -20;

const WEIGHTS = {
  laneStrong: 25,
  laneWeak: 25,
  laneDegraded: 20,
  speedStrong: 5,
  highUnreachable: 15,
  attempt2HighSuccess: 10,
} as const;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeCount(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function safeSum(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

function safeNow(input: Date | undefined): Date {
  if (input instanceof Date && Number.isFinite(input.getTime())) return input;
  return new Date();
}

function classifyTier(score: number): LaneIntelligenceTier {
  if (Number.isFinite(score) && score >= STRONG_TIER_THRESHOLD) return "strong";
  if (Number.isFinite(score) && score <= DEGRADED_TIER_THRESHOLD) return "degraded";
  return "neutral";
}

/* -------------------------------------------------------------------------- */
/* Lane analyser                                                              */
/* -------------------------------------------------------------------------- */

interface LaneAxis {
  signals: LaneIntelligenceSignal[];
  laneCompleted: number;
  laneSuccessRate: number | null;
  laneRtoRate: number | null;
  /** True when there's enough lane data to NOT short-circuit to cold_start. */
  evidenced: boolean;
}

function analyzeLane(
  stats: CourierLaneStats | null | undefined,
): LaneAxis {
  const empty: LaneAxis = {
    signals: [],
    laneCompleted: 0,
    laneSuccessRate: null,
    laneRtoRate: null,
    evidenced: false,
  };
  if (!stats) return empty;

  const delivered = safeCount(stats.deliveredCount);
  const rto = safeCount(stats.rtoCount);
  const cancelled = safeCount(stats.cancelledCount);
  const completed = delivered + rto + cancelled;
  if (completed < MIN_LANE_OBSERVATIONS) {
    return { ...empty, laneCompleted: completed };
  }

  const successRate = delivered / completed;
  const rtoRate = rto / completed;
  const signals: LaneIntelligenceSignal[] = [];

  if (successRate >= STRONG_SUCCESS_RATE) {
    signals.push({
      key: "lane_strong_in_thana",
      weight: WEIGHTS.laneStrong,
      detail: `Courier delivered ${Math.round(successRate * 100)}% on ${completed} prior orders in this thana.`,
    });
  } else if (rtoRate >= WEAK_RTO_RATE) {
    signals.push({
      key: "lane_weak_in_thana",
      weight: -WEIGHTS.laneWeak,
      detail: `Courier RTO rate ${Math.round(rtoRate * 100)}% on ${completed} prior orders in this thana.`,
    });
  }

  // Speed signal — fast lanes earn a small bonus.
  const totalHours = safeSum(stats.totalDeliveryHours);
  if (delivered > 0 && totalHours > 0) {
    const avgHours = totalHours / delivered;
    if (avgHours > 0 && avgHours <= SPEED_STRONG_HOURS) {
      signals.push({
        key: "lane_speed_strong",
        weight: WEIGHTS.speedStrong,
        detail: `Average delivery time ${avgHours.toFixed(1)}h on this lane.`,
      });
    }
  }

  // Attempt-2 success — surfaces lanes where retry pays off.
  const a2Delivered = safeCount(stats.attempt2Delivered);
  const a2Rto = safeCount(stats.attempt2Rto);
  const a2Total = a2Delivered + a2Rto;
  if (a2Total >= 5 && a2Delivered / a2Total >= 0.7) {
    signals.push({
      key: "attempt2_high_success",
      weight: WEIGHTS.attempt2HighSuccess,
      detail: `Second-attempt deliveries on this lane succeed ${Math.round((a2Delivered / a2Total) * 100)}% of the time (${a2Delivered}/${a2Total}). Worth keeping in retry queue.`,
    });
  }

  return {
    signals,
    laneCompleted: completed,
    laneSuccessRate: successRate,
    laneRtoRate: rtoRate,
    evidenced: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Area analyser                                                              */
/* -------------------------------------------------------------------------- */

interface AreaAxis {
  signals: LaneIntelligenceSignal[];
  areaCompleted: number;
  areaUnreachableRate: number | null;
  recent7dRtoRate: number | null;
  evidenced: boolean;
}

function analyzeArea(
  stats: AreaReliabilityStats | null | undefined,
): AreaAxis {
  const empty: AreaAxis = {
    signals: [],
    areaCompleted: 0,
    areaUnreachableRate: null,
    recent7dRtoRate: null,
    evidenced: false,
  };
  if (!stats) return empty;

  const delivered = safeCount(stats.deliveredCount);
  const rto = safeCount(stats.rtoCount);
  const cancelled = safeCount(stats.cancelledCount);
  const completed = delivered + rto + cancelled;
  const unreachable = safeCount(stats.unreachableCount);
  const r7dDelivered = safeCount(stats.recent7dDelivered);
  const r7dRto = safeCount(stats.recent7dRto);
  const r7dCompleted = r7dDelivered + r7dRto + safeCount(stats.recent7dCancelled);

  if (completed < MIN_AREA_OBSERVATIONS) {
    return { ...empty, areaCompleted: completed };
  }

  const signals: LaneIntelligenceSignal[] = [];
  const unreachableRate = unreachable / completed;
  if (unreachableRate >= HIGH_UNREACHABLE_RATE) {
    signals.push({
      key: "area_high_unreachable",
      weight: -WEIGHTS.highUnreachable,
      detail: `Customers in this area are unreachable on ${Math.round(unreachableRate * 100)}% of contact attempts (${unreachable}/${completed}). Consider scheduling calls outside work hours.`,
    });
  }

  // Recent-window degradation — fires when 7-day RTO rate ≥ 1.5× the
  // long-term rate, AND the recent window has enough resolved orders to
  // be diagnostic. Conservative: never fires on a fresh area.
  const longTermRtoRate = rto > 0 ? rto / completed : 0;
  let recent7dRtoRate: number | null = null;
  if (r7dCompleted >= MIN_RECENT_OBSERVATIONS) {
    recent7dRtoRate = r7dRto / r7dCompleted;
    if (
      longTermRtoRate > 0 &&
      recent7dRtoRate >= longTermRtoRate * RECENT_DEGRADE_RATIO &&
      recent7dRtoRate >= 0.10
    ) {
      signals.push({
        key: "lane_degraded_recently",
        weight: -WEIGHTS.laneDegraded,
        detail: `Returns in this area are running at ${Math.round(recent7dRtoRate * 100)}% over the last 7 days vs ${Math.round(longTermRtoRate * 100)}% long-term. Review courier choice for this lane.`,
      });
    }
  }

  return {
    signals,
    areaCompleted: completed,
    areaUnreachableRate: unreachableRate,
    recent7dRtoRate,
    evidenced: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Public classifier                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Classify a (courier, area) lane into operational signals. Conservative:
 * when neither axis has enough evidence, returns
 * `tier: "cold_start"` with a single sentinel signal.
 *
 * Never throws. All numeric fields safe-coerced.
 */
export function classifyLaneIntelligence(
  input: ClassifyLaneInput | null | undefined,
): LaneIntelligenceResult {
  const safeInput =
    input && typeof input === "object" ? input : ({} as ClassifyLaneInput);
  const now = safeNow(safeInput.now);
  const lane = analyzeLane(safeInput.laneStats ?? null);
  const area = analyzeArea(safeInput.areaStats ?? null);

  if (!lane.evidenced && !area.evidenced) {
    return {
      tier: "cold_start",
      score: 0,
      signals: [
        {
          key: "lane_cold_start",
          weight: 0,
          detail:
            "Not enough delivery history yet for this courier in this area. Showing merchant-wide averages instead.",
        },
      ],
      observations: {
        laneCompleted: lane.laneCompleted,
        laneSuccessRate: null,
        laneRtoRate: null,
        areaCompleted: area.areaCompleted,
        areaUnreachableRate: null,
        recent7dRtoRate: null,
      },
      computedAt: now,
    };
  }

  const signals = [...lane.signals, ...area.signals];
  const score = signals.reduce((acc, s) => acc + s.weight, 0);
  const tier = classifyTier(score);
  return {
    tier,
    score,
    signals,
    observations: {
      laneCompleted: lane.laneCompleted,
      laneSuccessRate: lane.laneSuccessRate,
      laneRtoRate: lane.laneRtoRate,
      areaCompleted: area.areaCompleted,
      areaUnreachableRate: area.areaUnreachableRate,
      recent7dRtoRate: area.recent7dRtoRate,
    },
    computedAt: now,
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  MIN_LANE_OBSERVATIONS,
  MIN_AREA_OBSERVATIONS,
  STRONG_SUCCESS_RATE,
  WEAK_RTO_RATE,
  SPEED_STRONG_HOURS,
  HIGH_UNREACHABLE_RATE,
  RECENT_DEGRADE_RATIO,
  MIN_RECENT_OBSERVATIONS,
  STRONG_TIER_THRESHOLD,
  DEGRADED_TIER_THRESHOLD,
  WEIGHTS,
  classifyTier,
  analyzeLane,
  analyzeArea,
};
