import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import {
  COURIER_PROVIDER_NAMES,
  Merchant,
  type MerchantFraudConfig,
  MERCHANT_COUNTRIES,
  MERCHANT_LANGUAGES,
} from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";
import { encryptSecret, maskSecretPayload } from "../../lib/crypto.js";
import { adapterFor, hasCourierAdapter } from "../../lib/couriers/index.js";
import { hashAddress } from "../risk.js";
import { writeAudit } from "../../lib/audit.js";

const PHONE_RE = /^\+?[0-9]{7,15}$/;

async function findMerchantOrThrow(id: string) {
  const merchant = await Merchant.findById(id);
  if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
  return merchant;
}

import type { PlanTier } from "../../lib/plans.js";

function billingView(sub: {
  status?: string;
  tier?: string;
  rate?: number;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
  startDate?: Date | null;
  activatedAt?: Date | null;
} | undefined) {
  const status = (sub?.status ?? "trial") as
    | "trial"
    | "active"
    | "past_due"
    | "paused"
    | "cancelled";
  const trialEndsAt = sub?.trialEndsAt ?? null;
  const now = Date.now();
  const trialDaysLeft =
    status === "trial" && trialEndsAt
      ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now) / 86400_000))
      : null;
  const trialExpired =
    status === "trial" && trialEndsAt ? trialEndsAt.getTime() <= now : false;
  return {
    status,
    tier: (sub?.tier ?? "starter") as PlanTier,
    rate: sub?.rate ?? 0,
    startDate: sub?.startDate ?? null,
    trialEndsAt,
    trialDaysLeft,
    trialExpired,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    activatedAt: sub?.activatedAt ?? null,
  };
}

const upsertCourierInput = z.object({
  name: z.enum(COURIER_PROVIDER_NAMES),
  accountId: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(4).max(500),
  apiSecret: z.string().trim().max(500).optional(),
  baseUrl: z.string().trim().url().max(300).optional(),
  preferredDistricts: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  enabled: z.boolean().optional(),
});

export const merchantsRouter = router({
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const m = await findMerchantOrThrow(ctx.user.id);
    return {
      id: String(m._id),
      email: m.email,
      businessName: m.businessName,
      phone: m.phone,
      country: m.country,
      language: m.language,
      role: m.role,
      createdAt: m.createdAt,
      billing: billingView(m.subscription),
    };
  }),

  updateProfile: protectedProcedure
    .input(
      z
        .object({
          businessName: z.string().trim().min(1).max(200).optional(),
          phone: z.string().regex(PHONE_RE).optional(),
          country: z.enum(MERCHANT_COUNTRIES).optional(),
          language: z.enum(MERCHANT_LANGUAGES).optional(),
        })
        .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" }),
    )
    .mutation(async ({ ctx, input }) => {
      const m = await Merchant.findByIdAndUpdate(
        ctx.user.id,
        { $set: input },
        { new: true, runValidators: true },
      );
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      return {
        id: String(m._id),
        businessName: m.businessName,
        phone: m.phone,
        country: m.country,
        language: m.language,
      };
    }),

  getCouriers: protectedProcedure.query(async ({ ctx }) => {
    const m = await findMerchantOrThrow(ctx.user.id);
    return m.couriers.map((c) => ({
      name: c.name,
      accountId: c.accountId,
      baseUrl: c.baseUrl ?? null,
      preferredDistricts: c.preferredDistricts,
      enabled: c.enabled ?? true,
      apiKeyMasked: maskSecretPayload(c.apiKey),
      apiSecretMasked: c.apiSecret ? maskSecretPayload(c.apiSecret) : null,
      lastValidatedAt: c.lastValidatedAt ?? null,
      validationError: c.validationError ?? null,
      updatedAt: c.updatedAt ?? null,
    }));
  }),

  upsertCourier: protectedProcedure
    .input(upsertCourierInput)
    .mutation(async ({ ctx, input }) => {
      const encryptedApiKey = encryptSecret(input.apiKey);
      const encryptedApiSecret = input.apiSecret ? encryptSecret(input.apiSecret) : undefined;
      const now = new Date();

      const existing = await Merchant.findOne(
        { _id: ctx.user.id, "couriers.name": input.name },
        { _id: 1 },
      ).lean();

      if (existing) {
        const set: Record<string, unknown> = {
          "couriers.$.accountId": input.accountId,
          "couriers.$.apiKey": encryptedApiKey,
          "couriers.$.preferredDistricts": input.preferredDistricts,
          "couriers.$.enabled": input.enabled ?? true,
          "couriers.$.lastValidatedAt": null,
          "couriers.$.validationError": null,
          "couriers.$.updatedAt": now,
        };
        if (input.baseUrl !== undefined) set["couriers.$.baseUrl"] = input.baseUrl;
        if (encryptedApiSecret !== undefined) set["couriers.$.apiSecret"] = encryptedApiSecret;

        const res = await Merchant.updateOne(
          { _id: ctx.user.id, "couriers.name": input.name },
          { $set: set },
        );
        if (res.matchedCount === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
        }
      } else {
        const courier = {
          name: input.name,
          accountId: input.accountId,
          apiKey: encryptedApiKey,
          apiSecret: encryptedApiSecret,
          baseUrl: input.baseUrl,
          preferredDistricts: input.preferredDistricts,
          enabled: input.enabled ?? true,
          updatedAt: now,
        };
        const res = await Merchant.updateOne(
          { _id: ctx.user.id },
          { $push: { couriers: courier } },
        );
        if (res.matchedCount === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
        }
      }

      return {
        name: input.name,
        accountId: input.accountId,
        enabled: input.enabled ?? true,
        preferredDistricts: input.preferredDistricts,
        apiKeyMasked: maskSecretPayload(encryptedApiKey),
        updatedAt: now,
      };
    }),

  validateCourier: protectedProcedure
    .input(z.object({ name: z.enum(COURIER_PROVIDER_NAMES) }))
    .mutation(async ({ ctx, input }) => {
      if (!hasCourierAdapter(input.name)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `courier '${input.name}' does not support credential validation yet`,
        });
      }
      const merchant = await Merchant.findById(ctx.user.id).select("couriers").lean();
      if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      const config = merchant.couriers.find((c) => c.name === input.name);
      if (!config) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `${input.name} is not configured`,
        });
      }

      const result = await adapterFor({
        name: config.name as (typeof COURIER_PROVIDER_NAMES)[number],
        accountId: config.accountId,
        apiKey: config.apiKey,
        apiSecret: config.apiSecret ?? undefined,
        baseUrl: config.baseUrl ?? undefined,
      })
        .validateCredentials()
        .catch((err: Error) => ({ valid: false as const, message: err.message }));

      const now = new Date();
      await Merchant.updateOne(
        { _id: ctx.user.id, "couriers.name": input.name },
        {
          $set: {
            "couriers.$.lastValidatedAt": now,
            "couriers.$.validationError": result.valid ? null : result.message ?? "validation failed",
          },
        },
      );

      return {
        name: input.name,
        valid: result.valid,
        message: result.message ?? null,
        lastValidatedAt: now,
      };
    }),

  removeCourier: protectedProcedure
    .input(z.object({ name: z.enum(COURIER_PROVIDER_NAMES) }))
    .mutation(async ({ ctx, input }) => {
      const res = await Merchant.updateOne(
        { _id: ctx.user.id, "couriers.name": input.name },
        { $pull: { couriers: { name: input.name } } },
      );
      if (res.matchedCount === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "courier not configured" });
      }
      return { name: input.name, removed: true };
    }),

  /**
   * Fetch the merchant's fraud tunables. Unset fields come back as `null` so
   * the UI can show "using platform default" hints without juggling
   * `undefined`.
   */
  getFraudConfig: protectedProcedure.query(async ({ ctx }) => {
    const m = (await Merchant.findById(ctx.user.id)
      .select("fraudConfig")
      .lean()) as { fraudConfig?: MerchantFraudConfig | null } | null;
    const fc: MerchantFraudConfig = m?.fraudConfig ?? {};
    return {
      highCodThreshold: fc.highCodThreshold ?? null,
      extremeCodThreshold: fc.extremeCodThreshold ?? null,
      suspiciousDistricts: fc.suspiciousDistricts ?? [],
      blockedPhones: fc.blockedPhones ?? [],
      /**
       * Returned as hashes only — the UI surfaces "N blocked addresses" and
       * an "Add new" form that the server hashes on write.
       */
      blockedAddresses: fc.blockedAddresses ?? [],
      velocityThreshold: fc.velocityThreshold ?? 0,
      velocityWindowMin: fc.velocityWindowMin ?? 10,
      historyHalfLifeDays: fc.historyHalfLifeDays ?? 30,
      alertOnPendingReview: fc.alertOnPendingReview ?? true,
    };
  }),

  /**
   * Upsert the fraud tunables. Each field is optional — callers pass only
   * what they want to change. Raw addresses arrive via `blockedAddressesRaw`
   * and are hashed server-side with the same fingerprint the scoring path
   * uses so the UI never has to deal with hashing.
   */
  updateFraudConfig: protectedProcedure
    .input(
      z
        .object({
          highCodThreshold: z.number().min(0).max(1_000_000).nullable().optional(),
          extremeCodThreshold: z.number().min(0).max(10_000_000).nullable().optional(),
          suspiciousDistricts: z.array(z.string().trim().min(1).max(100)).max(500).optional(),
          blockedPhones: z.array(z.string().trim().min(4).max(32)).max(5_000).optional(),
          blockedAddressesRaw: z
            .array(
              z.object({
                address: z.string().trim().min(4).max(500),
                district: z.string().trim().min(1).max(100).optional(),
              }),
            )
            .max(5_000)
            .optional(),
          blockedAddresses: z
            .array(z.string().regex(/^[a-f0-9]{16,64}$/i))
            .max(5_000)
            .optional(),
          velocityThreshold: z.number().int().min(0).max(1000).optional(),
          velocityWindowMin: z.number().int().min(1).max(1440).optional(),
          historyHalfLifeDays: z.number().int().min(0).max(3650).optional(),
          alertOnPendingReview: z.boolean().optional(),
        })
        .refine((v) => Object.keys(v).length > 0, {
          message: "no fields to update",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const set: Record<string, unknown> = {};
      const unset: Record<string, 1> = {};

      if (input.highCodThreshold === null) unset["fraudConfig.highCodThreshold"] = 1;
      else if (input.highCodThreshold !== undefined)
        set["fraudConfig.highCodThreshold"] = input.highCodThreshold;

      if (input.extremeCodThreshold === null) unset["fraudConfig.extremeCodThreshold"] = 1;
      else if (input.extremeCodThreshold !== undefined)
        set["fraudConfig.extremeCodThreshold"] = input.extremeCodThreshold;

      if (input.suspiciousDistricts !== undefined) {
        set["fraudConfig.suspiciousDistricts"] = Array.from(
          new Set(input.suspiciousDistricts.map((d) => d.trim()).filter(Boolean)),
        );
      }

      if (input.blockedPhones !== undefined) {
        set["fraudConfig.blockedPhones"] = Array.from(
          new Set(input.blockedPhones.map((p) => p.replace(/\D+/g, "")).filter(Boolean)),
        );
      }

      const hashed = new Set<string>();
      if (input.blockedAddresses !== undefined) {
        for (const h of input.blockedAddresses) hashed.add(h.toLowerCase());
      }
      if (input.blockedAddressesRaw !== undefined) {
        for (const { address, district } of input.blockedAddressesRaw) {
          const h = hashAddress(address, district);
          if (h) hashed.add(h);
        }
      }
      if (
        input.blockedAddresses !== undefined ||
        input.blockedAddressesRaw !== undefined
      ) {
        set["fraudConfig.blockedAddresses"] = [...hashed];
      }

      if (input.velocityThreshold !== undefined)
        set["fraudConfig.velocityThreshold"] = input.velocityThreshold;
      if (input.velocityWindowMin !== undefined)
        set["fraudConfig.velocityWindowMin"] = input.velocityWindowMin;
      if (input.historyHalfLifeDays !== undefined)
        set["fraudConfig.historyHalfLifeDays"] = input.historyHalfLifeDays;
      if (input.alertOnPendingReview !== undefined)
        set["fraudConfig.alertOnPendingReview"] = input.alertOnPendingReview;

      const update: Record<string, unknown> = {};
      if (Object.keys(set).length > 0) update.$set = set;
      if (Object.keys(unset).length > 0) update.$unset = unset;

      const res = (await Merchant.findByIdAndUpdate(ctx.user.id, update, {
        new: true,
        runValidators: true,
      })
        .select("fraudConfig")
        .lean()) as
        | { _id: Types.ObjectId; fraudConfig?: MerchantFraudConfig | null }
        | null;
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });

      void writeAudit({
        merchantId: res._id,
        actorId: res._id,
        actorType: "merchant",
        action: "fraud.config_updated",
        subjectType: "merchant",
        subjectId: res._id,
        meta: { fields: Object.keys(input) },
      });

      const fc: MerchantFraudConfig = res.fraudConfig ?? {};
      return {
        highCodThreshold: fc.highCodThreshold ?? null,
        extremeCodThreshold: fc.extremeCodThreshold ?? null,
        suspiciousDistricts: fc.suspiciousDistricts ?? [],
        blockedPhones: fc.blockedPhones ?? [],
        blockedAddresses: fc.blockedAddresses ?? [],
        velocityThreshold: fc.velocityThreshold ?? 0,
        velocityWindowMin: fc.velocityWindowMin ?? 10,
        historyHalfLifeDays: fc.historyHalfLifeDays ?? 30,
        alertOnPendingReview: fc.alertOnPendingReview ?? true,
      };
    }),
});
