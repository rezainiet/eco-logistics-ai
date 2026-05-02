import { TRPCError } from "@trpc/server";
import bcrypt from "bcryptjs";
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
import { registerCourierWebhook } from "../../lib/couriers/webhook-registration.js";
import { hashAddress } from "../risk.js";
import { writeAudit } from "../../lib/audit.js";
import { sendSms } from "../../lib/sms/index.js";
import { consumeMerchantTokens } from "../../lib/merchantRateLimit.js";

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
      emailVerified: m.emailVerified ?? false,
      billing: billingView(m.subscription),
      // Surface only the in-app branding fields the dashboard layout needs.
      // The customer-facing tracking page reads its own `logoUrl` separately.
      branding: {
        logoDataUrl: m.branding?.logoDataUrl ?? null,
        primaryColor: m.branding?.primaryColor ?? null,
        displayName: m.branding?.displayName ?? null,
      },
    };
  }),

  /**
   * Logged-in password change. We require the current password to defend
   * against a hijacked session swapping the credential silently. Reuses the
   * same bcrypt(10) cost as signup for consistency.
   */
  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(8).max(200),
        newPassword: z.string().min(8).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const m = await Merchant.findById(ctx.user.id);
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      const ok = await bcrypt.compare(input.currentPassword, m.passwordHash);
      if (!ok) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "current password incorrect" });
      }
      if (input.currentPassword === input.newPassword) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "new password must be different",
        });
      }
      m.passwordHash = await bcrypt.hash(input.newPassword, 10);
      // Invalidate any in-flight reset link the moment the merchant changes
      // their password from inside an authenticated session.
      m.passwordReset = undefined;
      await m.save();

      void writeAudit({
        merchantId: m._id,
        actorId: m._id,
        actorType: "merchant",
        action: "auth.password_changed",
        subjectType: "merchant",
        subjectId: m._id,
        meta: {},
      });

      return { ok: true };
    }),

  /**
   * Update the in-app branding (sidebar logo, accent color, display name).
   * Drives the BrandingProvider that injects --brand CSS vars across the
   * dashboard. Logo is stored as an inline `data:image/...;base64,...` URL —
   * size capped at 200 KB raw to keep the merchant doc reasonable. Distinct
   * from the customer-tracking-page logo (`branding.logoUrl`) — a merchant
   * can run one for their internal admins and a different polished one for
   * the customer surface.
   *
   * Pass `null` to either field to clear that part of branding while keeping
   * the rest. Passing `undefined`/omitting leaves the field untouched.
   */
  updateBranding: protectedProcedure
    .input(
      z
        .object({
          logoDataUrl: z
            .string()
            .max(280_000, "Logo too large — keep it under 200 KB.")
            .regex(
              /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,/,
              "Logo must be an inline data:image/* base64 URL.",
            )
            .nullable()
            .optional(),
          primaryColor: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a 6-digit hex like #112233.")
            .nullable()
            .optional(),
          displayName: z
            .string()
            .trim()
            .max(80)
            .nullable()
            .optional(),
        })
        .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" }),
    )
    .mutation(async ({ ctx, input }) => {
      const m = await findMerchantOrThrow(ctx.user.id);
      const branding = m.branding ?? {};
      // Apply only the keys actually present in the input. `null` clears,
      // `undefined`/missing leaves untouched. We avoid `$set: input` because
      // that path would also unset omitted fields.
      const next: Record<string, unknown> = { ...branding };
      if (Object.prototype.hasOwnProperty.call(input, "logoDataUrl")) {
        if (input.logoDataUrl == null) delete next.logoDataUrl;
        else next.logoDataUrl = input.logoDataUrl;
      }
      if (Object.prototype.hasOwnProperty.call(input, "primaryColor")) {
        if (input.primaryColor == null) delete next.primaryColor;
        else next.primaryColor = input.primaryColor;
      }
      if (Object.prototype.hasOwnProperty.call(input, "displayName")) {
        if (input.displayName == null) delete next.displayName;
        else next.displayName = input.displayName;
      }
      m.branding = next as typeof m.branding;
      await m.save();

      void writeAudit({
        merchantId: m._id as Types.ObjectId,
        actorId: m._id as Types.ObjectId,
        actorType: "merchant",
        action: "merchant.branding_updated",
        subjectType: "merchant",
        subjectId: m._id as Types.ObjectId,
        meta: {
          hasLogo: !!next.logoDataUrl,
          primaryColor: next.primaryColor ?? null,
        },
      });

      return {
        logoDataUrl: (next.logoDataUrl as string | undefined) ?? null,
        primaryColor: (next.primaryColor as string | undefined) ?? null,
        displayName: (next.displayName as string | undefined) ?? null,
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

  /**
   * Sanity-check SMS sender used by Settings → "Send test SMS". Sends a
   * templated message to the merchant's stored phone via the same adapter
   * that powers OTP / order-confirmation traffic, so a successful delivery
   * proves the entire pipeline (provider creds → SSL Wireless → carrier).
   *
   * Rate-limited (5/hour) on top of the per-merchant token bucket so a
   * frustrated merchant clicking the button repeatedly doesn't burn their
   * SMS quota or trip the provider's anti-abuse heuristics.
   */
  sendTestSms: protectedProcedure.mutation(async ({ ctx }) => {
    const m = await findMerchantOrThrow(ctx.user.id);
    if (!m.phone) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Add a phone number to your profile before sending a test SMS.",
      });
    }
    const bucket = await consumeMerchantTokens(
      "sms-test",
      ctx.user.id,
      { capacity: 5, refillPerSecond: 5 / 3600 },
    );
    if (!bucket.allowed) {
      const minutes = Math.ceil(bucket.retryAfterMs / 60_000);
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Test SMS limit reached. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      });
    }
    const result = await sendSms(
      m.phone,
      `${m.businessName}: SMS pipeline working. If you didn't request this, ignore — it doesn't affect your account.`,
      { tag: "settings_test", csmsId: `test-${ctx.user.id}-${Date.now()}` },
    );
    void writeAudit({
      merchantId: m._id as Types.ObjectId,
      actorId: m._id as Types.ObjectId,
      actorType: "merchant",
      action: "merchant.test_sms_sent",
      subjectType: "merchant",
      subjectId: m._id as Types.ObjectId,
      meta: {
        ok: result.ok,
        providerStatus: result.providerStatus,
        // Mask the phone in the audit log — last 4 only.
        phoneSuffix: m.phone.slice(-4),
      },
    });
    if (!result.ok) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.error ?? "Failed to send test SMS.",
      });
    }
    return {
      ok: true,
      phoneSuffix: m.phone.slice(-4),
      providerStatus: result.providerStatus,
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

      const webhook = await registerCourierWebhook({
        courier: input.name,
        merchantId: ctx.user.id,
        apiSecret: input.apiSecret,
      });

      return {
        name: input.name,
        accountId: input.accountId,
        enabled: input.enabled ?? true,
        preferredDistricts: input.preferredDistricts,
        apiKeyMasked: maskSecretPayload(encryptedApiKey),
        updatedAt: now,
        webhook,
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
  /**
   * Per-merchant automation policy. Read by the order-create flow to
   * decide whether to auto-confirm and/or auto-book a fresh order.
   */
  getAutomationConfig: protectedProcedure.query(async ({ ctx }) => {
    const m = await Merchant.findById(ctx.user.id)
      .select("automationConfig couriers")
      .lean();
    if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
    const cfg = (m as { automationConfig?: Record<string, unknown> }).automationConfig ?? {};
    const couriers = ((m as { couriers?: Array<{ name: string; enabled?: boolean }> }).couriers ?? [])
      .filter((c) => c.enabled !== false)
      .map((c) => c.name);
    return {
      enabled: (cfg.enabled as boolean | undefined) ?? false,
      mode: (cfg.mode as "manual" | "semi_auto" | "full_auto" | undefined) ?? "manual",
      maxRiskForAutoConfirm: (cfg.maxRiskForAutoConfirm as number | undefined) ?? 39,
      autoBookEnabled: (cfg.autoBookEnabled as boolean | undefined) ?? false,
      autoBookCourier: (cfg.autoBookCourier as string | undefined) ?? null,
      enabledCouriers: couriers,
    };
  }),

  updateAutomationConfig: protectedProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        mode: z.enum(["manual", "semi_auto", "full_auto"]).optional(),
        maxRiskForAutoConfirm: z.number().int().min(0).max(100).optional(),
        autoBookEnabled: z.boolean().optional(),
        autoBookCourier: z.string().trim().max(60).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const set: Record<string, unknown> = {};
      if (input.enabled !== undefined) set["automationConfig.enabled"] = input.enabled;
      if (input.mode !== undefined) set["automationConfig.mode"] = input.mode;
      if (input.maxRiskForAutoConfirm !== undefined)
        set["automationConfig.maxRiskForAutoConfirm"] = input.maxRiskForAutoConfirm;
      if (input.autoBookEnabled !== undefined)
        set["automationConfig.autoBookEnabled"] = input.autoBookEnabled;

      // Validate autoBookCourier — must match an enabled courier on the
      // merchant. Without this, a merchant can pick "redx" while having no
      // redx credentials, and auto-book will silently skip every order.
      if (input.autoBookCourier !== undefined && input.autoBookCourier) {
        const merchant = await Merchant.findById(ctx.user.id)
          .select("couriers")
          .lean();
        const enabled = (
          (merchant as { couriers?: Array<{ name: string; enabled?: boolean }> } | null)?.couriers ?? []
        )
          .filter((c) => c.enabled !== false)
          .map((c) => c.name);
        if (!enabled.includes(input.autoBookCourier)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: enabled.length === 0
              ? "Add and enable a courier in Settings before picking one for auto-book."
              : `Courier "${input.autoBookCourier}" is not enabled. Enabled: ${enabled.join(", ")}.`,
          });
        }
        set["automationConfig.autoBookCourier"] = input.autoBookCourier;
      } else if (input.autoBookCourier !== undefined) {
        // Explicit clear (null or empty string) — allowed.
        set["automationConfig.autoBookCourier"] = "";
      }

      // If the merchant is enabling auto-book without picking a courier (or
      // with a courier that no longer exists), refuse — we won't ship orders
      // that would silently skip auto-booking.
      if (input.autoBookEnabled === true) {
        const merchant = await Merchant.findById(ctx.user.id)
          .select("automationConfig couriers")
          .lean();
        const enabled = (
          (merchant as { couriers?: Array<{ name: string; enabled?: boolean }> } | null)?.couriers ?? []
        )
          .filter((c) => c.enabled !== false)
          .map((c) => c.name);
        const desired = (input.autoBookCourier
          ?? (merchant as { automationConfig?: { autoBookCourier?: string } } | null)?.automationConfig?.autoBookCourier
          ?? "").trim();
        if (!desired || !enabled.includes(desired)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: enabled.length === 0
              ? "Connect a courier first — auto-book has nothing to book through."
              : `Pick an auto-book courier from your enabled couriers: ${enabled.join(", ")}.`,
          });
        }
      }

      const res = await Merchant.updateOne({ _id: ctx.user.id }, { $set: set });
      if (res.matchedCount === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      }
      void writeAudit({
        merchantId: new Types.ObjectId(ctx.user.id),
        actorId: new Types.ObjectId(ctx.user.id),
        actorType: "merchant",
        action: "automation.config_updated",
        subjectType: "merchant",
        subjectId: new Types.ObjectId(ctx.user.id),
        meta: input as Record<string, unknown>,
      });
      return { ok: true };
    }),

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
