import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { Order, Merchant } from "@ecom/db";
import { parseSmsInbound } from "../../lib/sms-inbound.js";
import { writeAudit } from "../../lib/audit.js";
import { canTransitionAutomation } from "../../lib/automation.js";
import { enqueueAutoBook } from "../../workers/automationBook.js";
import { checkSmsWebhookAuth } from "../../lib/sms/webhook-verify.js";
import { normalizePhoneOrRaw } from "../../lib/phone.js";
import { sendOrderExpiredSms } from "../../lib/sms/index.js";
import { env } from "../../env.js";

/**
 * Inbound-SMS webhook.
 *
 * Mounted at `/api/webhooks/sms-inbound`. Provider-agnostic — accepts a
 * canonical { from, body } shape. Provider-specific adapters (SSL Wireless,
 * AdnSMS, BulkSMS BD, etc.) shape their MO payload into this canonical
 * form first via small mappers added under the same route prefix.
 *
 * SECURITY: every POST is HMAC-verified against SMS_WEBHOOK_SHARED_SECRET.
 * Unsigned/invalid posts are rejected with 401 in production. In dev, when
 * the secret is unset, the route logs a loud warning and proceeds — keeps
 * localhost testing without a gateway working.
 *
 * SCOPED LOOKUP: the order is matched on BOTH `automation.confirmationCode`
 * AND the customer's normalized phone. A code that doesn't match the
 * sender's phone is silently ignored — closes the cross-merchant
 * collision window for 6/8-digit codes.
 *
 * Idempotency: state-machine guarded — a confirm+confirm or reject+reject
 * is a 200 ok no-op. A reject after confirm is allowed only when the order
 * has not yet shipped.
 */
export const smsInboundWebhookRouter = express.Router();

smsInboundWebhookRouter.post(
  "/",
  // Read RAW body so the HMAC computation matches what the gateway signed.
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
        // Do not reveal whether secret is misconfigured vs signature mismatch.
        return res.status(401).json({ ok: false, error: "invalid signature" });
      }
      // Dev / staging: bypass-with-warning so localhost testing without a
      // configured gateway still works. NEVER reach this branch in prod.
      console.warn(
        `[sms-inbound] DEV: bypassing HMAC verification (${auth.reason}). ` +
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
        // URL-encoded parse via URLSearchParams (no external dep)
        body = Object.fromEntries(new URLSearchParams(rawString));
      } else {
        // Try JSON first, fall through to url-encoded heuristic.
        try {
          body = JSON.parse(rawString) as Record<string, unknown>;
        } catch {
          body = Object.fromEntries(new URLSearchParams(rawString));
        }
      }
    } catch {
      // Always 200 — providers retry on non-2xx and we don't want them to
      // bang on a malformed payload.
      return res.status(200).json({ ok: true, ignored: "unparseable body" });
    }

    const fromRaw = String(body.from ?? body.msisdn ?? body.sender ?? "").trim();
    const text = String(body.body ?? body.text ?? body.message ?? body.sms ?? "").trim();
    if (!fromRaw || !text) {
      return res.status(200).json({ ok: true, ignored: "missing from/body" });
    }

    const intent = parseSmsInbound(text);
    if (intent.kind === "ignore") {
      return res.status(200).json({ ok: true, ignored: intent.reason });
    }

    // -------------------- Scoped lookup (code + phone) -------------------
    // Normalize both phones to E.164 before comparing. The webhook's
    // `from` field comes straight from the gateway and may be in 88017…,
    // +88017…, or 017… format depending on carrier.
    const normalizedFrom = normalizePhoneOrRaw(fromRaw) ?? fromRaw;

    const order = await Order.findOne({
      "automation.confirmationCode": intent.code,
      "automation.state": "pending_confirmation",
      "customer.phone": normalizedFrom,
    })
      .select("_id merchantId order.status automation customer.phone")
      .lean();

    if (!order) {
      // Late-reply detection: the customer is replying with a code that
      // belongs to an order we already auto-rejected (no-reply timeout).
      // We re-look-up without the pending_confirmation guard, scoped to
      // recently-rejected system-decided orders, and send a one-time
      // courtesy SMS so the customer learns their YES/NO didn't land.
      const LATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
      const lateCutoff = new Date(Date.now() - LATE_WINDOW_MS);
      const expired = await Order.findOne({
        "automation.confirmationCode": intent.code,
        "customer.phone": normalizedFrom,
        "automation.state": "rejected",
        "automation.decidedBy": "system",
        "automation.rejectedAt": { $gte: lateCutoff },
      })
        .select("_id merchantId orderNumber customer.phone automation.lateReplyAcknowledgedAt")
        .lean<{
          _id: Types.ObjectId;
          merchantId: Types.ObjectId;
          orderNumber: string;
          customer: { phone: string };
          automation?: { lateReplyAcknowledgedAt?: Date };
        }>();

      if (expired && !expired.automation?.lateReplyAcknowledgedAt) {
        // Best-effort: stamp the order BEFORE sending so a duplicate webhook
        // delivery can't trigger a second SMS even if the send is racing.
        const stamped = await Order.updateOne(
          {
            _id: expired._id,
            merchantId: expired.merchantId,
            "automation.lateReplyAcknowledgedAt": { $exists: false },
          },
          { $set: { "automation.lateReplyAcknowledgedAt": new Date() } },
        );
        if (stamped.modifiedCount > 0) {
          const merchant = await Merchant.findById(expired.merchantId)
            .select("businessName")
            .lean();
          void sendOrderExpiredSms(expired.customer.phone, {
            brand: (merchant as { businessName?: string } | null)?.businessName,
            orderNumber: expired.orderNumber,
          }).catch((err) =>
            console.error("[sms-inbound] late reply SMS failed:", (err as Error).message),
          );
          void writeAudit({
            merchantId: expired.merchantId,
            actorId: expired.merchantId,
            actorType: "system",
            action: "automation.auto_expired",
            subjectType: "order",
            subjectId: expired._id,
            meta: {
              outcome: "late_reply_acknowledged",
              codeTail: intent.code.slice(-4),
            },
          });
        }
        return res.status(200).json({ ok: true, ignored: "order expired — courtesy SMS sent" });
      }

      // Don't reveal which dimension didn't match — security telemetry only.
      console.warn(
        JSON.stringify({
          msg: "sms_inbound",
          outcome: "no_match",
          code: intent.code,
          fromTail: normalizedFrom.slice(-4),
        }),
      );
      return res.status(200).json({ ok: true, ignored: "no matching pending order" });
    }

    const fromState = (order as { automation?: { state?: string } }).automation?.state ?? "not_evaluated";
    const target = intent.kind === "confirm" ? "confirmed" : "rejected";
    if (
      !canTransitionAutomation(
        fromState as Parameters<typeof canTransitionAutomation>[0],
        target,
      )
    ) {
      return res.status(200).json({ ok: true, ignored: `cannot ${target} from ${fromState}` });
    }

    const status = (order as { order?: { status?: string } }).order?.status;
    if (intent.kind === "reject" && status && !["pending", "confirmed"].includes(status)) {
      return res.status(200).json({
        ok: true,
        ignored: `order status ${status} — too late to reject`,
      });
    }

    const now = new Date();
    const merchantOid = order.merchantId as Types.ObjectId;
    const orderOid = order._id as Types.ObjectId;

    if (intent.kind === "confirm") {
      const set: Record<string, unknown> = {
        "automation.state": "confirmed",
        "automation.decidedBy": "agent",
        "automation.decidedAt": now,
        "automation.confirmedAt": now,
        "automation.reason": "customer SMS YES",
        // SMS confirmation is the strongest possible "this is a real customer"
        // signal — relax the fraud review state so the order can ship without
        // an agent call. (We never relax a terminal review; the rejected/
        // verified branch in markRejected/markVerified owns those.)
        "fraud.smsFeedback": "confirmed",
        "fraud.smsFeedbackAt": now,
      };
      if (status === "pending") set["order.status"] = "confirmed";
      const writeRes = await Order.updateOne(
        { _id: orderOid, merchantId: merchantOid, "automation.state": "pending_confirmation" },
        { $set: set },
      );

      // Auto-book after SMS confirm — symmetric with create-time path.
      // Fires only on a real state flip (modifiedCount>0) so a second
      // identical reply doesn't enqueue a second job.
      if (writeRes.modifiedCount > 0) {
        try {
          const merchant = await Merchant.findById(merchantOid)
            .select("automationConfig couriers")
            .lean();
          const cfg = (merchant as { automationConfig?: { autoBookEnabled?: boolean; autoBookCourier?: string } } | null)?.automationConfig ?? {};
          if (cfg.autoBookEnabled === true) {
            const courierName =
              cfg.autoBookCourier ??
              ((merchant as { couriers?: Array<{ name: string; enabled?: boolean }> } | null)?.couriers ?? [])
                .find((c) => c.enabled !== false)?.name;
            if (courierName) {
              void enqueueAutoBook({
                orderId: String(orderOid),
                merchantId: String(merchantOid),
                userId: String(merchantOid),
                courier: courierName,
              }).catch((err) =>
                console.error("[sms-inbound] auto-book enqueue failed:", (err as Error).message),
              );
            }
          }
        } catch (err) {
          console.error("[sms-inbound] auto-book lookup failed:", (err as Error).message);
        }
      }
    } else {
      await Order.updateOne(
        { _id: orderOid, merchantId: merchantOid, "automation.state": "pending_confirmation" },
        {
          $set: {
            "automation.state": "rejected",
            "automation.decidedBy": "agent",
            "automation.decidedAt": now,
            "automation.rejectedAt": now,
            "automation.rejectionReason": "customer SMS NO",
            "order.status": "cancelled",
            // Customer self-rejected → strongest fraud signal. Mark for the
            // queue (rescore worker will fan it out to other open orders for
            // the same phone via the existing review.rejected → enqueueRescore
            // path is owned by fraud.markRejected, not here, so we only mark
            // this one).
            "fraud.smsFeedback": "rejected",
            "fraud.smsFeedbackAt": now,
            "fraud.reviewStatus": "rejected",
          },
        },
      );
    }

    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: `automation.sms_${intent.kind}`,
      subjectType: "order",
      subjectId: orderOid,
      meta: { fromTail: normalizedFrom.slice(-4), code: intent.code },
    }).catch(() => {});

    return res.status(200).json({ ok: true, intent: intent.kind, orderId: String(orderOid) });
  },
);
