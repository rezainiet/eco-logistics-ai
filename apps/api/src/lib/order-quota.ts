import type { Types } from "mongoose";
import { currentUsagePeriod, Notification, WebhookInbox } from "@ecom/db";
import { dispatchNotification } from "./notifications.js";
import { getPlan } from "./plans.js";

/**
 * Monthly order quota exhaustion — what the merchant sees when orders
 * arrive after the plan's `orderQuota` is used up.
 *
 * The quota itself is decided by `reserveQuota` (lib/usage.ts) against
 * `PLANS[tier].features.orderQuota`; nothing here bypasses or re-derives
 * it. Store orders (webhooks, order sync) that hit the cap are HELD in the
 * webhook inbox — status `needs_attention`, skipReason
 * `ORDER_QUOTA_EXCEEDED` — with their payload, never created past the
 * quota, never auto-retried, and replayed from Integrations → Issues once
 * there is capacity (upgrade or the monthly reset). Landing-page checkouts
 * have no stored payload to hold: the buyer is told the store isn't taking
 * orders, and the merchant is told how many were turned away.
 */

/** The typed reason: `IngestResult.code` and the held inbox row's `skipReason`. */
export const ORDER_QUOTA_EXCEEDED = "order_quota_exceeded" as const;

export interface OrderQuotaDetail {
  metric: "ordersCreated";
  used: number;
  limit: number | null;
  tier: string;
}

/** How many store orders are held for the order quota right now. */
export function orderQuotaHeldCount(merchantId: Types.ObjectId): Promise<number> {
  return WebhookInbox.countDocuments({ merchantId, status: "needs_attention", skipReason: ORDER_QUOTA_EXCEEDED });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function orderQuotaNoticeBody(args: { planName: string; limit: number | null; held: number; checkoutsRefused: number }): string {
  const parts = [
    `Your ${args.planName} plan's ${args.limit === null ? "" : `${args.limit.toLocaleString("en-US")} `}orders for this month are used up.`,
  ];
  if (args.held > 0) {
    parts.push(`${plural(args.held, "store order is", "store orders are")} held safely — received, not lost, just not created yet.`);
  }
  if (args.checkoutsRefused > 0) {
    parts.push(`${plural(args.checkoutsRefused, "landing-page checkout was", "landing-page checkouts were")} turned away.`);
  }
  parts.push("Upgrade your plan or wait for the monthly reset, then replay held orders from Integrations → Issues.");
  return parts.join(" ");
}

/**
 * Tell the merchant the order quota is used up. ONE notification per
 * merchant per usage period (dedupe key on the period), through the same
 * dispatcher as every other notification — repeated deliveries, replays
 * and further held orders refresh its counts instead of adding rows.
 * Best-effort: never throws into ingestion.
 */
export async function notifyOrderQuotaReached(
  merchantId: Types.ObjectId,
  quota: OrderQuotaDetail,
  event: "held" | "checkout_refused",
): Promise<void> {
  try {
    const planName = getPlan(quota.tier).name;
    const dedupeKey = `order-quota:${currentUsagePeriod()}`;
    await dispatchNotification({
      merchantId,
      kind: "subscription.order_quota_reached",
      severity: "critical",
      title: "Monthly order quota reached — new orders on hold",
      body: orderQuotaNoticeBody({ planName, limit: quota.limit, held: 0, checkoutsRefused: 0 }),
      link: "/dashboard/settings/integrations/issues",
      subjectType: "merchant",
      subjectId: merchantId,
      meta: { metric: quota.metric, limit: quota.limit, tier: quota.tier, held: 0, checkoutsRefused: 0 },
      dedupeKey,
    });
    const held = await orderQuotaHeldCount(merchantId);
    const row = await Notification.findOneAndUpdate(
      { merchantId, dedupeKey },
      {
        $set: { "meta.held": held, "meta.used": quota.used, "meta.limit": quota.limit, "meta.tier": quota.tier },
        ...(event === "checkout_refused" ? { $inc: { "meta.checkoutsRefused": 1 } } : {}),
      },
      { new: true },
    ).lean();
    if (!row) return;
    const checkoutsRefused = Number((row.meta as { checkoutsRefused?: number } | undefined)?.checkoutsRefused ?? 0);
    await Notification.updateOne(
      { _id: row._id },
      { $set: { body: orderQuotaNoticeBody({ planName, limit: quota.limit, held, checkoutsRefused }) } },
    );
  } catch (err) {
    console.error("[order-quota] notification failed", (err as Error).message);
  }
}
