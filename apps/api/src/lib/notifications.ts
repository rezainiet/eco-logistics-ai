/**
 * Notification dispatcher.
 *
 * Wraps `Notification.create` (in-app inbox) with an optional SMS fan-out
 * for high-severity events. Existing direct `Notification.updateOne(...)`
 * call-sites (e.g. `alerts.ts`) are intentionally left alone — this helper
 * is for new code paths so they don't have to repeat the
 * "in-app + maybe SMS" boilerplate.
 *
 * Dedupe is the caller's responsibility (pass `dedupeKey`). Both writes
 * (in-app + SMS) are best-effort and never throw into the request path.
 */

import { Types } from "mongoose";
import {
  Merchant,
  Notification,
  type NotificationKind,
} from "@ecom/db";
import { sendCriticalAlertSms } from "./sms/index.js";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface DispatchNotificationInput {
  merchantId: Types.ObjectId;
  kind: NotificationKind;
  severity?: NotificationSeverity;
  title: string;
  body?: string;
  link?: string;
  subjectType?: "order" | "merchant" | "integration";
  subjectId?: Types.ObjectId;
  meta?: Record<string, unknown>;
  /** Pass to enable in-app row dedupe. Re-using the same key collapses to one row. */
  dedupeKey?: string;
  /**
   * Force-skip the SMS fan-out even on `critical` severity. Useful when the
   * caller is replaying historical events or when the alert is internal.
   */
  skipSms?: boolean;
}

export interface DispatchNotificationResult {
  inAppCreated: boolean;
  smsSent: boolean;
}

export async function dispatchNotification(
  input: DispatchNotificationInput,
): Promise<DispatchNotificationResult> {
  const severity = input.severity ?? "warning";
  let inAppCreated = false;
  let smsSent = false;

  // 1. In-app inbox row.
  try {
    if (input.dedupeKey) {
      const r = await Notification.updateOne(
        { merchantId: input.merchantId, dedupeKey: input.dedupeKey },
        {
          $setOnInsert: {
            merchantId: input.merchantId,
            kind: input.kind,
            severity,
            title: input.title,
            body: input.body,
            link: input.link,
            subjectType: input.subjectType ?? "order",
            subjectId: input.subjectId,
            meta: input.meta,
            dedupeKey: input.dedupeKey,
          },
        },
        { upsert: true },
      );
      inAppCreated = (r.upsertedCount ?? 0) > 0;
    } else {
      await Notification.create({
        merchantId: input.merchantId,
        kind: input.kind,
        severity,
        title: input.title,
        body: input.body,
        link: input.link,
        subjectType: input.subjectType ?? "order",
        subjectId: input.subjectId,
        meta: input.meta,
      });
      inAppCreated = true;
    }
  } catch (err) {
    console.error("[notifications] in-app write failed", (err as Error).message);
  }

  // 2. SMS fan-out for critical events (only if not deduped to existing row).
  if (severity === "critical" && !input.skipSms && inAppCreated) {
    try {
      const m = await Merchant.findById(input.merchantId)
        .select("phone businessName")
        .lean();
      if (m?.phone) {
        const r = await sendCriticalAlertSms(m.phone, input.title, {
          brand: m.businessName,
          tag: `notify_${input.kind}`,
        });
        smsSent = r.ok;
      }
    } catch (err) {
      console.error("[notifications] sms fan-out failed", (err as Error).message);
    }
  }

  return { inAppCreated, smsSent };
}
