import { Types } from "mongoose";
import { Merchant, Order, PendingAwb, WebhookInbox } from "@ecom/db";
import { registerCourierWebhook } from "./webhook-registration.js";
import type { CourierName } from "./types.js";

/**
 * Per-courier connection & sync health for one merchant — what the courier
 * settings page shows so a provider problem is visible before it costs a
 * parcel. Read-only, merchant-scoped, built from data the booking, webhook
 * and polling paths already record (nothing here is estimated):
 *
 *   connection  last credential check (merchants.upsertCourier validates)
 *   webhook     the callback URL to paste in the courier portal, whether a
 *               webhook secret is set, when the last pushed update landed,
 *               and pushed updates that failed to apply (last 7 days)
 *   shipments   active (shipped / in transit) parcels and those needing
 *               attention: a sync error, a courier-reported delivery problem,
 *               or no courier update for STALE_DAYS
 *   bookings    failed booking attempts (7 days) and orphaned AWBs from the
 *               pending-AWB ledger
 */

export const STALE_DAYS = 5;
const DAY = 86_400_000;
const ACTIVE = ["shipped", "in_transit"] as const;
const ACTIVE_CAP = 2000;
const ATTENTION_CAP = 20;

export type AttentionIssue = "sync_error" | "delivery_issue" | "no_update";

interface ActiveRow {
  _id: Types.ObjectId;
  orderNumber: string;
  logistics?: {
    shippedAt?: Date;
    pollErrorCount?: number;
    pollError?: string;
    trackingEvents?: Array<{ at: Date; providerStatus: string; normalizedStatus: string }>;
  };
}

export async function courierHealth(merchantId: Types.ObjectId, now = new Date()) {
  const merchant = await Merchant.findById(merchantId).select("couriers").lean();
  const couriers = merchant?.couriers ?? [];
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const staleBefore = now.getTime() - STALE_DAYS * DAY;
  // Orders created in the last 30 days bound the "last update" scan.
  const recentId = Types.ObjectId.createFromTime(Math.floor((now.getTime() - 30 * DAY) / 1000));

  return Promise.all(
    couriers.map(async (c) => {
      const name = c.name as CourierName;
      const [active, recent, failedBookings, lastFailure, orphaned, failedWebhooks, webhook] = await Promise.all([
        Order.find({ merchantId, "logistics.courier": name, "order.status": { $in: [...ACTIVE] } })
          .select({
            orderNumber: 1,
            "logistics.shippedAt": 1,
            "logistics.pollErrorCount": 1,
            "logistics.pollError": 1,
            "logistics.trackingEvents": { $slice: -1 },
          })
          .sort({ _id: -1 })
          .limit(ACTIVE_CAP)
          .lean<ActiveRow[]>(),
        Order.aggregate<{ lastWebhookAt: Date | null; lastPolledAt: Date | null }>([
          {
            $match: {
              merchantId,
              "logistics.courier": name,
              "order.status": { $in: [...ACTIVE, "delivered", "rto"] },
              _id: { $gte: recentId },
            },
          },
          { $group: { _id: null, lastWebhookAt: { $max: "$logistics.lastWebhookAt" }, lastPolledAt: { $max: "$logistics.lastPolledAt" } } },
        ]),
        PendingAwb.countDocuments({ merchantId, courier: name, status: "failed", requestedAt: { $gte: weekAgo } }),
        PendingAwb.findOne({ merchantId, courier: name, status: "failed" })
          .sort({ requestedAt: -1 })
          .select("requestedAt lastError orderId")
          .lean(),
        // Created at the courier but not attached to the order (or the
        // reconciler gave up) — needs a manual look at the courier portal.
        PendingAwb.countDocuments({ merchantId, courier: name, status: { $in: ["orphaned", "abandoned"] } }),
        WebhookInbox.countDocuments({ merchantId, provider: name, status: "failed", receivedAt: { $gte: weekAgo } }),
        registerCourierWebhook({ courier: name, merchantId: String(merchantId) }),
      ]);

      const attention: Array<{ orderId: string; orderNumber: string; issue: AttentionIssue; detail: string }> = [];
      let syncErrors = 0;
      let deliveryIssues = 0;
      let stale = 0;
      for (const o of active) {
        const last = o.logistics?.trackingEvents?.[0];
        const issue: { issue: AttentionIssue; detail: string } | null =
          last?.normalizedStatus === "failed"
            ? { issue: "delivery_issue", detail: last.providerStatus }
            : (o.logistics?.pollErrorCount ?? 0) > 0
              ? { issue: "sync_error", detail: o.logistics?.pollError ?? "tracking sync failed" }
              : (last?.at ?? o.logistics?.shippedAt ?? o._id.getTimestamp()).getTime() < staleBefore
                ? { issue: "no_update", detail: last ? `last: ${last.providerStatus}` : "no courier update yet" }
                : null;
        if (!issue) continue;
        if (issue.issue === "delivery_issue") deliveryIssues++;
        else if (issue.issue === "sync_error") syncErrors++;
        else stale++;
        if (attention.length < ATTENTION_CAP) attention.push({ orderId: String(o._id), orderNumber: o.orderNumber, ...issue });
      }

      return {
        name,
        enabled: c.enabled !== false,
        connection: {
          lastValidatedAt: c.lastValidatedAt ?? null,
          validationError: c.validationError ?? null,
        },
        webhook: {
          callbackUrl: webhook.callbackUrl,
          instructions: webhook.instructions ?? null,
          secretConfigured: Boolean(c.apiSecret),
          lastReceivedAt: recent[0]?.lastWebhookAt ?? null,
          failedLast7d: failedWebhooks,
        },
        shipments: {
          active: active.length,
          activeCapped: active.length >= ACTIVE_CAP,
          lastPolledAt: recent[0]?.lastPolledAt ?? null,
          syncErrors,
          deliveryIssues,
          stale,
          attention,
        },
        bookings: {
          failedLast7d: failedBookings,
          lastFailure: lastFailure
            ? { at: lastFailure.requestedAt ?? null, error: lastFailure.lastError ?? null, orderId: String(lastFailure.orderId) }
            : null,
          orphaned,
        },
      };
    }),
  );
}
