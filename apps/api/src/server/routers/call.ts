import { Types } from "mongoose";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CallLog, Order } from "@ecom/db";
import { env } from "../../env.js";
import { billableProcedure, protectedProcedure, router } from "../trpc.js";
import { getVoiceProvider } from "../../lib/voice/index.js";
import { invalidate } from "../../lib/cache.js";
import { bumpUsage, checkQuota } from "../../lib/usage.js";
import { getPlan } from "../../lib/plans.js";
import { Merchant } from "@ecom/db";

const phoneSchema = z
  .string()
  .trim()
  .min(7, "phone too short")
  .max(20, "phone too long")
  .regex(/^[0-9+\-\s()]+$/, "invalid phone characters");

/**
 * The voice subsystem's webhook base URL. Falls back to the legacy
 * TWILIO_WEBHOOK_BASE_URL so existing Twilio-configured deploys keep
 * working unchanged. Provider-specific callback paths are appended by
 * the caller — the legacy Twilio webhook lives at /api/webhooks/twilio/*,
 * BD adapters will mount under /api/webhooks/voice/*.
 */
function voiceWebhookBase(): string {
  const base =
    env.VOICE_WEBHOOK_BASE_URL ??
    env.TWILIO_WEBHOOK_BASE_URL ??
    env.PUBLIC_API_URL ??
    `http://localhost:${env.API_PORT}`;
  return base.replace(/\/$/, "");
}

function legacyTwilioStatusCallbackUrl(): string {
  return `${voiceWebhookBase()}/api/webhooks/twilio/call-status`;
}

export const callRouter = router({
  isConfigured: protectedProcedure.query(() => ({
    configured: getVoiceProvider().isConfigured(),
  })),

  initiateCall: billableProcedure
    .input(
      z.object({
        customerPhone: phoneSchema,
        customerName: z.string().trim().max(200).optional(),
        orderId: z.string().optional(),
        record: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const voice = getVoiceProvider();
      if (!voice.isConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Voice provider '${voice.name}' is not configured`,
        });
      }

      const merchantDoc = await Merchant.findById(ctx.user.id)
        .select("subscription.tier")
        .lean();
      const plan = getPlan(merchantDoc?.subscription?.tier);
      const quota = await checkQuota(new Types.ObjectId(ctx.user.id), plan, "callsInitiated");
      if (!quota.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `call minute quota reached (${quota.used}/${quota.limit}) — upgrade your plan`,
        });
      }

      const merchantId = new Types.ObjectId(ctx.user.id);

      let orderId: Types.ObjectId | undefined;
      if (input.orderId) {
        if (!Types.ObjectId.isValid(input.orderId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "invalid orderId" });
        }
        const order = await Order.findById(input.orderId).select("merchantId").lean();
        if (!order || !merchantId.equals(order.merchantId)) {
          throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
        }
        orderId = new Types.ObjectId(input.orderId);
      }
      const normalizedPhone = voice.normalizePhone(input.customerPhone);

      let voiceResult;
      try {
        voiceResult = await voice.initiateOutboundCall({
          to: normalizedPhone,
          statusCallbackUrl: legacyTwilioStatusCallbackUrl(),
          record: input.record,
        });
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Voice call failed",
        });
      }

      const now = new Date();
      const log = await CallLog.create({
        merchantId,
        orderId,
        timestamp: now,
        hour: now.getHours(),
        dayOfWeek: now.getDay(),
        duration: 0,
        answered: false,
        callType: "outgoing",
        customerPhone: normalizedPhone,
        customerName: input.customerName,
        callSid: voiceResult.callId,
        providerName: voice.name,
        purpose: "agent_outreach",
        attemptNumber: 1,
        status: voiceResult.providerStatus ?? undefined,
        from: voiceResult.from,
        to: voiceResult.to ?? normalizedPhone,
        startedAt: now,
      });

      await bumpUsage(merchantId, "callsInitiated", 1);
      await invalidate(`dashboard:${ctx.user.id}`);

      return {
        id: String(log._id),
        callSid: voiceResult.callId,
        status: voiceResult.providerStatus,
      };
    }),

  hangupCall: protectedProcedure
    .input(z.object({ callSid: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = new Types.ObjectId(ctx.user.id);
      const log = await CallLog.findOne({ merchantId, callSid: input.callSid })
        .select("_id")
        .lean();
      if (!log) {
        throw new TRPCError({ code: "NOT_FOUND", message: "call not found" });
      }

      try {
        const result = await getVoiceProvider().hangup(input.callSid);
        return { callSid: result.callId, status: result.providerStatus };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Voice hangup failed",
        });
      }
    }),

  getCallStatus: protectedProcedure
    .input(z.object({ callSid: z.string().trim().min(1) }))
    .query(async ({ ctx, input }) => {
      const merchantId = new Types.ObjectId(ctx.user.id);
      const log = await CallLog.findOne({ merchantId, callSid: input.callSid }).lean();
      if (!log) {
        throw new TRPCError({ code: "NOT_FOUND", message: "call not found" });
      }

      let liveStatus: string | null = null;
      let liveDuration: number | null = null;
      try {
        const details = await getVoiceProvider().getCallDetails(input.callSid);
        liveStatus = details.providerStatus;
        liveDuration = details.duration;
      } catch {
        // Provider fetch failed — fall back to persisted state
      }

      return {
        callSid: input.callSid,
        status: liveStatus ?? log.status ?? null,
        duration: liveDuration ?? log.duration ?? 0,
        answered: log.answered ?? false,
        recordingUrl: log.recordingUrl ?? null,
        customerPhone: log.customerPhone ?? null,
        customerName: log.customerName ?? null,
        startedAt: log.startedAt ?? null,
        endedAt: log.endedAt ?? null,
      };
    }),

  getRecentCalls: protectedProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(50).default(20) })
        .default({ limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = new Types.ObjectId(ctx.user.id);
      const calls = await CallLog.find({
        merchantId,
        callSid: { $exists: true, $ne: null },
      })
        .sort({ _id: -1 })
        .limit(input.limit)
        .lean();

      return calls.map((c) => ({
        id: String(c._id),
        callSid: c.callSid ?? null,
        customerPhone: c.customerPhone ?? null,
        customerName: c.customerName ?? null,
        status: c.status ?? null,
        answered: c.answered ?? false,
        duration: c.duration ?? 0,
        recordingUrl: c.recordingUrl ?? null,
        timestamp: c.timestamp,
        startedAt: c.startedAt ?? null,
        endedAt: c.endedAt ?? null,
      }));
    }),
});
