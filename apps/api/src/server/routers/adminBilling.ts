import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { Merchant, Notification, Payment } from "@ecom/db";
import {
  invalidateSubscriptionCache,
  router,
  scopedAdminProcedure,
} from "../trpc.js";
import { writeAdminAudit, writeAudit } from "../../lib/audit.js";
import { getPlan, PLAN_TIERS, type PlanTier } from "../../lib/plans.js";
import { enforceIntegrationCapacity } from "../../lib/entitlements.js";
import {
  buildPaymentApprovedEmail,
  sendEmail,
  webUrl,
} from "../../lib/email.js";
import { consumeStepupToken } from "../../lib/admin-stepup.js";

const DEFAULT_PERIOD_DAYS = 30;

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Snapshot the fields that matter for audit before/after diffs. Kept small
 * and stable so the audit pane can render it as a key/value list.
 */
function paymentSnapshot(p: {
  status?: string;
  reviewerId?: Types.ObjectId | null;
  markedReviewedBy?: Types.ObjectId | null;
  firstApprovalBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  reviewerNote?: string | null;
}) {
  return {
    status: p.status ?? null,
    reviewerId: p.reviewerId ? String(p.reviewerId) : null,
    markedReviewedBy: p.markedReviewedBy ? String(p.markedReviewedBy) : null,
    firstApprovalBy: p.firstApprovalBy ? String(p.firstApprovalBy) : null,
    reviewedAt: p.reviewedAt ?? null,
    reviewerNote: p.reviewerNote ?? null,
  };
}

function subscriptionSnapshot(sub: Record<string, unknown> | undefined) {
  if (!sub) return null;
  return {
    tier: sub.tier ?? null,
    status: sub.status ?? null,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
    activatedBy: sub.activatedBy ?? null,
  };
}

export const adminBillingRouter = router({
  /**
   * Pending payments queue — finance admins triage here. Surfaces risk
   * score + reasons + dual-approval flag so the queue sorts dangerous
   * submissions to the top.
   */
  listPendingPayments: scopedAdminProcedure("payment.review")
    .input(
      z
        .object({
          status: z
            .enum(["pending", "reviewed", "approved", "rejected"])
            .default("pending"),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ status: "pending", limit: 50 }),
    )
    .query(async ({ input }) => {
      const docs = await Payment.find({ status: input.status })
        .sort({ riskScore: -1, createdAt: -1 })
        .limit(input.limit)
        .select("-proofFile.data")
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
          provider: (p.provider as "manual" | "stripe" | undefined) ?? "manual",
          txnId: p.txnId ?? null,
          senderPhone: p.senderPhone ?? null,
          proofUrl: p.proofUrl ?? null,
          hasProofFile: !!p.proofFile,
          proofFile: p.proofFile
            ? {
                contentType: p.proofFile.contentType,
                sizeBytes: p.proofFile.sizeBytes,
                filename: p.proofFile.filename ?? null,
              }
            : null,
          notes: p.notes ?? null,
          status: p.status,
          riskScore: p.riskScore ?? 0,
          riskReasons: p.riskReasons ?? [],
          requiresDualApproval: p.requiresDualApproval ?? false,
          markedReviewedBy: p.markedReviewedBy
            ? String(p.markedReviewedBy)
            : null,
          markedReviewedAt: p.markedReviewedAt ?? null,
          firstApprovalBy: p.firstApprovalBy ? String(p.firstApprovalBy) : null,
          firstApprovalAt: p.firstApprovalAt ?? null,
          createdAt: p.createdAt,
        };
      });
    }),

  /**
   * Stage 1 of the approval workflow. Admin opened the payment, eyeballed
   * the proof + signals, and is asserting "I have reviewed this and it
   * looks legit". Required before approval; cannot be skipped.
   */
  markReviewed: scopedAdminProcedure("payment.review")
    .input(
      z.object({
        paymentId: z.string().min(1),
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
      const prev = paymentSnapshot(payment);
      payment.status = "reviewed";
      (payment as unknown as { markedReviewedBy?: Types.ObjectId }).markedReviewedBy =
        new Types.ObjectId(ctx.user.id);
      (payment as unknown as { markedReviewedAt?: Date }).markedReviewedAt =
        new Date();
      if (input.note) payment.reviewerNote = input.note;
      await payment.save();
      void writeAdminAudit({
        merchantId: payment.merchantId,
        actorId: new Types.ObjectId(ctx.user.id),
        actorEmail: ctx.user.email,
        actorScope: ctx.adminScope,
        action: "payment.reviewed",
        subjectType: "payment",
        subjectId: payment._id,
        prevState: prev,
        nextState: paymentSnapshot(payment),
        meta: { note: input.note ?? null },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });
      return { id: String(payment._id), status: "reviewed" as const };
    }),

  /**
   * Stage 2 — approve. For low-risk payments this is the single approval
   * and flips the subscription to active. For high-risk (riskScore >= 60)
   * the FIRST approval just stamps `firstApprovalBy`; the SECOND approval
   * (from a DIFFERENT admin) flips status to approved. This is the
   * "four-eyes" rule: one admin can never single-handedly green-light a
   * suspicious payment.
   *
   * Always requires:
   *  - finance_admin scope (or super_admin)
   *  - a fresh step-up confirmation token bound to "payment.approve"
   *  - the payment is in "reviewed" state
   */
  approvePayment: scopedAdminProcedure("payment.approve")
    .input(
      z.object({
        paymentId: z.string().min(1),
        periodDays: z.number().int().min(1).max(365).default(DEFAULT_PERIOD_DAYS),
        note: z.string().trim().max(1000).optional(),
        confirmationToken: z.string().min(8).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.paymentId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid payment id" });
      }
      const okStepup = await consumeStepupToken(
        ctx.user.id,
        "payment.approve",
        input.confirmationToken,
      );
      if (!okStepup) {
        void writeAdminAudit({
          actorId: new Types.ObjectId(ctx.user.id),
          actorEmail: ctx.user.email,
          actorScope: ctx.adminScope,
          action: "admin.stepup_failed",
          subjectType: "payment",
          subjectId: new Types.ObjectId(input.paymentId),
          meta: { permission: "payment.approve" },
          ip: ctx.request.ip,
          userAgent: ctx.request.userAgent,
        });
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "step-up confirmation required — please re-enter your password",
        });
      }
      const payment = await Payment.findById(input.paymentId);
      if (!payment) throw new TRPCError({ code: "NOT_FOUND", message: "payment not found" });
      if (payment.status !== "reviewed") {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            payment.status === "pending"
              ? "mark this payment as reviewed before approving"
              : `payment is already ${payment.status}`,
        });
      }

      const adminId = new Types.ObjectId(ctx.user.id);
      const requiresDual = !!(payment as unknown as { requiresDualApproval?: boolean })
        .requiresDualApproval;

      // Dual-approval handshake. Same admin cannot supply both halves.
      if (requiresDual) {
        const firstApprovalBy = (payment as unknown as {
          firstApprovalBy?: Types.ObjectId;
        }).firstApprovalBy;
        if (!firstApprovalBy) {
          // First approval — stamp it and stop short of activation.
          const prev = paymentSnapshot(payment);
          (payment as unknown as { firstApprovalBy?: Types.ObjectId }).firstApprovalBy = adminId;
          (payment as unknown as { firstApprovalAt?: Date }).firstApprovalAt = new Date();
          (payment as unknown as { firstApprovalNote?: string }).firstApprovalNote =
            input.note ?? undefined;
          await payment.save();
          void writeAdminAudit({
            merchantId: payment.merchantId,
            actorId: adminId,
            actorEmail: ctx.user.email,
            actorScope: ctx.adminScope,
            action: "payment.first_approval",
            subjectType: "payment",
            subjectId: payment._id,
            prevState: prev,
            nextState: paymentSnapshot(payment),
            meta: { note: input.note ?? null, riskScore: payment.riskScore ?? 0 },
            ip: ctx.request.ip,
            userAgent: ctx.request.userAgent,
          });
          return {
            id: String(payment._id),
            merchantId: String(payment.merchantId),
            status: "reviewed" as const,
            stage: "first_approval" as const,
            requiresSecondApproval: true,
          };
        }
        if (String(firstApprovalBy) === String(adminId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "this payment requires dual approval — a second admin must sign off",
          });
        }
      }

      // Final approval path — flip subscription + payment row.
      const merchant = await Merchant.findById(payment.merchantId).select(
        "subscription email businessName",
      );
      if (!merchant) {
        throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      }
      const plan = getPlan(payment.plan);
      const now = new Date();
      const periodStart = now;
      const periodEnd = addDays(now, input.periodDays);

      const prevPayment = paymentSnapshot(payment);
      const prevSub = subscriptionSnapshot(
        merchant.subscription as Record<string, unknown> | undefined,
      );

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
      payment.reviewerId = adminId;
      payment.reviewerNote = input.note;
      payment.reviewedAt = now;
      payment.periodStart = periodStart;
      payment.periodEnd = periodEnd;
      await payment.save();

      void writeAdminAudit({
        merchantId: merchant._id,
        actorId: adminId,
        actorEmail: ctx.user.email,
        actorScope: ctx.adminScope,
        action: "payment.approved",
        subjectType: "payment",
        subjectId: payment._id,
        prevState: prevPayment,
        nextState: paymentSnapshot(payment),
        meta: {
          plan: plan.tier,
          amount: payment.amount,
          periodEnd,
          note: input.note ?? null,
          riskScore: payment.riskScore ?? 0,
          dualApproval: requiresDual,
        },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });
      void writeAdminAudit({
        merchantId: merchant._id,
        actorId: adminId,
        actorEmail: ctx.user.email,
        actorScope: ctx.adminScope,
        action: "subscription.activated",
        subjectType: "merchant",
        subjectId: merchant._id,
        prevState: prevSub,
        nextState: subscriptionSnapshot(
          merchant.subscription as Record<string, unknown>,
        ),
        meta: { tier: plan.tier, periodEnd },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });

      const tpl = buildPaymentApprovedEmail({
        businessName: merchant.businessName,
        planName: plan.name,
        amount: payment.amount,
        currency: payment.currency,
        periodEnd,
        dashboardUrl: webUrl("/dashboard"),
      });
      void sendEmail({
        to: merchant.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        tag: "payment_approved",
      }).catch((err) =>
        console.error("[adminBilling] payment email send failed", (err as Error).message),
      );

      return {
        id: String(payment._id),
        merchantId: String(merchant._id),
        plan: plan.tier,
        status: "approved" as const,
        stage: "final" as const,
        requiresSecondApproval: false,
        periodEnd,
      };
    }),

  rejectPayment: scopedAdminProcedure("payment.reject")
    .input(
      z.object({
        paymentId: z.string().min(1),
        reason: z.string().trim().min(1).max(1000),
        confirmationToken: z.string().min(8).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.paymentId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid payment id" });
      }
      const okStepup = await consumeStepupToken(
        ctx.user.id,
        "payment.reject",
        input.confirmationToken,
      );
      if (!okStepup) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "step-up confirmation required",
        });
      }
      const payment = await Payment.findById(input.paymentId);
      if (!payment) throw new TRPCError({ code: "NOT_FOUND", message: "payment not found" });
      if (payment.status !== "pending" && payment.status !== "reviewed") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `payment is already ${payment.status}`,
        });
      }

      const prev = paymentSnapshot(payment);
      const now = new Date();
      payment.status = "rejected";
      payment.reviewerId = new Types.ObjectId(ctx.user.id);
      payment.reviewerNote = input.reason;
      payment.reviewedAt = now;
      // Clear any first-approval if a high-risk payment is being rejected.
      (payment as unknown as { firstApprovalBy?: Types.ObjectId | null }).firstApprovalBy =
        null;
      (payment as unknown as { firstApprovalAt?: Date | null }).firstApprovalAt = null;
      await payment.save();

      await Merchant.updateOne(
        { _id: payment.merchantId, "subscription.pendingPaymentId": payment._id },
        { $set: { "subscription.pendingPaymentId": null } },
      );

      void writeAdminAudit({
        merchantId: payment.merchantId,
        actorId: new Types.ObjectId(ctx.user.id),
        actorEmail: ctx.user.email,
        actorScope: ctx.adminScope,
        action: "payment.rejected",
        subjectType: "payment",
        subjectId: payment._id,
        prevState: prev,
        nextState: paymentSnapshot(payment),
        meta: { reason: input.reason },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });

      return { id: String(payment._id), status: "rejected" as const };
    }),

  /** Extend a merchant's currentPeriodEnd without a payment record. */
  extendSubscription: scopedAdminProcedure("subscription.extend")
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
      const prev = subscriptionSnapshot(
        merchant.subscription as Record<string, unknown> | undefined,
      );
      merchant.subscription = merchant.subscription ?? {};
      const sub = merchant.subscription as Record<string, unknown>;
      const base = (sub.currentPeriodEnd as Date | undefined) ?? new Date();
      const next = addDays(base, input.days);
      sub.currentPeriodEnd = next;
      if (sub.status !== "active") sub.status = "active";
      await merchant.save();
      invalidateSubscriptionCache(String(merchant._id));

      void writeAdminAudit({
        merchantId: merchant._id,
        actorId: new Types.ObjectId(ctx.user.id),
        actorEmail: ctx.user.email,
        actorScope: ctx.adminScope,
        action: "subscription.extended",
        subjectType: "merchant",
        subjectId: merchant._id,
        prevState: prev,
        nextState: subscriptionSnapshot(sub),
        meta: { days: input.days, newPeriodEnd: next, note: input.note ?? null },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });

      return { merchantId: String(merchant._id), currentPeriodEnd: next };
    }),

  /** Force plan change without a payment (comped upgrade, downgrade after refund). */
  changePlan: scopedAdminProcedure("subscription.change_plan")
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
      const prev = subscriptionSnapshot(
        merchant.subscription as Record<string, unknown> | undefined,
      );
      merchant.subscription = merchant.subscription ?? {};
      const sub = merchant.subscription as Record<string, unknown>;
      const prevTier = sub.tier;
      sub.tier = plan.tier;
      sub.rate = plan.priceBDT;
      await merchant.save();
      invalidateSubscriptionCache(String(merchant._id));

      // FIX: previously, the plan was written without checking whether
      // the merchant's current footprint (integration count, provider
      // mix) fit under the new tier's caps. A merchant on Scale (5
      // integrations) downgraded to Starter (1) would silently retain
      // all 5 connectors — the cap was only enforced on the next
      // `connect` call. Now we run `enforceIntegrationCapacity`
      // synchronously so the merchant sees a consistent state
      // immediately. Idempotent — re-running with the same target tier
      // is a no-op once enforcement has settled.
      const downgradeFrom = (prevTier as PlanTier | undefined) ?? null;
      const isDowngrade =
        downgradeFrom !== null &&
        PLAN_TIERS.indexOf(plan.tier) < PLAN_TIERS.indexOf(downgradeFrom);
      let enforcement: Awaited<
        ReturnType<typeof enforceIntegrationCapacity>
      > | null = null;
      try {
        enforcement = await enforceIntegrationCapacity(
          merchant._id as Types.ObjectId,
          plan.tier,
        );
      } catch (err) {
        // Don't fail the plan change on a capacity-enforcement glitch —
        // log it loudly so ops can manually reconcile, and persist a
        // sentinel so we know the row needs follow-up. The plan write
        // already succeeded; the merchant's billing state is correct
        // even if a couple of orphaned connectors linger.
        console.error(
          "[adminBilling.changePlan] enforceIntegrationCapacity failed",
          {
            merchantId: String(merchant._id),
            targetTier: plan.tier,
            error: (err as Error).message,
          },
        );
      }

      // Notify the merchant when an enforcement actually disabled
      // something. Two distinct buckets (provider-locked vs over-cap)
      // because the remediation differs: provider-locked needs an
      // upgrade to a tier that allows the provider; over-cap can be
      // resolved by reconnecting after upgrading OR by accepting the
      // disabled connectors as-is.
      const totalDisabled =
        (enforcement?.disabled.length ?? 0) +
        (enforcement?.providerLocked.length ?? 0);
      if (totalDisabled > 0 && enforcement) {
        const merchantOid = merchant._id as Types.ObjectId;
        const lines: string[] = [];
        if (enforcement.providerLocked.length > 0) {
          const providers = Array.from(
            new Set(enforcement.providerLocked.map((r) => r.provider)),
          ).join(", ");
          lines.push(
            `${enforcement.providerLocked.length} ${providers} connector${enforcement.providerLocked.length === 1 ? "" : "s"} disabled — your new plan doesn't include ${providers}.`,
          );
        }
        if (enforcement.disabled.length > 0) {
          lines.push(
            `${enforcement.disabled.length} integration${enforcement.disabled.length === 1 ? "" : "s"} disabled — your new plan caps integrations at ${enforcement.cap}.`,
          );
        }
        try {
          await Notification.updateOne(
            {
              merchantId: merchantOid,
              dedupeKey: `plan-downgrade-enforcement:${String(merchant._id)}:${plan.tier}`,
            },
            {
              $setOnInsert: {
                merchantId: merchantOid,
                kind: "subscription.plan_downgrade_enforced",
                severity: "warning",
                title: `Plan changed to ${plan.name} — some integrations were disabled`,
                body: lines.join(" "),
                link: "/dashboard/integrations",
                subjectType: "merchant" as const,
                subjectId: merchantOid,
                meta: {
                  from: downgradeFrom,
                  to: plan.tier,
                  cap: enforcement.cap,
                  disabled: enforcement.disabled,
                  providerLocked: enforcement.providerLocked,
                },
                dedupeKey: `plan-downgrade-enforcement:${String(merchant._id)}:${plan.tier}`,
              },
            },
            { upsert: true },
          );
        } catch (notifyErr) {
          console.error(
            "[adminBilling.changePlan] downgrade notification failed",
            (notifyErr as Error).message,
          );
        }
      }

      void writeAdminAudit({
        merchantId: merchant._id,
        actorId: new Types.ObjectId(ctx.user.id),
        actorEmail: ctx.user.email,
        actorScope: ctx.adminScope,
        action: "subscription.plan_changed",
        subjectType: "merchant",
        subjectId: merchant._id,
        prevState: prev,
        nextState: subscriptionSnapshot(sub),
        meta: {
          from: prevTier ?? null,
          to: plan.tier,
          note: input.note ?? null,
          isDowngrade,
          enforcement: enforcement
            ? {
                activeBefore: enforcement.activeBefore,
                cap: enforcement.cap,
                disabledCount: enforcement.disabled.length,
                providerLockedCount: enforcement.providerLocked.length,
              }
            : null,
        },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });
      // Legacy writeAudit call for any consumers still listening on the
      // old action name without admin metadata.
      void writeAudit({
        merchantId: merchant._id,
        actorId: new Types.ObjectId(ctx.user.id),
        actorType: "admin",
        action: "subscription.plan_changed",
        subjectType: "merchant",
        subjectId: merchant._id,
        meta: { from: prevTier ?? null, to: plan.tier, note: input.note ?? null },
      });

      return {
        merchantId: String(merchant._id),
        tier: plan.tier,
        enforcement: enforcement
          ? {
              activeBefore: enforcement.activeBefore,
              cap: enforcement.cap,
              disabled: enforcement.disabled,
              providerLocked: enforcement.providerLocked,
            }
          : null,
      };
    }),
});
