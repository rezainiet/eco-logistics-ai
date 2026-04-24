import { Types } from "mongoose";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CallLog } from "@ecom/db";
import { env } from "../../env.js";
import { billableProcedure, protectedProcedure, router } from "../trpc.js";
import {
  getCallDetails,
  hangupCall,
  initiateCall,
  isTwilioConfigured,
  normalizePhone,
} from "../../lib/twilio.js";
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

function statusCallbackUrl(): string {
  const base = env.TWILIO_WEBHOOK_BASE_URL ?? `http://localhost:${env.API_PORT}`;
  return `${base.replace(/\/$/, "")}/api/webhooks/twilio/call-status`;
}

export const callRouter = router({
  isConfigured: protectedProcedure.query(() => ({ configured: isTwilioConfigured() })),

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
      if (!isTwilioConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Twilio is not configured",
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

      let orderId: Types.ObjectId | undefined;
      if (input.orderId) {
        if (!Types.ObjectId.isValid(input.orderId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "invalid orderId" });
        }
        orderId = new Types.ObjectId(input.orderId);
      }

      const merchantId = new Types.ObjectId(ctx.user.id);
      const normalizedPhone = normalizePhone(input.customerPhone);

      let twilioResult;
      try {
        twilioResult = await initiateCall({
          to: normalizedPhone,
          statusCallbackUrl: statusCallbackUrl(),
          record: input.record,
        });
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Twilio call failed",
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
        callSid: twilioResult.sid,
        status: twilioResult.status,
        from: twilioResult.from ?? env.TWILIO_PHONE_NUMBER,
        to: twilioResult.to ?? normalizedPhone,
        startedAt: now,
      });

      await bumpUsage(merchantId, "callsInitiated", 1);
      await invalidate(`dashboard:${ctx.user.id}`);

      return {
        id: String(log._id),
        callSid: twilioResult.sid,
        status: twilioResult.status,
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
        const result = await hangupCall(input.callSid);
        return { callSid: result.sid, status: result.status };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Twilio hangup failed",
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
        const details = await getCallDetails(input.callSid);
        liveStatus = details.status ?? null;
        liveDuration = details.duration;
      } catch {
        // Twilio fetch failed — fall back to persisted state
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
