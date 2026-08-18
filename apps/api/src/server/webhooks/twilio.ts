import express, { type Request, type Response } from "express";
import { CallLog } from "@ecom/db";
import { env } from "../../env.js";
import { validateSignature } from "../../lib/twilio.js";
import { invalidate } from "../../lib/cache.js";
import { bumpUsage, releaseQuota } from "../../lib/usage.js";

export const twilioWebhookRouter = express.Router();

const TERMINAL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

function billableMinutes(duration: number | undefined): number {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.ceil(duration / 60);
}

twilioWebhookRouter.post(
  "/call-status",
  express.urlencoded({ extended: false }),
  async (req: Request, res: Response) => {
    const signature = req.headers["x-twilio-signature"];
    const fullUrl = `${env.TWILIO_WEBHOOK_BASE_URL ?? `${req.protocol}://${req.get("host")}`}${req.originalUrl}`;
    const params = (req.body ?? {}) as Record<string, string>;

    if (env.NODE_ENV === "production") {
      const ok = validateSignature(
        typeof signature === "string" ? signature : undefined,
        fullUrl,
        params,
      );
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

    const logBefore = await CallLog.findOneAndUpdate(
      { callSid },
      { $set: update },
      { new: false },
    )
      .select("merchantId reservedCallMinutes usageFinalizedAt")
      .lean();

    if (logBefore?.merchantId) {
      if (status && TERMINAL_STATUSES.has(status)) {
        const minutes = billableMinutes(duration);
        const finalized = await CallLog.findOneAndUpdate(
          {
            callSid,
            usageFinalizedAt: { $exists: false },
          },
          {
            $set: {
              billedMinutes: minutes,
              usageFinalizedAt: new Date(),
            },
          },
          { new: false },
        )
          .select("merchantId reservedCallMinutes")
          .lean();
        if (finalized?.merchantId) {
          const reserved = finalized.reservedCallMinutes ?? 0;
          const delta = minutes - reserved;
          if (delta > 0) {
            await bumpUsage(finalized.merchantId, "callMinutesUsed", delta);
          } else if (delta < 0) {
            await releaseQuota(finalized.merchantId, "callMinutesUsed", Math.abs(delta));
          }
        }
      }
      await invalidate(`dashboard:${String(logBefore.merchantId)}`);
    }

    return res.json({ ok: true });
  },
);
