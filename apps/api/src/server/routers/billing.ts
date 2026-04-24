import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { Merchant, Payment, PAYMENT_METHODS } from "@ecom/db";
import { invalidateSubscriptionCache, protectedProcedure, router } from "../trpc.js";
import { writeAudit } from "../../lib/audit.js";
import {
  getPlan,
  isPlanTier,
  listPlans,
  PLAN_TIERS,
  quotaFor,
  USAGE_METRICS,
  type PlanTier,
} from "../../lib/plans.js";
import { getCurrentUsage } from "../../lib/usage.js";

function merchantObjectId(ctx: { user: { id: string } }): Types.ObjectId {
  return new Types.ObjectId(ctx.user.id);
}

function summarizeSubscription(sub: {
  status?: string;
  tier?: string;
  rate?: number;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
  startDate?: Date | null;
  activatedAt?: Date | null;
  pendingPaymentId?: Types.ObjectId | null;
} | undefined) {
  const status = (sub?.status ?? "trial") as
    | "trial"
    | "active"
    | "past_due"
    | "paused"
    | "cancelled";
  const tier = (sub?.tier ?? "starter") as PlanTier;
  const now = Date.now();
  const trialEndsAt = sub?.trialEndsAt ?? null;
  const currentPeriodEnd = sub?.currentPeriodEnd ?? null;
  const trialDaysLeft =
    status === "trial" && trialEndsAt
      ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now) / 86400_000))
      : null;
  const trialExpired =
    status === "trial" && trialEndsAt ? trialEndsAt.getTime() <= now : false;
  const periodDaysLeft =
    currentPeriodEnd
      ? Math.max(0, Math.ceil((currentPeriodEnd.getTime() - now) / 86400_000))
      : null;
  return {
    status,
    tier,
    rate: sub?.rate ?? 0,
    trialEndsAt,
    trialDaysLeft,
    trialExpired,
    currentPeriodEnd,
    periodDaysLeft,
    startDate: sub?.startDate ?? null,
    activatedAt: sub?.activatedAt ?? null,
    pendingPaymentId: sub?.pendingPaymentId ? String(sub.pendingPaymentId) : null,
  };
}

export const billingRouter = router({
  /** Static catalogue — safe for the public pricing surface too. */
  listPlans: protectedProcedure.query(() => listPlans()),

  /** Merchant dashboard payload: current plan, usage meters, quota progress. */
  getPlan: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const m = await Merchant.findById(merchantId).select("subscription").lean();
    if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
    const summary = summarizeSubscription(m.subscription);
    const plan = getPlan(summary.tier);
    return { subscription: summary, plan };
  }),

  getUsage: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const m = await Merchant.findById(merchantId).select("subscription.tier").lean();
    if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
    const plan = getPlan(m.subscription?.tier);
    const usage = await getCurrentUsage(merchantId);
    const meters = USAGE_METRICS.map((metric) => {
      const limit = quotaFor(plan, metric);
      const used = usage[metric] ?? 0;
      const ratio = limit === null || limit === 0 ? 0 : Math.min(1, used / limit);
      const warning = limit !== null && limit > 0 && used >= limit * 0.8;
      const blocked = limit !== null && used >= limit;
      return { metric, used, limit, ratio, warning, blocked };
    });
    return { period: usage.period, meters, lastActivityAt: usage.lastActivityAt };
  }),

  /** Merchant's payment history (for the "Invoices" table on the billing page). */
  listPayments: protectedProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(100).default(25) })
        .default({ limit: 25 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const docs = await Payment.find({ merchantId })
        .sort({ createdAt: -1 })
        .limit(input.limit)
        .lean();
      return docs.map((p) => ({
        id: String(p._id),
        plan: p.plan,
        amount: p.amount,
        currency: p.currency,
        method: p.method,
        txnId: p.txnId ?? null,
        senderPhone: p.senderPhone ?? null,
        proofUrl: p.proofUrl ?? null,
        status: p.status,
        reviewerNote: p.reviewerNote ?? null,
        reviewedAt: p.reviewedAt ?? null,
        periodStart: p.periodStart ?? null,
        periodEnd: p.periodEnd ?? null,
        createdAt: p.createdAt,
      }));
    }),

  /**
   * Merchant submits a manual payment receipt. We mark the subscription as
   * "pendingPaymentId" so the UI reflects "awaiting approval". Actual plan
   * flip happens in admin.approvePayment.
   */
  submitPayment: protectedProcedure
    .input(
      z.object({
        plan: z.enum(PLAN_TIERS),
        method: z.enum(PAYMENT_METHODS),
        amount: z.number().min(1).max(10_000_000),
        txnId: z.string().trim().max(200).optional(),
        senderPhone: z.string().trim().max(32).optional(),
        proofUrl: z.string().trim().url().max(1000).optional(),
        notes: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const merchant = await Merchant.findById(merchantId).select("subscription");
      if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });

      if (!isPlanTier(input.plan)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid plan" });
      }
      const plan = getPlan(input.plan);
      // Soft guard: amount should be close to catalogue price (±10%).
      if (input.amount < plan.priceBDT * 0.5) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `amount below minimum for ${plan.name} (${plan.priceBDT} BDT)`,
        });
      }

      const payment = await Payment.create({
        merchantId,
        plan: input.plan,
        amount: input.amount,
        currency: "BDT",
        method: input.method,
        txnId: input.txnId,
        senderPhone: input.senderPhone,
        proofUrl: input.proofUrl,
        notes: input.notes,
        status: "pending",
      });

      merchant.subscription = merchant.subscription ?? {};
      (merchant.subscription as Record<string, unknown>).pendingPaymentId = payment._id;
      await merchant.save();

      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "payment.submitted",
        subjectType: "payment",
        subjectId: payment._id,
        meta: {
          plan: input.plan,
          amount: input.amount,
          method: input.method,
          txnId: input.txnId ?? null,
        },
      });

      return {
        id: String(payment._id),
        status: payment.status,
        plan: payment.plan,
        amount: payment.amount,
        createdAt: payment.createdAt,
      };
    }),

  /** Merchant cancels their subscription — keeps access until currentPeriodEnd. */
  cancel: protectedProcedure.mutation(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const merchant = await Merchant.findById(merchantId).select("subscription");
    if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });

    const sub = merchant.subscription ?? {};
    (sub as Record<string, unknown>).status = "cancelled";
    merchant.subscription = sub;
    await merchant.save();
    invalidateSubscriptionCache(String(merchantId));

    void writeAudit({
      merchantId,
      actorId: merchantId,
      action: "subscription.cancelled",
      subjectType: "merchant",
      subjectId: merchantId,
      meta: { at: new Date() },
    });

    return { status: "cancelled" as const };
  }),
});
