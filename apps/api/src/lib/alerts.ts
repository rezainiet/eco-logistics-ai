import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { Merchant, Notification, type NotificationKind } from "@ecom/db";
import { writeAudit } from "./audit.js";
import { sendCriticalAlertSms } from "./sms/index.js";

export interface FraudAlertInput {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber?: string;
  phone?: string;
  riskScore: number;
  level: "low" | "medium" | "high";
  reasons: string[];
  kind?: NotificationKind;
  severity?: "info" | "warning" | "critical";
  title?: string;
  body?: string;
}

/**
 * Fire-and-forget alert writer. We write:
 *  1. A `Notification` row (in-app inbox).
 *  2. An `AuditLog` entry so the action shows up in compliance exports.
 *
 * Alerts are dedupe-keyed per (merchantId, orderId, kind) so rescore runs
 * that repeatedly flip an order to pending_call only spawn one notification.
 * Merchants can disable inbox writes via `fraudConfig.alertOnPendingReview`.
 */
export async function fireFraudAlert(input: FraudAlertInput): Promise<void> {
  const kind = input.kind ?? "fraud.pending_review";
  const severity = input.severity ?? (input.level === "high" ? "critical" : "warning");
  const dedupeKey = createHash("sha1")
    .update(`${String(input.merchantId)}:${String(input.orderId)}:${kind}`)
    .digest("hex")
    .slice(0, 24);

  let shouldNotify = true;
  let merchantPhone: string | undefined;
  let merchantBrand: string | undefined;
  try {
    const m = await Merchant.findById(input.merchantId)
      .select("fraudConfig.alertOnPendingReview phone businessName")
      .lean();
    if (m && m.fraudConfig?.alertOnPendingReview === false) {
      shouldNotify = false;
    }
    merchantPhone = m?.phone ?? undefined;
    merchantBrand = m?.businessName ?? undefined;
  } catch {
    // Best-effort — if we can't read the merchant, still alert.
  }

  if (shouldNotify) {
    try {
      await Notification.updateOne(
        { merchantId: input.merchantId, dedupeKey },
        {
          $setOnInsert: {
            merchantId: input.merchantId,
            kind,
            severity,
            title:
              input.title ??
              `High-risk order${input.orderNumber ? ` ${input.orderNumber}` : ""} needs review`,
            body:
              input.body ??
              `Risk ${input.riskScore}/100 (${input.level}). Reasons: ${input.reasons.slice(0, 3).join(", ") || "n/a"}`,
            link: `/dashboard/fraud-review?id=${input.orderId}`,
            subjectType: "order" as const,
            subjectId: input.orderId,
            meta: {
              riskScore: input.riskScore,
              level: input.level,
              reasons: input.reasons,
              phone: input.phone,
            },
            dedupeKey,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error("[fraud-alert] notification write failed", (err as Error).message);
    }
  }

  // BD merchants live on their phones — fan critical fraud alerts out
  // to SMS in addition to the in-app inbox. Best-effort, never blocks
  // the alert pipeline.
  if (shouldNotify && severity === "critical" && merchantPhone) {
    try {
      const summary =
        input.title ??
        `High-risk order${input.orderNumber ? " " + input.orderNumber : ""} (risk ${input.riskScore})`;
      void sendCriticalAlertSms(merchantPhone, summary, {
        brand: merchantBrand,
        tag: `fraud_${kind}`,
      }).catch((err) =>
        console.error("[fraud-alert] sms fan-out failed", (err as Error).message),
      );
    } catch (err) {
      console.error("[fraud-alert] sms fan-out setup failed", (err as Error).message);
    }
  }

  void writeAudit({
    merchantId: input.merchantId,
    actorId: input.merchantId,
    actorType: "system",
    action: "risk.alerted",
    subjectType: "order",
    subjectId: input.orderId,
    meta: {
      kind,
      riskScore: input.riskScore,
      level: input.level,
      reasons: input.reasons,
    },
  });
}
