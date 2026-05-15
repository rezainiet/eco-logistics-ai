import express, { type Request, type Response } from "express";
import { CallLog } from "@ecom/db";
import { env } from "../../env.js";
import { getVoiceProvider } from "../../lib/voice/index.js";
import { invalidate } from "../../lib/cache.js";

/**
 * Legacy Twilio call-status webhook.
 *
 * Mounted at /api/webhooks/twilio/call-status. Kept around because the
 * existing `call.initiateOutboundCall` adapter still registers Twilio's
 * statusCallback at this path. The unified BD voice webhook lives at
 * /api/webhooks/voice/* (added in PR 2) and uses the provider's HMAC
 * signature scheme rather than Twilio's auth-token signature.
 *
 * Signature verification is delegated to the active VoiceProvider — when
 * VOICE_PROVIDER=twilio the Twilio scheme runs; otherwise this endpoint
 * refuses all posts in production (the legacy Twilio adapter is the only
 * thing that should ever target this path).
 */
export const twilioWebhookRouter = express.Router();

const TERMINAL_STATUSES = new Set([
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
]);

twilioWebhookRouter.post(
  "/call-status",
  express.urlencoded({ extended: false }),
  async (req: Request, res: Response) => {
    const signature = req.headers["x-twilio-signature"];
    const base =
      env.VOICE_WEBHOOK_BASE_URL ??
      env.TWILIO_WEBHOOK_BASE_URL ??
      `${req.protocol}://${req.get("host")}`;
    const fullUrl = `${base.replace(/\/$/, "")}${req.originalUrl}`;
    const params = (req.body ?? {}) as Record<string, string>;

    if (env.NODE_ENV === "production") {
      const voice = getVoiceProvider();
      if (voice.name !== "twilio") {
        // Production callback to the legacy path while a non-Twilio adapter
        // is active means either a stale webhook URL registered upstream or
        // a spoofed post. Either way, refuse.
        return res
          .status(404)
          .json({ ok: false, error: "twilio webhook disabled" });
      }
      const ok = voice.verifyWebhookSignature({
        signature: typeof signature === "string" ? signature : undefined,
        fullUrl,
        params,
      });
      if (!ok) {
        return res.status(403).json({ ok: false, error: "invalid signature" });
      }
    }

    const callSid = params.CallSid;
    if (!callSid) {
      return res.status(400).json({ ok: false, error: "missing CallSid" });
    }

    const status = params.CallStatus;
    const durationStr = params.CallDuration;
    const duration = durationStr ? Number(durationStr) : undefined;

    const update: Record<string, unknown> = {};
    if (status) update.status = status;
    if (duration !== undefined && !Number.isNaN(duration)) {
      update.duration = duration;
      update.answered = duration > 0;
    }
    if (params.RecordingUrl) update.recordingUrl = params.RecordingUrl;
    if (params.RecordingSid) update.recordingSid = params.RecordingSid;
    if (params.Price) update.price = Number(params.Price);
    if (params.PriceUnit) update.priceUnit = params.PriceUnit;
    if (params.ErrorCode) update.errorCode = params.ErrorCode;
    if (params.ErrorMessage) update.errorMessage = params.ErrorMessage;
    if (status && TERMINAL_STATUSES.has(status)) {
      update.endedAt = new Date();
    }

    const log = await CallLog.findOneAndUpdate(
      { callSid },
      { $set: update },
      { new: true },
    )
      .select("merchantId")
      .lean();

    if (log?.merchantId) {
      await invalidate(`dashboard:${String(log.merchantId)}`);
    }

    return res.json({ ok: true });
  },
);
