import type { Job } from "bullmq";
import { Types } from "mongoose";
import { FraudPrediction, Merchant } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";

/**
 * Monthly fraud-weight tuner.
 *
 * For each active merchant with enough resolved predictions, this worker:
 *
 *   1. Pulls the last 90 days of predictions where `outcome` is set.
 *   2. For each signal key, computes:
 *        - precision = P(outcome=rto | signal fired)
 *        - lift      = precision / merchant base RTO rate
 *   3. Converts lift into a multiplier in [0.5, 1.5] — high-lift signals
 *      amplify, low-lift dampen. Multipliers are capped on each side so a
 *      noisy month can't whiplash the engine.
 *   4. Recomputes the merchant's `baseRtoRate` from the actual outcome mix.
 *   5. Persists `signalWeightOverrides`, `baseRtoRate`, `lastTunedAt`,
 *      `weightsVersion` on the merchant.
 *
 * Why monthly: signal stability matters more than reactivity. Weekly tuning
 * over-fits to seasonal blips (Eid, end-of-month bulk). Quarterly is too
 * lagging when a merchant's vertical shifts. Monthly is the sweet spot.
 *
 * Why per-merchant: a beauty-product merchant's "extreme COD" looks nothing
 * like an electronics merchant's. The static platform weights average them
 * to the worst of both worlds.
 */

const REPEAT_JOB_NAME = "fraud-weight-tuning:sweep";
/** Run on the 1st of each month at 03:15 UTC. Cron format: m h dom mon dow. */
const DEFAULT_CRON = "15 3 1 * *";
const LOOKBACK_DAYS = 90;
/** Floor on resolved predictions before we trust the per-merchant signal. */
const MIN_SAMPLE_SIZE = 50;
/** Per-signal floor — without N hits, we don't tune that key for the merchant. */
const MIN_SIGNAL_HITS = 10;
const MULTIPLIER_FLOOR = 0.5;
const MULTIPLIER_CEIL = 1.5;

export interface TuningResult {
  merchantId: string;
  sampleSize: number;
  baseRtoRate: number;
  weightsVersion: string;
  perSignal: Record<string, { hits: number; precision: number; multiplier: number }>;
  skipped?: string;
}

export interface TuningSweepResult {
  merchantsScanned: number;
  merchantsTuned: number;
  merchantsSkipped: number;
  results: TuningResult[];
}

/**
 * Tune one merchant in isolation. Exposed for tests + the dashboard's
 * "tune now" admin button.
 */
export async function tuneMerchantFraudWeights(
  merchantId: Types.ObjectId,
  now: Date = new Date(),
): Promise<TuningResult> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400_000);
  const rows = (await FraudPrediction.find(
    {
      merchantId,
      outcome: { $exists: true },
      outcomeAt: { $gte: since },
    },
    { signals: 1, outcome: 1, levelPredicted: 1 },
  )
    .lean()
    .limit(20_000)) as Array<{
    signals?: Array<{ key: string; weight: number }>;
    outcome?: "delivered" | "rto" | "cancelled";
    levelPredicted?: "low" | "medium" | "high";
  }>;

  if (rows.length < MIN_SAMPLE_SIZE) {
    return {
      merchantId: String(merchantId),
      sampleSize: rows.length,
      baseRtoRate: 0,
      weightsVersion: "untuned",
      perSignal: {},
      skipped: "insufficient_sample",
    };
  }

  const rtoCount = rows.filter((r) => r.outcome === "rto").length;
  // Cancelled orders are partial signal — they may have been merchant-side
  // (out of stock) rather than buyer-side. Excluded from the base rate.
  const resolvedNonCancelled = rows.filter((r) => r.outcome !== "cancelled");
  const baseRtoRate =
    resolvedNonCancelled.length > 0 ? rtoCount / resolvedNonCancelled.length : 0;

  // For each signal key, count fired hits and how many of those ended in RTO.
  const perKey = new Map<string, { hits: number; rtoHits: number }>();
  for (const row of rows) {
    if (row.outcome === "cancelled") continue; // exclude from precision math
    const fired = new Set((row.signals ?? []).map((s) => s.key));
    for (const key of fired) {
      const bucket = perKey.get(key) ?? { hits: 0, rtoHits: 0 };
      bucket.hits += 1;
      if (row.outcome === "rto") bucket.rtoHits += 1;
      perKey.set(key, bucket);
    }
  }

  const perSignal: TuningResult["perSignal"] = {};
  const overrides: Record<string, number> = {};
  for (const [key, bucket] of perKey) {
    if (bucket.hits < MIN_SIGNAL_HITS) continue;
    const precision = bucket.rtoHits / bucket.hits;
    // Lift = signal-conditioned precision divided by base rate. >1 means
    // the signal is more predictive than chance for this merchant.
    const lift = baseRtoRate > 0 ? precision / baseRtoRate : 1;
    // Smooth — sqrt brings extreme lifts back toward 1, then clamp.
    const raw = Math.sqrt(lift);
    const multiplier = Math.max(MULTIPLIER_FLOOR, Math.min(MULTIPLIER_CEIL, raw));
    perSignal[key] = {
      hits: bucket.hits,
      precision: Math.round(precision * 10000) / 10000,
      multiplier: Math.round(multiplier * 100) / 100,
    };
    overrides[key] = multiplier;
  }

  const weightsVersion = `tuned-${now.toISOString().slice(0, 7)}`;
  await Merchant.updateOne(
    { _id: merchantId },
    {
      $set: {
        "fraudConfig.signalWeightOverrides": overrides,
        "fraudConfig.baseRtoRate": Math.round(baseRtoRate * 10000) / 10000,
        "fraudConfig.lastTunedAt": now,
        "fraudConfig.weightsVersion": weightsVersion,
      },
    },
  );

  return {
    merchantId: String(merchantId),
    sampleSize: rows.length,
    baseRtoRate: Math.round(baseRtoRate * 10000) / 10000,
    weightsVersion,
    perSignal,
  };
}

/** Tune every merchant that has at least one resolved prediction in the window. */
export async function sweepFraudWeightTuning(): Promise<TuningSweepResult> {
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400_000);
  const merchantIds = (await FraudPrediction.distinct("merchantId", {
    outcomeAt: { $gte: since },
  })) as Types.ObjectId[];

  const results: TuningResult[] = [];
  let tuned = 0;
  let skipped = 0;
  for (const id of merchantIds) {
    try {
      const r = await tuneMerchantFraudWeights(id, now);
      results.push(r);
      if (r.skipped) skipped += 1;
      else tuned += 1;
    } catch (err) {
      console.error(
        `[fraud-weight-tuning] merchant=${String(id)} failed:`,
        (err as Error).message,
      );
      skipped += 1;
    }
  }

  return {
    merchantsScanned: merchantIds.length,
    merchantsTuned: tuned,
    merchantsSkipped: skipped,
    results,
  };
}

export function registerFraudWeightTuningWorker() {
  return registerWorker<unknown, TuningSweepResult>(
    QUEUE_NAMES.fraudWeightTuning,
    async (job: Job<unknown>) => {
      const res = await sweepFraudWeightTuning();
      console.log(
        `[fraud-weight-tuning] job=${job.id} scanned=${res.merchantsScanned} tuned=${res.merchantsTuned} skipped=${res.merchantsSkipped}`,
      );
      return res;
    },
    { concurrency: 1 },
  );
}

export async function scheduleFraudWeightTuning(
  cron: string = DEFAULT_CRON,
): Promise<void> {
  const q = getQueue(QUEUE_NAMES.fraudWeightTuning);
  const repeatables = await q.getRepeatableJobs();
  await Promise.all(
    repeatables
      .filter((r) => r.name === REPEAT_JOB_NAME)
      .map((r) => q.removeRepeatableByKey(r.key)),
  );
  await q.add(
    REPEAT_JOB_NAME,
    {},
    { repeat: { pattern: cron }, jobId: REPEAT_JOB_NAME },
  );
  console.log(`[fraud-weight-tuning] scheduled cron=${cron}`);
}
