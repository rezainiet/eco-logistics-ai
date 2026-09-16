import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { Types } from "mongoose";
import {
  CallEvent,
  CallSession,
  CallingExtension,
  CallingNumber,
  CallingProviderAccount,
  MerchantUser,
  MERCHANT_USER_ROLES,
  MERCHANT_USER_STATUSES,
} from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";
import {
  CallingDomainError,
  createCallingExtension,
  createCallingNumber,
  createCallSession,
  createLocalPbxInboundRoute,
  createMerchantUser,
  provisionLocalPbxExtension,
  processCallEvent,
  startLocalPbxOutboundCall,
  syncLocalPbxCdr,
  transitionCallSession,
  upsertCallingProviderAccount,
} from "../../lib/calling.js";
import { isLocalPbxConfigured, LOCAL_PBX_PROVIDER_KEY } from "../../lib/calling/providers/localPbx.js";

function merchantObjectId(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}

function mapCallingError(err: unknown): never {
  if (err instanceof CallingDomainError) {
    const code =
      err.code === "bad_request"
        ? "BAD_REQUEST"
        : err.code === "not_found"
          ? "NOT_FOUND"
          : err.code === "conflict"
            ? "CONFLICT"
            : err.code === "quota_exhausted"
              ? "FORBIDDEN"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

const objectIdString = z.string().refine((v) => Types.ObjectId.isValid(v), "invalid objectId");

export const callingFoundationRouter = router({
  localPbxStatus: protectedProcedure.query(() => ({
    providerKey: LOCAL_PBX_PROVIDER_KEY,
    configured: isLocalPbxConfigured(),
  })),

  linkLocalPbxAccount: protectedProcedure
    .input(
      z.object({
        providerCustomerId: z.string().trim().min(1).max(160),
        domain: z.string().trim().max(200).optional(),
        status: z.enum(["active", "inactive", "suspended"]).default("active"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const account = await upsertCallingProviderAccount({
          merchantId: ctx.user.id,
          providerCustomerId: input.providerCustomerId,
          providerKey: LOCAL_PBX_PROVIDER_KEY,
          domain: input.domain,
          status: input.status,
        });
        return {
          id: String(account._id),
          providerKey: account.providerKey,
          providerCustomerId: account.providerCustomerId,
          status: account.status,
        };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  getLocalPbxAccount: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx.user.id);
    const account = await CallingProviderAccount.findOne({
      merchantId,
      providerKey: LOCAL_PBX_PROVIDER_KEY,
    }).lean();
    return account
      ? {
          id: String(account._id),
          providerKey: account.providerKey,
          providerCustomerId: account.providerCustomerId,
          domain: account.domain ?? null,
          status: account.status,
          lastSyncedAt: account.lastSyncedAt ?? null,
        }
      : null;
  }),

  createAgent: protectedProcedure
    .input(
      z.object({
        email: z.string().email(),
        name: z.string().trim().max(120).optional(),
        phone: z.string().trim().max(20).optional(),
        role: z.enum(MERCHANT_USER_ROLES).default("agent"),
        status: z.enum(MERCHANT_USER_STATUSES).default("active"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const user = await createMerchantUser({
          merchantId: ctx.user.id,
          ...input,
        });
        return {
          id: String(user._id),
          email: user.email,
          name: user.name ?? null,
          role: user.role,
          status: user.status,
        };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  listAgents: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx.user.id);
    const users = await MerchantUser.find({ merchantId }).sort({ _id: 1 }).lean();
    return users.map((user) => ({
      id: String(user._id),
      email: user.email,
      name: user.name ?? null,
      role: user.role,
      status: user.status,
    }));
  }),

  createExtension: protectedProcedure
    .input(
      z.object({
        extension: z.string().trim().regex(/^\d{2,10}$/),
        assignedUserId: objectIdString.optional(),
        label: z.string().trim().max(120).optional(),
        status: z.enum(["active", "inactive"]).default("active"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const ext = await createCallingExtension({
          merchantId: ctx.user.id,
          ...input,
        });
        return {
          id: String(ext._id),
          extension: ext.extension,
          assignedUserId: ext.assignedUserId ? String(ext.assignedUserId) : null,
          status: ext.status,
        };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  listExtensions: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx.user.id);
    const extensions = await CallingExtension.find({ merchantId }).sort({ extension: 1 }).lean();
    return extensions.map((ext) => ({
      id: String(ext._id),
      extension: ext.extension,
      assignedUserId: ext.assignedUserId ? String(ext.assignedUserId) : null,
      status: ext.status,
    }));
  }),

  provisionLocalPbxExtension: protectedProcedure
    .input(
      z.object({
        extensionId: objectIdString,
        sipPassword: z.string().min(4).max(200),
        isWebrtc: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await provisionLocalPbxExtension({
          merchantId: ctx.user.id,
          extensionId: input.extensionId,
          sipPassword: input.sipPassword,
          isWebrtc: input.isWebrtc,
        });
        return {
          id: String(result.extension._id),
          extension: result.extension.extension,
          providerKey: result.extension.providerKey ?? null,
          providerExtensionId: result.extension.providerExtensionId ?? null,
        };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  createBusinessNumber: protectedProcedure
    .input(
      z.object({
        phoneNumber: z.string().trim().min(7).max(20),
        providerKey: z.string().trim().max(80).optional(),
        providerNumberId: z.string().trim().max(160).optional(),
        label: z.string().trim().max(120).optional(),
        assignedExtensionId: objectIdString.optional(),
        status: z.enum(["active", "inactive"]).default("active"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const number = await createCallingNumber({
          merchantId: ctx.user.id,
          ...input,
        });
        return {
          id: String(number._id),
          phoneNumber: number.phoneNumber,
          normalizedPhone: number.normalizedPhone,
          assignedExtensionId: number.assignedExtensionId ? String(number.assignedExtensionId) : null,
          status: number.status,
        };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  listBusinessNumbers: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx.user.id);
    const numbers = await CallingNumber.find({ merchantId }).sort({ _id: 1 }).lean();
    return numbers.map((number) => ({
      id: String(number._id),
      phoneNumber: number.phoneNumber,
      normalizedPhone: number.normalizedPhone,
      assignedExtensionId: number.assignedExtensionId ? String(number.assignedExtensionId) : null,
      status: number.status,
    }));
  }),

  createLocalPbxInboundRoute: protectedProcedure
    .input(
      z.object({
        businessNumberId: objectIdString,
        destinationType: z.enum(["ivr", "extension", "queue", "time_condition"]),
        destinationId: z.string().trim().min(1).max(160),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const raw = await createLocalPbxInboundRoute({
          merchantId: ctx.user.id,
          ...input,
        });
        return { ok: true, raw };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  createCallSession: protectedProcedure
    .input(
      z.object({
        direction: z.enum(["inbound", "outbound"]),
        agentUserId: objectIdString.optional(),
        customerPhone: z.string().trim().max(40).optional(),
        customerRefType: z.string().trim().max(80).optional(),
        customerRefId: z.string().trim().max(160).optional(),
        extensionId: objectIdString.optional(),
        businessNumberId: objectIdString.optional(),
        providerKey: z.string().trim().max(80).optional(),
        providerCallId: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const session = await createCallSession({
          merchantId: ctx.user.id,
          ...input,
        });
        return {
          id: String(session._id),
          status: session.status,
          direction: session.direction,
          reservedCallMinutes: session.reservedCallMinutes ?? 0,
        };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  startLocalPbxOutboundCall: protectedProcedure
    .input(
      z.object({
        agentUserId: objectIdString.optional(),
        extensionId: objectIdString,
        businessNumberId: objectIdString.optional(),
        customerPhone: z.string().trim().min(7).max(40),
        customerRefType: z.string().trim().max(80).optional(),
        customerRefId: z.string().trim().max(160).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await startLocalPbxOutboundCall({
          merchantId: ctx.user.id,
          ...input,
        });
      } catch (err) {
        mapCallingError(err);
      }
    }),

  transitionCallSession: protectedProcedure
    .input(
      z.object({
        callSessionId: objectIdString,
        status: z.enum([
          "created",
          "queued",
          "ringing",
          "answered",
          "completed",
          "failed",
          "missed",
          "cancelled",
        ]),
        durationSeconds: z.number().int().min(0).optional(),
        failureCode: z.string().trim().max(80).optional(),
        failureReason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const session = await transitionCallSession({
          merchantId: ctx.user.id,
          ...input,
        });
        return {
          id: String(session._id),
          status: session.status,
          durationSeconds: session.durationSeconds ?? 0,
          billedMinutes: session.billedMinutes ?? 0,
        };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  processCallEvent: protectedProcedure
    .input(
      z.object({
        callSessionId: objectIdString,
        providerKey: z.string().trim().min(1).max(80),
        providerEventId: z.string().trim().min(1).max(200),
        eventType: z.string().trim().min(1).max(80),
        durationSeconds: z.number().int().min(0).optional(),
        failureCode: z.string().trim().max(80).optional(),
        failureReason: z.string().trim().max(500).optional(),
        payload: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await processCallEvent({
          merchantId: ctx.user.id,
          ...input,
        });
        return {
          duplicate: result.duplicate,
          eventId: result.event ? String(result.event._id) : null,
          callSessionId: result.session ? String(result.session._id) : input.callSessionId,
          status: result.session?.status ?? null,
        };
      } catch (err) {
        mapCallingError(err);
      }
    }),

  getCallSession: protectedProcedure
    .input(z.object({ callSessionId: objectIdString }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx.user.id);
      const session = await CallSession.findOne({
        _id: input.callSessionId,
        merchantId,
      }).lean();
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "call session not found" });
      return {
        id: String(session._id),
        status: session.status,
        direction: session.direction,
        agentUserId: session.agentUserId ? String(session.agentUserId) : null,
        extensionId: session.extensionId ? String(session.extensionId) : null,
        businessNumberId: session.businessNumberId ? String(session.businessNumberId) : null,
        durationSeconds: session.durationSeconds ?? 0,
        billedMinutes: session.billedMinutes ?? 0,
      };
    }),

  listCallEvents: protectedProcedure
    .input(z.object({ callSessionId: objectIdString }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx.user.id);
      const session = await CallSession.findOne({
        _id: input.callSessionId,
        merchantId,
      })
        .select("_id")
        .lean();
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "call session not found" });
      const events = await CallEvent.find({
        merchantId,
        callSessionId: session._id,
      })
        .sort({ occurredAt: 1 })
        .lean();
      return events.map((event) => ({
        id: String(event._id),
        providerKey: event.providerKey,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        processedAt: event.processedAt ?? null,
      }));
    }),

  syncLocalPbxCdr: protectedProcedure
    .input(
      z
        .object({
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
        .default({}),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await syncLocalPbxCdr({
          merchantId: ctx.user.id,
          startDate: input.startDate,
          endDate: input.endDate,
        });
      } catch (err) {
        mapCallingError(err);
      }
    }),
});
