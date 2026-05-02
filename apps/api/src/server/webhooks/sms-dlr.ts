import express, { type Request, type Response } from "express";
import type { Types } from "mongoose";
import { Order } from "@ecom/db";
import { parseDlrPayload, type DlrParsed } from "../../lib/sms-dlr.js";
import { writeAudit } from "../../lib/audit.js";
import { dispatchNotification } from "../../lib/notifications.js";
import { checkSmsWebhookAuth } from "../../lib/sms/webhook-verify.js";
import { normalizePhoneOrRaw } from "../../lib/phone.js";
import { env } from "../../env.js";

/**
 * SMS DLR webhook.
 *
 * Mounted at `/api/webhooks/sms-dlr`. Provider-agnostic — accepts JSON or
 * url-encoded payloads from SSL Wireless and similar BD gateways. Always
 * returns 200 so the provider doesn't loop on a payload we choose to ignore.
 *
 * SECURITY: every POST is HMAC-verified against SMS_WEBHOOK_SHARED_SECRET.
 * Same scheme as the inbound webhook — one shared secret across both.
 *
 * SCOPED LOOKUP: order is matched on `automation.confirmationCode` AND
 * (when the gateway provides msisdn) the customer's normalized phone. A
 * code that matches but with a different phone is silently ignored.
 *
 * Behaviour:
 *  - delivered → stamps confirmationDeliveredAt + status="delivered"
 *  - failed    → stamps confirmationDeliveryFailedAt, escalates to
 *                requires_review, fires critical merchant notification
 *  - pending   → updates status if not already final
 *  - unknown   → logs + 200
 *
 * Idempotency: filter requires `confirmationDeliveryStatus IN
 * {pending, unknown}` so duplicate DLRs are no-ops.
 */
export const smsDlrWebhookRouter = express.Router();

smsDlrWebhookRouter.post(
  "/",
  // Read RAW body so HMAC verification matches what the gateway signed.
  express.raw({ type: "*/*", limit: "256kb" }),
  async (req: Request, res: Response) => {
    const rawBuf = req.body as Buffer;
    if (!Buffer.isBuffer(rawBuf) || rawBuf.length === 0) {
      return res.status(400).json({ ok: false, error: "missing body" });
    }
    const rawString = rawBuf.toString("utf8");

    // ------------------------------ HMAC --------------------------------
    const auth = checkSmsWebhookAuth(rawString, req.headers, env.SMS_WEBHOOK_SHARED_SECRET);
    if (!auth.ok) {
      if (env.NODE_ENV === "production") {
        return res.status(401).json({ ok: false, error: "invalid signature" });
      }
      console.warn(
        `[sms-dlr] DEV: bypassing HMAC verification (${auth.reason}). ` +
          "Set SMS_WEBHOOK_SHARED_SECRET in production.",
      );
    }

    // ------------------------------ Parse -------------------------------
    let body: Record<string, unknown> = {};
    const contentType = (req.headers["content-type"] ?? "").toString().toLowerCase();
    try {
      if (contentType.includes("application/json")) {
        body = JSON.parse(rawString) as Record<string, unknown>;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(rawString));
      } else {
        try {
          body = JSON.parse(rawString) as Record<string, unknown>;
        } catch {
          body = Object.fromEntries(new URLSearchParams(rawString));
        }
      }
    } catch {
      return res.status(200).json({ ok: true, ignored: "unparseable body" });
    }

    const parsed: DlrParsed = parseDlrPayload(body);
    if (!parsed.code) {
      return res.status(200).json({ ok: true, ignored: "no confirmation code in payload" });
    }
    if (parsed.status === "unknown") {
      console.log(
        JSON.stringify({ msg: "sms_dlr", outcome: "unknown_status", code: parsed.code }),
      );
      return res.status(200).json({ ok: true, ignored: "unknown status" });
    }

    // -------------------- Scoped lookup (code + phone) -------------------
    // SSL Wireless / AdnSMS payloads carry the recipient msisdn — when
    // present, we tighten the match to (code, phone) so a guessed/leaked
    // code can't flip an order belonging to a different customer.
    const msisdn = String(body.msisdn ?? body.to ?? body.recipient ?? "").trim();
    const normalizedTo = msisdn ? normalizePhoneOrRaw(msisdn) ?? msisdn : null;

    const lookupFilter: Record<string, unknown> = {
      "automation.confirmationCode": parsed.code,
    };
    if (normalizedTo) lookupFilter["customer.phone"] = normalizedTo;

    const order = await Order.findOne(lookupFilter)
      .select(
        "_id merchantId orderNumber automation.state automation.confirmationDeliveryStatus customer.phone",
      )
      .lean();
    if (!order) {
      console.warn(
        JSON.stringify({
          msg: "sms_dlr",
          outcome: "no_match",
          code: parsed.code,
          msisdnTail: normalizedTo ? normalizedTo.slice(-4) : null,
        }),
      );
      return res.status(200).json({ ok: true, ignored: "no order for code" });
    }

    const merchantOid = order.merchantId as Types.ObjectId;
    const orderOid = order._id as Types.ObjectId;
    const currentDlrStatus =
      (order as { automation?: { confirmationDeliveryStatus?: string } }).automation
        ?.confirmationDeliveryStatus ?? "pending";
    const automationState =
      (order as { automation?: { state?: string } }).automation?.state ?? "not_evaluated";

    if (
      (parsed.status === "delivered" && currentDlrStatus === "delivered") ||
      (parsed.status === "failed" && currentDlrStatus === "failed")
    ) {
      console.log(
        JSON.stringify({
          msg: "sms_dlr",
          outcome: "duplicate",
          status: parsed.status,
          orderId: String(orderOid),
        }),
      );
      return res.status(200).json({ ok: true, duplicate: true });
    }

    /* ------------------------------ delivered ----------------------------- */
    if (parsed.status === "delivered") {
      const writeRes = await Order.updateOne(
        {
          _id: orderOid,
          merchantId: merchantOid,
          "automation.confirmationDeliveryStatus": { $in: ["pending", "unknown"] },
        },
        {
          $set: {
            "automation.confirmationDeliveryStatus": "delivered",
            "automation.confirmationDeliveredAt": parsed.deliveredAt ?? new Date(),
            ...(parsed.providerRef
              ? { "automation.confirmationDeliveryProviderRef": parsed.providerRef }
              : {}),
          },
        },
      );
      if (writeRes.modifiedCount === 0) {
        return res.status(200).json({ ok: true, idempotent: true });
      }
      void writeAudit({
        merchantId: merchantOid,
        actorId: merchantOid,
        actorType: "system",
        action: "automation.confirmation_sms_delivered",
        subjectType: "order",
        subjectId: orderOid,
        meta: { code: parsed.code, providerRef: parsed.providerRef },
      }).catch(() => {});
      return res.status(200).json({ ok: true, status: "delivered" });
    }

    /* ------------------------------- pending ------------------------------ */
    if (parsed.status === "pending") {
      void Order.updateOne(
        {
          _id: orderOid,
          merchantId: merchantOid,
          "automation.confirmationDeliveryStatus": { $in: ["pending", "unknown"] },
        },
        {
          $set: {
            "automation.confirmationDeliveryStatus": "pending",
            ...(parsed.providerRef
              ? { "automation.confirmationDeliveryProviderRef": parsed.providerRef }
              : {}),
          },
        },
      );
      return res.status(200).json({ ok: true, status: "pending" });
    }

    /* -------------------------------- failed ------------------------------ */
    const writeRes = await Order.updateOne(
      {
        _id: orderOid,
        merchantId: merchantOid,
        "automation.confirmationDeliveryStatus": { $in: ["pending", "unknown"] },
      },
      {
        $set: {
          "automation.confirmationDeliveryStatus": "failed",
          "automation.confirmationDeliveryFailedAt": new Date(),
          ...(parsed.providerRef
            ? { "automation.confirmationDeliveryProviderRef": parsed.providerRef }
            : {}),
          ...(parsed.error
            ? { "automation.confirmationDeliveryError": parsed.error.slice(0, 500) }
            : {}),
        },
      },
    );
    if (writeRes.modifiedCount === 0) {
      return res.status(200).json({ ok: true, idempotent: true });
    }

    if (automationState === "pending_confirmation") {
      const escalate = await Order.updateOne(
        {
          _id: orderOid,
          merchantId: merchantOid,
          "automation.state": "pending_confirmation",
        },
        {
          $set: {
            "automation.state": "requires_review",
            "automation.decidedBy": "system",
            "automation.decidedAt": new Date(),
            "automation.reason": "SMS confirmation failed to deliver",
          },
        },
      );
      if (escalate.modifiedCount > 0) {
        void dispatchNotification({
          merchantId: merchantOid,
          kind: "fraud.pending_review",
          severity: "critical",
          title: `Order ${order.orderNumber}: customer didn't receive confirmation SMS`,
          body: `The provider rejected the confirmation SMS${parsed.error ? ` (${parsed.error.slice(0, 100)})` : ""}. Order moved to your review queue — call the customer or confirm manually.`,
          link: `/dashboard/fraud-review?id=${String(orderOid)}`,
          subjectType: "order",
          subjectId: orderOid,
          dedupeKey: `sms_dlr_failed:${String(orderOid)}`,
          meta: { code: parsed.code, error: parsed.error, providerRef: parsed.providerRef },
        }).catch((err) =>
          console.error("[sms-dlr] notify failed:", (err as Error).message),
        );
      }
    }

    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.confirmation_sms_undelivered",
      subjectType: "order",
      subjectId: orderOid,
      meta: { code: parsed.code, error: parsed.error, providerRef: parsed.providerRef },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      status: "failed",
      escalated: automationState === "pending_confirmation",
    });
  },
);
