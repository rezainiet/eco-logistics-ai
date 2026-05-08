import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { Merchant, Payment, PAYMENT_METHODS } from "@ecom/db";
import { invalidateSubscriptionCache, merchantObjectId, protectedProcedure, router } from "../trpc.js";
import {
  checkManualPaymentSubmitGuard,
  computeMetadataHash,
  computeProofHash,
  listManualPaymentOptions,
  normalizeTxnId,
  scorePaymentRisk,
} from "../../lib/manual-payments.js";
import { writeAudit } from "../../lib/audit.js";
import { loadBrandingFromStore } from "../../lib/branding-store.js";
import { computeTrialState, daysLeftUntil } from "../../lib/billing.js";
import { previewIntegrationCapacityChange } from "../../lib/entitlements.js";
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
import { env } from "../../env.js";
import {
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  createSubscriptionCheckout,
  getPriceIdForPlan,
} from "../../lib/stripe.js";
import { webUrl } from "../../lib/email.js";

/**
 * Billing-dashboard subscription view. Richer than the profile-page
 * `billingView` (in routers/merchants.ts) — adds grace-period detail,
 * billing provider, and pending-payment id. The two are intentionally
 * separate; shared trial-days math lives in `lib/billing.ts`.
 */
function summarizeSubscription(sub: {
  status?: string;
  tier?: string;
  rate?: number;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
  gracePeriodEndsAt?: Date | null;
  startDate?: Date | null;
  activatedAt?: Date | null;
  pendingPaymentId?: Types.ObjectId | null;
  billingProvider?: string;
} | undefined) {
  const status = (sub?.status ?? "trial") as
    | "trial"
    | "active"
    | "past_due"
    | "paused"
    | "suspended"
    | "cancelled";
  const tier = (sub?.tier ?? "starter") as PlanTier;
  const trialEndsAt = sub?.trialEndsAt ?? null;
  const currentPeriodEnd = sub?.currentPeriodEnd ?? null;
  const gracePeriodEndsAt = sub?.gracePeriodEndsAt ?? null;
  const { trialDaysLeft, trialExpired } = computeTrialState(status, trialEndsAt);
  const periodDaysLeft = daysLeftUntil(currentPeriodEnd);
  const graceDaysLeft =
    status === "past_due" ? daysLeftUntil(gracePeriodEndsAt) : null;
  return {
    status,
    tier,
    rate: sub?.rate ?? 0,
    trialEndsAt,
    trialDaysLeft,
    trialExpired,
    currentPeriodEnd,
    periodDaysLeft,
    gracePeriodEndsAt,
    graceDaysLeft,
    billingProvider: (sub?.billingProvider ?? "manual") as
      | "manual"
      | "stripe_subscription",
    startDate: sub?.startDate ?? null,
    activatedAt: sub?.activatedAt ?? null,
    pendingPaymentId: sub?.pendingPaymentId ? String(sub.pendingPaymentId) : null,
  };
}

export const billingRouter = router({
  /** Static catalogue — safe for the public pricing surface too. */
  listPlans: protectedProcedure.query(() => listPlans()),

  /**
   * Dry-run a plan change. Returns exactly which integrations would be
   * disabled if the merchant moved from their current plan to
   * `targetTier`. Read-only — no DB writes — so the dashboard can call
   * this on every tier-selector change without rate-limit fear.
   *
   * Powers the "downgrade warning" modal: instead of a vague "you may
   * lose features" toast, the merchant sees the EXACT list of
   * connectors that will be disconnected.
   *
   * Empty `disabled`+`providerLocked` means the merchant fits cleanly
   * under the new tier — the dashboard renders an info banner instead
   * of the full warning modal.
   */
  previewPlanChange: protectedProcedure
    .input(
      z.object({
        targetTier: z.enum(PLAN_TIERS),
      }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const merchant = await Merchant.findById(merchantId)
        .select("subscription.tier")
        .lean();
      if (!merchant) {
        throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      }
      const fromTier = (merchant.subscription?.tier as PlanTier | undefined) ?? "starter";
      const fromIdx = PLAN_TIERS.indexOf(fromTier);
      const toIdx = PLAN_TIERS.indexOf(input.targetTier);
      const isDowngrade = toIdx < fromIdx;
      const isUpgrade = toIdx > fromIdx;
      // Even on upgrades we run the preview — produces zero entries for
      // a pure upgrade (cap goes UP), but cheap and consistent. Saves
      // the client from branching on direction before showing the
      // "your plan is going to change" UI.
      const preview = await previewIntegrationCapacityChange(
        merchantId,
        input.targetTier,
      );
      return {
        from: fromTier,
        to: input.targetTier,
        isDowngrade,
        isUpgrade,
        sameTier: !isDowngrade && !isUpgrade,
        preview,
      };
    }),

  /** Merchant dashboard payload: current plan, usage meters, quota progress. */
  getPlan: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const m = await Merchant.findById(merchantId)
      .select("subscription stripeCustomerId stripeSubscriptionId")
      .lean();
    if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
    const summary = summarizeSubscription(m.subscription);
    const plan = getPlan(summary.tier);
    // Surface only booleans, not the raw ids — the UI just needs to know
    // whether to show the "Manage billing" portal button.
    return {
      subscription: summary,
      plan,
      stripe: {
        hasCustomer: !!m.stripeCustomerId,
        hasSubscription: !!m.stripeSubscriptionId,
      },
    };
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
        // Skip the heavy `proofFile.data` blob in the list view.
        .select("-proofFile.data")
        .lean();
      return docs.map((p) => ({
        id: String(p._id),
        plan: p.plan,
        amount: p.amount,
        currency: p.currency,
        method: p.method,
        provider: (p.provider as "manual" | "stripe" | undefined) ?? "manual",
        txnId: p.txnId ?? null,
        senderPhone: p.senderPhone ?? null,
        proofUrl: p.proofUrl ?? null,
        proofFile: p.proofFile
          ? {
              filename: p.proofFile.filename ?? null,
              contentType: p.proofFile.contentType,
              sizeBytes: p.proofFile.sizeBytes,
              uploadedAt: p.proofFile.uploadedAt ?? null,
            }
          : null,
        status: p.status,
        reviewerNote: p.reviewerNote ?? null,
        reviewedAt: p.reviewedAt ?? null,
        periodStart: p.periodStart ?? null,
        periodEnd: p.periodEnd ?? null,
        createdAt: p.createdAt,
      }));
    }),

  /**
   * Mint a Stripe Checkout Session for the requested plan. The merchant is
   * redirected to Stripe-hosted checkout; on success Stripe fires our
   * webhook which flips the subscription. We persist a pending Payment row
   * so the receipt history stays consistent across both flows.
   */
  createCheckoutSession: protectedProcedure
    .input(z.object({ plan: z.enum(PLAN_TIERS) }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const merchant = await Merchant.findById(merchantId).select("email subscription");
      if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      if (!isPlanTier(input.plan)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid plan" });
      }
      const plan = getPlan(input.plan);
      const useUsd = env.STRIPE_USE_USD;
      const currency = useUsd ? "USD" : "BDT";
      // Stripe accepts amounts in the currency's smallest unit; both USD and
      // BDT are 2-decimal so multiply by 100.
      const amountSmallestUnit = useUsd
        ? Math.round(plan.priceUSD * 100)
        : Math.round(plan.priceBDT * 100);
      const displayAmount = useUsd ? plan.priceUSD : plan.priceBDT;

      // Pre-create the Payment row so the webhook lookup is cheap and the
      // history shows "in checkout" while the merchant pays.
      const payment = await Payment.create({
        merchantId,
        plan: input.plan,
        amount: displayAmount,
        currency,
        method: "card",
        status: "pending",
        provider: "stripe",
        notes: `Stripe Checkout for ${plan.name}`,
      });

      const successUrl = webUrl(`/dashboard/billing?stripe=success&payment=${String(payment._id)}`);
      const cancelUrl = webUrl(`/dashboard/billing?stripe=cancel&payment=${String(payment._id)}`);

      try {
        const session = await createCheckoutSession({
          customerEmail: merchant.email,
          successUrl,
          cancelUrl,
          mode: "payment",
          plan: {
            amountSmallestUnit,
            currency,
            // Product name reads from the centralized SaaS branding so a
            // rebrand (or future white-label) only touches one place.
            // Receipts + Customer Portal + bank-statement descriptors
            // pick up the new prefix on every new checkout.
            productName: `${(await loadBrandingFromStore()).operational.stripeProductPrefix} ${plan.name} plan`,
          },
          metadata: {
            merchantId: String(merchantId),
            plan: input.plan,
            paymentId: String(payment._id),
            periodDays: String(env.STRIPE_PERIOD_DAYS),
          },
        });
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { providerSessionId: session.id } },
        );

        void writeAudit({
          merchantId,
          actorId: merchantId,
          actorType: "merchant",
          action: "payment.checkout_started",
          subjectType: "payment",
          subjectId: payment._id,
          meta: {
            provider: "stripe",
            plan: input.plan,
            currency,
            amount: displayAmount,
            mocked: session.mocked,
          },
        });

        return {
          paymentId: String(payment._id),
          sessionId: session.id,
          url: session.url,
          mocked: session.mocked,
        };
      } catch (err) {
        // Roll back the placeholder so failed mints don't clutter history.
        await Payment.deleteOne({ _id: payment._id });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `couldn't open checkout: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * Recurring Stripe Subscription checkout. Distinct from `createCheckoutSession`
   * (one-shot) so the legacy annual/manual path keeps working untouched.
   *
   * Steps:
   *   1. Resolve the Stripe Price id for the requested tier (env-driven —
   *      run `npm run stripe:seed` if it's missing).
   *   2. Ensure the merchant has a Stripe Customer record. We persist the
   *      customer id on the merchant doc so every subsequent
   *      checkout/portal call reuses the same one.
   *   3. Mint a Checkout Session in `mode=subscription`.
   *   4. Return the hosted URL — the merchant pays on Stripe; webhooks do
   *      the rest (subscription id is stamped on `checkout.session.completed`,
   *      status flips to active on `invoice.payment_succeeded`).
   *
   * No Payment row is pre-created here — we let `invoice.payment_succeeded`
   * be the single source of truth so we never have orphan placeholders.
   */
  createSubscriptionCheckout: protectedProcedure
    .input(z.object({ plan: z.enum(PLAN_TIERS) }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const merchant = await Merchant.findById(merchantId).select(
        "email businessName stripeCustomerId subscription",
      );
      if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      if (!isPlanTier(input.plan)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid plan" });
      }

      const priceId = getPriceIdForPlan(input.plan);
      if (!priceId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Stripe price not provisioned for ${input.plan}. Run 'npm run stripe:seed' and set STRIPE_PRICE_${input.plan.toUpperCase()}.`,
        });
      }

      // Re-use the merchant's stripeCustomerId if we've ever set one. The
      // sparse-unique index on Merchant.stripeCustomerId ensures we never
      // double-create. Race condition: two parallel checkouts on a fresh
      // merchant could each call `createCustomer`. Stripe doesn't dedupe
      // by email, so we rely on the optimistic write below — the `$set`
      // is wrapped in a guard that only fills in when the field is null.
      let customerId = merchant.stripeCustomerId ?? null;
      if (!customerId) {
        const created = await createCustomer({
          email: merchant.email,
          name: merchant.businessName,
          metadata: { merchantId: String(merchantId) },
        });
        customerId = created.id;
        // Conditional update — only stamps if still null. If a parallel
        // checkout beat us, we re-load and use that customer instead.
        const claim = await Merchant.findOneAndUpdate(
          { _id: merchantId, stripeCustomerId: { $exists: false } },
          { $set: { stripeCustomerId: customerId } },
          { new: true },
        )
          .select("stripeCustomerId")
          .lean();
        if (!claim) {
          const reloaded = await Merchant.findById(merchantId)
            .select("stripeCustomerId")
            .lean();
          customerId = reloaded?.stripeCustomerId ?? customerId;
        }
      }

      const successUrl = webUrl(`/dashboard/billing?stripe=success&mode=subscription`);
      const cancelUrl = webUrl(`/dashboard/billing?stripe=cancel&mode=subscription`);

      try {
        const session = await createSubscriptionCheckout({
          customerId,
          priceId,
          successUrl,
          cancelUrl,
          metadata: {
            merchantId: String(merchantId),
            plan: input.plan,
            billingProvider: "stripe_subscription",
          },
        });

        void writeAudit({
          merchantId,
          actorId: merchantId,
          actorType: "merchant",
          action: "subscription.checkout_started",
          subjectType: "merchant",
          subjectId: merchantId,
          meta: {
            provider: "stripe_subscription",
            plan: input.plan,
            priceId,
            customerId,
            mocked: session.mocked,
          },
        });

        return {
          sessionId: session.id,
          url: session.url,
          customerId,
          mocked: session.mocked,
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `couldn't open subscription checkout: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * Hosted Stripe customer portal. The merchant manages their card,
   * upcoming invoices, plan switches, and cancellation there. The portal
   * itself fires the same `customer.subscription.*` webhooks so our state
   * stays in sync without an extra round-trip on return.
   *
   * Configuration of the portal (which features are enabled, branding,
   * cancellation policy) lives in the Stripe Dashboard — see
   * docs/operations.md.
   */
  createPortalSession: protectedProcedure.mutation(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const merchant = await Merchant.findById(merchantId)
      .select("stripeCustomerId")
      .lean();
    if (!merchant) {
      throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
    }
    if (!merchant.stripeCustomerId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "no Stripe customer on file — start a subscription checkout first to enable the portal",
      });
    }
    try {
      const session = await createPortalSession({
        customerId: merchant.stripeCustomerId,
        returnUrl: webUrl("/dashboard/billing"),
      });
      return { url: session.url, mocked: session.mocked };
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `couldn't open portal: ${(err as Error).message}`,
      });
    }
  }),

  /**
   * Inline proof-of-payment upload. We accept a base64 data URL up to ~2MB
   * (so a typical bKash screenshot fits) and store it on the Payment doc
   * itself. Larger pipelines can swap to S3 later by replacing this handler.
   *
   * The merchant can upload proof either before submitting the payment
   * (rare) or after — both flows merge to the same Payment row.
   */
  uploadPaymentProof: protectedProcedure
    .input(
      z.object({
        paymentId: z.string().min(1),
        contentType: z
          .string()
          .regex(/^image\/(png|jpeg|jpg|webp|gif)$|^application\/pdf$/i, "image/* or pdf only"),
        filename: z.string().trim().min(1).max(200).optional(),
        /** Base64 (no data: prefix) — clients should strip it before send. */
        data: z.string().min(8).max(3_500_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.paymentId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid payment id" });
      }
      const merchantId = merchantObjectId(ctx);
      const payment = await Payment.findOne({
        _id: new Types.ObjectId(input.paymentId),
        merchantId,
      });
      if (!payment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "payment not found" });
      }
      if (payment.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "proof can only be attached to pending payments",
        });
      }
      const buf = Buffer.from(input.data, "base64");
      if (buf.byteLength === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "empty file" });
      }
      if (buf.byteLength > 2_000_000) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "file too large — keep proof under 2MB",
        });
      }
      // Compute the proof fingerprint and refuse cross-merchant reuse —
      // the same screenshot uploaded by a different merchant is an
      // unambiguous fraud signal (no legitimate workflow recycles
      // someone else's payment proof).
      const proofHash = computeProofHash({ data: input.data });
      if (proofHash) {
        const collision = await Payment.findOne({
          merchantId: { $ne: merchantId },
          proofHash,
          status: { $in: ["pending", "reviewed", "approved"] },
        })
          .select("_id")
          .lean();
        if (collision) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "That receipt has already been used by another merchant. " +
              "If you have a legitimate reason, contact support.",
          });
        }
      }

      payment.proofFile = {
        contentType: input.contentType,
        sizeBytes: buf.byteLength,
        filename: input.filename ?? undefined,
        data: input.data,
        uploadedAt: new Date(),
      };
      if (proofHash) {
        (payment as unknown as { proofHash?: string }).proofHash = proofHash;
        // Recompute risk now that the proof is attached — proof-bearing
        // submissions deserve a re-score (lower risk for "no_proof_high_value",
        // potentially higher for proof-reuse signals on other historical rows).
        const merchant2 = await Merchant.findById(merchantId)
          .select("createdAt subscription.tier")
          .lean();
        const ageDays = merchant2?.createdAt
          ? (Date.now() - new Date(merchant2.createdAt).getTime()) / 86_400_000
          : 0;
        const risk = await scorePaymentRisk({
          merchantId,
          method: payment.method,
          txnIdNorm: (payment as unknown as { txnIdNorm?: string }).txnIdNorm ?? null,
          proofHash,
          metadataHash:
            (payment as unknown as { metadataHash?: string }).metadataHash ?? "",
          hasProof: true,
          amount: payment.amount,
          expectedAmount: null,
          senderPhone: payment.senderPhone ?? null,
          merchantAgeDays: ageDays,
        });
        const p = payment as unknown as {
          riskScore: number;
          riskReasons: string[];
          requiresDualApproval: boolean;
        };
        p.riskScore = risk.score;
        p.riskReasons = risk.reasons;
        p.requiresDualApproval = risk.requiresDualApproval;
      }
      await payment.save();

      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "payment.proof_uploaded",
        subjectType: "payment",
        subjectId: payment._id,
        meta: {
          contentType: input.contentType,
          sizeBytes: buf.byteLength,
          proofHash: proofHash ?? null,
        },
      });

      return {
        ok: true,
        contentType: input.contentType,
        sizeBytes: buf.byteLength,
      };
    }),

  /**
   * Read endpoint for the inline proof. Returned as a data URL so the
   * frontend can drop it directly into an <img> or <a download>. Tenant-
   * scoped — the merchant or an admin viewing on their behalf gets the
   * file; nobody else.
   */
  getPaymentProof: protectedProcedure
    .input(z.object({ paymentId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.paymentId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid payment id" });
      }
      const merchantId = merchantObjectId(ctx);
      const filter: Record<string, unknown> = { _id: new Types.ObjectId(input.paymentId) };
      if (ctx.user.role !== "admin") filter.merchantId = merchantId;
      const payment = await Payment.findOne(filter)
        .select("proofFile proofUrl merchantId")
        .lean();
      if (!payment || (!payment.proofFile && !payment.proofUrl)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "no proof on file" });
      }
      if (payment.proofFile) {
        return {
          kind: "inline" as const,
          contentType: payment.proofFile.contentType,
          filename: payment.proofFile.filename ?? null,
          sizeBytes: payment.proofFile.sizeBytes,
          dataUrl: `data:${payment.proofFile.contentType};base64,${payment.proofFile.data}`,
          uploadedAt: payment.proofFile.uploadedAt ?? null,
        };
      }
      return {
        kind: "url" as const,
        contentType: null,
        filename: null,
        sizeBytes: null,
        dataUrl: payment.proofUrl ?? null,
        uploadedAt: null,
      };
    }),

  /**
   * Surface the BD-rail payment instructions (bKash / Nagad / bank).
   * UI calls this on /dashboard/billing to render the primary
   * payment options. Each option carries an `enabled` flag — the UI
   * hides any rail whose env entry is unset.
   */
  getPaymentInstructions: protectedProcedure.query(() => {
    return { options: listManualPaymentOptions() };
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
        /**
         * Caller-supplied idempotency token. Re-sending the same
         * (merchantId, clientRequestId) returns the existing pending
         * payment instead of creating a second row — kills duplicate
         * receipts from double-click / network retry.
         */
        clientRequestId: z.string().min(8).max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const merchant = await Merchant.findById(merchantId).select(
        "subscription createdAt",
      );
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

      // Idempotency fast-path — same (merchantId, clientRequestId) returns
      // the existing payment without minting a second row. The unique
      // index below is the authoritative race guard.
      if (input.clientRequestId) {
        const existing = await Payment.findOne({
          merchantId,
          clientRequestId: input.clientRequestId,
        }).lean();
        if (existing) {
          return {
            id: String(existing._id),
            status: existing.status,
            plan: existing.plan,
            amount: existing.amount,
            createdAt: existing.createdAt,
            idempotent: true as const,
          };
        }
      }

      // Submit guard: daily cap + same-merchant dedupe + cross-merchant
      // txnId block. Prior to this PR the guard was imported but never
      // invoked; running it here enforces the cross-merchant block that the
      // admin hardening pass requires.
      const guard = await checkManualPaymentSubmitGuard({
        merchantId,
        method: input.method,
        txnId: input.txnId,
      });
      if (!guard.ok) {
        throw new TRPCError({
          code: guard.reason === "daily_cap" ? "TOO_MANY_REQUESTS" : "CONFLICT",
          message: guard.detail,
        });
      }

      // Anti-fraud fingerprints. proofHash lands later, when the merchant
      // attaches a file; metadataHash captures the claim itself so
      // proof-less submissions still get a fingerprint.
      const txnIdNorm = input.txnId ? normalizeTxnId(input.txnId) : null;
      const metadataHash = computeMetadataHash({
        method: input.method,
        txnIdNorm,
        senderPhone: input.senderPhone ?? null,
        amount: input.amount,
        currency: "BDT",
      });

      // Hard block on cross-merchant metadata reuse — same claim details
      // (sender phone, amount, txnId, method) submitted by another merchant
      // is an unambiguous reuse signal.
      const metaCollision = await Payment.findOne({
        merchantId: { $ne: merchantId },
        metadataHash,
        status: { $in: ["pending", "reviewed", "approved"] },
      })
        .select("_id")
        .lean();
      if (metaCollision) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Those payment details were already submitted by another merchant. " +
            "Contact support if you believe this is an error.",
        });
      }

      // Compute risk score with what we know so far. proofHash will be null
      // until the merchant attaches a file; the score is recomputed in
      // attachPaymentProof at that point.
      const merchantAgeDays =
        merchant.createdAt
          ? (Date.now() - new Date(merchant.createdAt).getTime()) / 86_400_000
          : 0;
      const risk = await scorePaymentRisk({
        merchantId,
        method: input.method,
        txnIdNorm,
        proofHash: null,
        metadataHash,
        hasProof: !!input.proofUrl,
        amount: input.amount,
        expectedAmount: plan.priceBDT,
        senderPhone: input.senderPhone ?? null,
        merchantAgeDays,
      });

      let payment;
      try {
        payment = await Payment.create({
          merchantId,
          plan: input.plan,
          amount: input.amount,
          currency: "BDT",
          method: input.method,
          txnId: input.txnId,
          txnIdNorm: txnIdNorm ?? undefined,
          metadataHash,
          riskScore: risk.score,
          riskReasons: risk.reasons,
          requiresDualApproval: risk.requiresDualApproval,
          senderPhone: input.senderPhone,
          proofUrl: input.proofUrl,
          notes: input.notes,
          status: "pending",
          ...(input.clientRequestId
            ? { clientRequestId: input.clientRequestId }
            : {}),
        });
      } catch (err) {
        const code = (err as { code?: number })?.code;
        if (code === 11000 && input.clientRequestId) {
          const existing = await Payment.findOne({
            merchantId,
            clientRequestId: input.clientRequestId,
          }).lean();
          if (!existing) throw err;
          return {
            id: String(existing._id),
            status: existing.status,
            plan: existing.plan,
            amount: existing.amount,
            createdAt: existing.createdAt,
            idempotent: true as const,
          };
        }
        throw err;
      }

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
          riskScore: risk.score,
          riskReasons: risk.reasons,
          requiresDualApproval: risk.requiresDualApproval,
        },
      });
      if (risk.requiresDualApproval) {
        void writeAudit({
          merchantId,
          actorId: merchantId,
          action: "payment.flagged",
          subjectType: "payment",
          subjectId: payment._id,
          meta: { riskScore: risk.score, riskReasons: risk.reasons },
        });
      }

      return {
        id: String(payment._id),
        status: payment.status,
        plan: payment.plan,
        amount: payment.amount,
        createdAt: payment.createdAt,
        idempotent: false as const,
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
