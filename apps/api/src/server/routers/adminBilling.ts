import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { Merchant, Payment } from "@ecom/db";
import {
  adminProcedure,
  invalidateSubscriptionCache,
  router,
} from "../trpc.js";
import { writeAudit } from "../../lib/audit.js";
import { getPlan, PLAN_TIERS } from "../../lib/plans.js";

const DEFAULT_PERIOD_DAYS = 30;

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export const adminBillingRouter = router({
  /** Pending payments queue — the central admin billing workstation. */
  listPendingPayments: adminProcedure
    .input(
      z
        .object({
          status: z.enum(["pending", "approved", "rejected"]).default("pending"),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ status: "pending", limit: 50 }),
    )
    .query(async ({ input }) => {
      const docs = await Payment.find({ status: input.status })
        .sort({ createdAt: -1 })
        .limit(input.limit)
        .lean();
      const merchantIds = [...new Set(docs.map((d) => String(d.merchantId)))];
      const merchants = await Merchant.find({
        _id: { $in: merchantIds.map((id) => new Types.ObjectId(id)) },
      })
        .select("businessName email subscription.tier subscription.status")
        .lean();
      const byId = new Map(merchants.map((m) => [String(m._id), m]));
      return docs.map((p) => {
        const m = byId.get(String(p.merchantId));
        return {
          id: String(p._id),
          merchantId: String(p.merchantId),
          merchantName: m?.businessName ?? "(unknown)",
          merchantEmail: m?.email ?? "",
          currentTier: m?.subscription?.tier ?? "starter",
          currentStatus: m?.subscription?.status ?? "trial",
          plan: p.plan,
          amount: p.amount,
          currency: p.currency,
          method: p.method,
          txnId: p.txnId ?? null,
          senderPhone: p.senderPhone ?? null,
          proofUrl: p.proofUrl ?? null,
          notes: p.notes ?? null,
          status: p.status,
          createdAt: p.createdAt,
        };
      });
    }),

  /**
   * Approve → flip merchant to `active` on the requested plan, set
   * currentPeriodEnd = approvedAt + 30d (or admin override), mark payment
   * approved with reviewer/note audit trail.
   */
  approvePayment: adminProcedure
    .input(
      z.object({
        paymentId: z.string().min(1),
        periodDays: z.number().int().min(1).max(365).default(DEFAULT_PERIOD_DAYS),
        note: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.paymentId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid payment id" });
      }
      const payment = await Payment.findById(input.paymentId);
      if (!payment) throw new TRPCError({ code: "NOT_FOUND", message: "payment not found" });
      if (payment.status !== "pending") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `payment is already ${payment.status}`,
        });
      }

      const merchant = await Merchant.findById(payment.merchantId).select("subscription");
      if (!merchant) {
        throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      }
      const plan = getPlan(payment.plan);

      const now = new Date();
      const periodStart = now;
      const periodEnd = addDays(now, input.periodDays);

      // Flip subscription to active on the requested plan.
      merchant.subscription = merchant.subscription ?? {};
      const sub = merchant.subscription as Record<string, unknown>;
      sub.tier = plan.tier;
      sub.rate = plan.priceBDT;
      sub.status = "active";
      sub.activatedAt = now;
      sub.activatedBy = ctx.user.email;
      sub.currentPeriodEnd = periodEnd;
      sub.trialEndsAt = null;
      sub.pendingPaymentId = null;
      await merchant.save();
      invalidateSubscriptionCache(String(merchant._id));

      payment.status = "approved";
      payment.reviewerId = new Types.ObjectId(ctx.user.id);
      payment.reviewerNote = input.note;
      payment.reviewedAt = now;
      payment.periodStart = periodStart;
      payment.periodEnd = periodEnd;
      await payment.save();

      void writeAudit({
        merchantId: merchant._id,
        actorId: new Types.ObjectId(ctx.user.id),
        actorType: "admin",
        action: "payment.approved",
        subjectType: "payment",
        subjectId: payment._id,
        meta: {
          plan: plan.tier,
          amount: payment.amount,
          periodEnd,
          note: input.note ?? null,
        },
      });
      void writeAudit({
        merchantId: merchant._id,
        actorId: new Types.ObjectId(ctx.user.id),
        actorType: "admin",
        action: "subscription.activated",
        subjectType: "merchant",
        subjectId: merchant._id,
        meta: { tier: plan.tier, periodEnd },
      });

      return {
        id: String(payment._id),
        merchantId: String(merchant._id),
        plan: plan.tier,
        status: "approved" as const,
        periodEnd,
      };
    }),

  rejectPayment: adminProcedure
    .input(
      z.object({
        paymentId: z.string().min(1),
        reason: z.string().trim().min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.paymentId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid payment id" });
      }
      const payment = await Payment.findById(input.paymentId);
      if (!payment) throw new TRPCError({ code: "NOT_FOUND", message: "payment not found" });
      if (payment.status !== "pending") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `payment is already ${payment.status}`,
        });
      }

      const now = new Date();
      payment.status = "rejected";
      payment.reviewerId = new Types.ObjectId(ctx.user.id);
      payment.reviewerNote = input.reason;
      payment.reviewedAt = now;
      await payment.save();

      // Clear the pendingPaymentId if it still points at this payment.
      await Merchant.updateOne(
        { _id: payment.merchantId, "subscription.pendingPaymentId": payment._id },
        { $set: { "subscription.pendingPaymentId": null } },
      );

      void writeAudit({
        merchantId: payment.merchantId,
        actorId: new Types.ObjectId(ctx.user.id),
        actorType: "admin",
        action: "payment.rejected",
        subjectType: "payment",
        subjectId: payment._id,
        meta: { reason: input.reason },
      });

      return { id: String(payment._id), status: "rejected" as const };
    }),

  /** Extend a merchant's currentPeriodEnd without a payment record. */
  extendSubscription: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        days: z.number().int().min(1).max(365),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid merchant id" });
      }
      const merchant = await Merchant.findById(input.merchantId).select("subscription");
      if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      merchant.subscription = merchant.subscription ?? {};
      const sub = merchant.subscription as Record<string, unknown>;
      const base = (sub.currentPeriodEnd as Date | undefined) ?? new Date();
      const next = addDays(base, input.days);
      sub.currentPeriodEnd = next;
      if (sub.status !== "active") sub.status = "active";
      await merchant.save();
      invalidateSubscriptionCache(String(merchant._id));

      void writeAudit({
        merchantId: merchant._id,
        actorId: new Types.ObjectId(ctx.user.id),
        actorType: "admin",
        action: "subscription.extended",
        subjectType: "merchant",
        subjectId: merchant._id,
        meta: { days: input.days, newPeriodEnd: next, note: input.note ?? null },
      });

      return { merchantId: String(merchant._id), currentPeriodEnd: next };
    }),

  /** Force plan change without a payment (comped upgrade, downgrade after refund). */
  changePlan: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        tier: z.enum(PLAN_TIERS),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid merchant id" });
      }
      const merchant = await Merchant.findById(input.merchantId).select("subscription");
      if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      const plan = getPlan(input.tier);
      merchant.subscription = merchant.subscription ?? {};
      const sub = merchant.subscription as Record<string, unknown>;
      const prevTier = sub.tier;
      sub.tier = plan.tier;
      sub.rate = plan.priceBDT;
      await merchant.save();
      invalidateSubscriptionCache(String(merchant._id));

      void writeAudit({
        merchantId: merchant._id,
        actorId: new Types.ObjectId(ctx.user.id),
        actorType: "admin",
        action: "subscription.plan_changed",
        subjectType: "merchant",
        subjectId: merchant._id,
        meta: { from: prevTier ?? null, to: plan.tier, note: input.note ?? null },
      });

      return { merchantId: String(merchant._id), tier: plan.tier };
    }),
});
