import type { Types } from "mongoose";
import { currentUsagePeriod, Usage } from "@ecom/db";
import { getPlan, quotaFor, type PlanDefinition, type UsageMetric } from "./plans.js";

/**
 * Atomic monthly-usage increment. Callers pass the merchant's ObjectId and
 * the metric they just "spent" (1 order created, 5 call-minutes burned, etc).
 * No read-modify-write — we $inc with upsert so the counter is race-free.
 */
export async function bumpUsage(
  merchantId: Types.ObjectId,
  metric: UsageMetric,
  delta = 1,
): Promise<void> {
  if (delta === 0) return;
  const period = currentUsagePeriod();
  await Usage.updateOne(
    { merchantId, period },
    {
      $inc: { [metric]: delta },
      $set: { lastActivityAt: new Date() },
    },
    { upsert: true },
  );
}

export async function getCurrentUsage(merchantId: Types.ObjectId) {
  const period = currentUsagePeriod();
  const doc = await Usage.findOne({ merchantId, period }).lean();
  return {
    period,
    ordersCreated: doc?.ordersCreated ?? 0,
    shipmentsBooked: doc?.shipmentsBooked ?? 0,
    fraudReviewsUsed: doc?.fraudReviewsUsed ?? 0,
    callsInitiated: doc?.callsInitiated ?? 0,
    callMinutesUsed: doc?.callMinutesUsed ?? 0,
    lastActivityAt: doc?.lastActivityAt ?? null,
  };
}

export type QuotaCheck = {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  metric: UsageMetric;
};

/**
 * Non-throwing quota lookup. Callers decide whether to block or soft-warn.
 * Returns `allowed = true` when limit is null (unlimited, e.g. enterprise
 * fraud reviews) or when used + amount <= limit.
 */
export async function checkQuota(
  merchantId: Types.ObjectId,
  plan: PlanDefinition,
  metric: UsageMetric,
  amount = 1,
): Promise<QuotaCheck> {
  const limit = quotaFor(plan, metric);
  const usage = await getCurrentUsage(merchantId);
  const used = usage[metric] ?? 0;
  if (limit === null) {
    return { allowed: true, used, limit: null, remaining: null, metric };
  }
  return {
    allowed: used + amount <= limit,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    metric,
  };
}

/**
 * Atomic "reserve N units" quota operation. Uses a conditional `$inc` so two
 * concurrent callers racing against the last slot in a monthly cap cannot
 * both succeed. On a business-logic failure downstream, call `releaseQuota`
 * to refund the reservation.
 */
export async function reserveQuota(
  merchantId: Types.ObjectId,
  plan: PlanDefinition,
  metric: UsageMetric,
  amount = 1,
): Promise<QuotaCheck> {
  if (amount <= 0) {
    return checkQuota(merchantId, plan, metric, 0);
  }
  const limit = quotaFor(plan, metric);
  const period = currentUsagePeriod();
  if (limit === null) {
    await bumpUsage(merchantId, metric, amount);
    return { allowed: true, used: 0, limit: null, remaining: null, metric };
  }
  if (amount > limit) {
    const usage = await getCurrentUsage(merchantId);
    return { allowed: false, used: usage[metric] ?? 0, limit, remaining: 0, metric };
  }
  // Ensure the row exists so the conditional update below has something to match.
  await Usage.updateOne(
    { merchantId, period },
    { $setOnInsert: { merchantId, period }, $set: { lastActivityAt: new Date() } },
    { upsert: true },
  );
  const threshold = limit - amount;
  const reserved = await Usage.findOneAndUpdate(
    { merchantId, period, [metric]: { $lte: threshold } },
    { $inc: { [metric]: amount }, $set: { lastActivityAt: new Date() } },
    { new: true },
  ).lean();
  if (reserved) {
    const usedNow = (reserved as Record<string, unknown>)[metric] as number | undefined ?? amount;
    return {
      allowed: true,
      used: usedNow,
      limit,
      remaining: Math.max(0, limit - usedNow),
      metric,
    };
  }
  const usage = await getCurrentUsage(merchantId);
  return { allowed: false, used: usage[metric] ?? 0, limit, remaining: 0, metric };
}

/**
 * Refund a previously reserved quota amount. No-op on non-positive amounts;
 * callers are responsible for only releasing what they reserved.
 */
export async function releaseQuota(
  merchantId: Types.ObjectId,
  metric: UsageMetric,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  const period = currentUsagePeriod();
  await Usage.updateOne(
    { merchantId, period },
    { $inc: { [metric]: -amount } },
  );
}

export function planFromTier(tier: string | undefined | null): PlanDefinition {
  return getPlan(tier);
}
