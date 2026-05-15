import express, { type Request, type Response } from "express";
import { parseSmsInbound } from "../../lib/sms-inbound.js";
import { checkSmsWebhookAuth } from "../../lib/sms/webhook-verify.js";
import { normalizePhoneOrRaw } from "../../lib/phone.js";
import { sendOrderExpiredSms } from "../../lib/sms/index.js";
import { applyConfirmationOutcome } from "../../lib/confirmation-outcome.js";
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
 * The state-machine work (scoped lookup, late-reply detection, auto-book
 * cascade, audit) lives in `lib/confirmation-outcome.ts` so every channel
 * (SMS / IVR / WhatsApp / agent / AI voice) takes the same code path. This
 * handler is the SMS-channel adapter: parse provider payload, normalize,
 * delegate, fire SMS-specific courtesy notification on late reply.
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
        body = Object.fromEntries(new URLSearchParams(rawString));
      } else {
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

    const normalizedFrom = normalizePhoneOrRaw(fromRaw) ?? fromRaw;

    // ------------- Delegate to the confirmation outcome engine -----------
    const result = await applyConfirmationOutcome({
      code: intent.code,
      phone: normalizedFrom,
      decision: intent.kind === "confirm" ? "confirm" : "reject",
      channel: "sms",
      meta: { fromTail: normalizedFrom.slice(-4), code: intent.code },
    });

    if (result.kind === "applied") {
      return res
        .status(200)
        .json({ ok: true, intent: intent.kind, orderId: result.orderId });
    }

    if (result.kind === "late_reply") {
      // Channel-specific courtesy: SMS sends an "order expired" template.
      // The engine has already stamped `lateReplyAcknowledgedAt` atomically;
      // we only send when the engine reports this call was the one that did
      // the stamping (suppresses dupes on retried webhook deliveries).
      if (result.acknowledgedJustNow) {
        void sendOrderExpiredSms(result.customerPhone, {
          brand: result.brandName ?? undefined,
          orderNumber: result.orderNumber,
        }).catch((err) =>
          console.error("[sms-inbound] late reply SMS failed:", (err as Error).message),
        );
      }
      return res
        .status(200)
        .json({ ok: true, ignored: "order expired — courtesy SMS sent" });
    }

    if (result.kind === "ignored") {
      return res.status(200).json({
        ok: true,
        ignored:
          result.reason === "cannot_transition"
            ? `cannot ${intent.kind} from ${result.currentState ?? "?"}`
            : `order status ${result.currentStatus ?? "?"} — too late to reject`,
      });
    }

    // no_match — telemetry-only log; do not reveal which dimension mismatched.
    console.warn(
      JSON.stringify({
        msg: "sms_inbound",
        outcome: "no_match",
        code: intent.code,
        fromTail: normalizedFrom.slice(-4),
      }),
    );
    return res.status(200).json({ ok: true, ignored: "no matching pending order" });
  },
);
