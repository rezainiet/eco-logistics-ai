import type { Job } from "bullmq";
import { Types } from "mongoose";
import { Merchant, type MerchantFraudConfig, Order } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { writeAudit } from "../lib/audit.js";
import { fireFraudAlert } from "../lib/alerts.js";
import {
  collectRiskHistory,
  computeRisk,
  hashAddress,
  type RiskOptions,
} from "../server/risk.js";

/**
 * Worker: given a trigger (new RTO, no-answer, review action, …), rescore
 * every still-open order with the same phone for that merchant so the
 * signals stay current. Runs out-of-band of the caller's request path so a
 * tracking-sync event can fan-out to dozens of affected orders without
 * blocking.
 *
 * Rescore never overrides a *terminal* review status (verified / rejected).
 * It does promote non-terminal orders to `pending_call` when the refreshed
 * signals push score into HIGH, and fires an alert the first time that
 * happens per (merchantId, orderId) pair.
 */

export interface RescoreJobData {
  merchantId: string;
  phone: string;
  /** Why the recompute was requested — surfaces in the audit trail. */
  trigger:
    | "order.rto"
    | "order.cancelled"
    | "review.no_answer"
    | "review.rejected"
    | "manual";
  /** Order that caused the fan-out — excluded from the rescore set. */
  triggerOrderId?: string;
}

export interface RescoreJobResult {
  rescored: number;
  elevatedToHigh: number;
  alerts: number;
  errors: number;
}

const NON_TERMINAL_STATUSES = [
  "pending",
  "confirmed",
  "packed",
  "shipped",
  "in_transit",
];
const TERMINAL_REVIEW = new Set(["verified", "rejected"]);

function buildRiskOpts(fc: MerchantFraudConfig): RiskOptions {
  return {
    highCodBdt: fc.highCodThreshold ?? undefined,
    extremeCodBdt: fc.extremeCodThreshold ?? undefined,
    suspiciousDistricts: fc.suspiciousDistricts ?? [],
    blockedPhones: fc.blockedPhones ?? [],
    blockedAddresses: fc.blockedAddresses ?? [],
    velocityThreshold: fc.velocityThreshold ?? 0,
  };
}

export async function processRescoreJob(
  data: RescoreJobData,
): Promise<RescoreJobResult> {
  if (!Types.ObjectId.isValid(data.merchantId)) {
    return { rescored: 0, elevatedToHigh: 0, alerts: 0, errors: 0 };
  }
  const merchantId = new Types.ObjectId(data.merchantId);
  const excludeId =
    data.triggerOrderId && Types.ObjectId.isValid(data.triggerOrderId)
      ? new Types.ObjectId(data.triggerOrderId)
      : undefined;

  const merchant = (await Merchant.findById(merchantId)
    .select("fraudConfig")
    .lean()) as { fraudConfig?: MerchantFraudConfig | null } | null;
  if (!merchant) {
    return { rescored: 0, elevatedToHigh: 0, alerts: 0, errors: 0 };
  }
  const fc: MerchantFraudConfig = merchant.fraudConfig ?? {};
  const opts = buildRiskOpts(fc);
  const halfLifeDays = fc.historyHalfLifeDays ?? 30;
  const velocityWindowMin = fc.velocityWindowMin ?? 10;

  // All open orders for this phone — the triggering order is excluded since
  // it is already in a terminal status (rto / cancelled) and its rescore
  // would be wasted work.
  const openOrders = await Order.find({
    merchantId,
    "customer.phone": data.phone,
    "order.status": { $in: NON_TERMINAL_STATUSES },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select("_id orderNumber customer order.cod source.ip source.addressHash fraud.reviewStatus fraud.level")
    .lean();

  if (openOrders.length === 0) {
    return { rescored: 0, elevatedToHigh: 0, alerts: 0, errors: 0 };
  }

  // One history lookup per order — we need per-IP + per-address context, and
  // `collectRiskHistory` already batches the three underlying queries.
  let rescored = 0;
  let elevatedToHigh = 0;
  let alerts = 0;
  let errors = 0;

  for (const order of openOrders) {
    try {
      const addressHash =
        order.source?.addressHash ??
        hashAddress(order.customer?.address ?? "", order.customer?.district ?? "");
      const history = await collectRiskHistory({
        merchantId,
        phone: data.phone,
        ip: order.source?.ip ?? undefined,
        addressHash: addressHash ?? undefined,
        excludeOrderId: order._id as Types.ObjectId,
        halfLifeDays,
        velocityWindowMin,
      });
      const risk = computeRisk(
        {
          cod: order.order?.cod ?? 0,
          customer: {
            name: order.customer?.name ?? "",
            phone: order.customer?.phone ?? data.phone,
            address: order.customer?.address,
            district: order.customer?.district ?? "",
          },
          ip: order.source?.ip ?? undefined,
          addressHash,
        },
        history,
        opts,
      );

      const currentReview = order.fraud?.reviewStatus ?? "not_required";
      const nextReview = TERMINAL_REVIEW.has(currentReview)
        ? currentReview
        : risk.reviewStatus;

      const wasHigh = order.fraud?.level === "high";
      const nowHigh = risk.level === "high";

      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            "fraud.detected": risk.level === "high",
            "fraud.riskScore": risk.riskScore,
            "fraud.level": risk.level,
            "fraud.reasons": risk.reasons,
            "fraud.signals": risk.signals,
            "fraud.reviewStatus": nextReview,
            "fraud.scoredAt": new Date(),
          },
        },
      );

      rescored += 1;
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "system",
        action: "risk.recomputed",
        subjectType: "order",
        subjectId: order._id as Types.ObjectId,
        meta: {
          trigger: data.trigger,
          level: risk.level,
          score: risk.riskScore,
          reasons: risk.reasons,
        },
      });

      if (nowHigh && !wasHigh && !TERMINAL_REVIEW.has(currentReview)) {
        elevatedToHigh += 1;
        alerts += 1;
        await fireFraudAlert({
          merchantId,
          orderId: order._id as Types.ObjectId,
          orderNumber: order.orderNumber,
          phone: data.phone,
          riskScore: risk.riskScore,
          level: risk.level,
          reasons: risk.reasons,
          kind: "fraud.rescored_high",
          title: `Order ${order.orderNumber} escalated to HIGH risk`,
          body: `Automatic rescore after ${data.trigger}. Risk ${risk.riskScore}/100. Reasons: ${risk.reasons.slice(0, 3).join(", ") || "n/a"}`,
        });
      }
    } catch (err) {
      errors += 1;
      console.error("[risk-recompute] order", String(order._id), (err as Error).message);
    }
  }

  return { rescored, elevatedToHigh, alerts, errors };
}

export function registerRiskRecomputeWorker() {
  return registerWorker<RescoreJobData, RescoreJobResult>(
    QUEUE_NAMES.risk,
    async (job: Job<RescoreJobData>) => {
      const res = await processRescoreJob(job.data);
      if (res.rescored > 0 || res.errors > 0) {
        console.log(
          `[risk-recompute] job=${job.id} trigger=${job.data.trigger} rescored=${res.rescored} elevated=${res.elevatedToHigh} alerts=${res.alerts} errors=${res.errors}`,
        );
      }
      return res;
    },
    { concurrency: 2 },
  );
}

/**
 * Best-effort enqueue helper — callers don't need to await Redis; if the
 * queue is unavailable (dev without Redis) we swallow the error so the
 * user-facing write path doesn't fail.
 */
export async function enqueueRescore(
  data: RescoreJobData,
  opts: { delayMs?: number } = {},
): Promise<void> {
  try {
    const q = getQueue(QUEUE_NAMES.risk);
    await q.add(`rescore:${data.trigger}`, data, {
      delay: opts.delayMs,
      removeOnComplete: { count: 500, age: 3600 },
      removeOnFail: { count: 1000, age: 24 * 3600 },
      // Dedupe against a burst of identical events within a short window.
      jobId: `${data.merchantId}:${data.phone}:${data.trigger}:${Math.floor(Date.now() / 10_000)}`,
    });
  } catch (err) {
    // In test / dev without Redis, fall back to synchronous processing so
    // the rescore still happens — merchants cannot lose signal reliability
    // just because Redis is degraded.
    console.warn("[risk-recompute] enqueue fell back to sync:", (err as Error).message);
    await processRescoreJob(data).catch((e) =>
      console.error("[risk-recompute] sync fallback failed", e),
    );
  }
}
