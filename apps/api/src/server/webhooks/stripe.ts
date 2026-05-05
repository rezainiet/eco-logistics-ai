import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { Merchant, Payment } from "@ecom/db";
import { env } from "../../env.js";
import { verifyStripeWebhook } from "../../lib/stripe.js";
import { invalidateSubscriptionCache } from "../trpc.js";
import { writeAudit } from "../../lib/audit.js";
import { getPlan, isPlanTier, PLAN_TIERS, type PlanTier } from "../../lib/plans.js";
import { enforceDowngradeIfNeeded } from "../../lib/entitlements.js";
import {
  buildPaymentApprovedEmail,
  buildPaymentFailedEmail,
  sendEmail,
  webUrl,
} from "../../lib/email.js";

/**
 * Stripe webhook receiver.
 *
 * Mounted at `/api/webhooks/stripe`. Stripe HMAC-signs the raw body, so we
 * use `express.raw` (the global JSON parser would mutate whitespace and
 * break verification). We dedupe via the `Payment.providerEventId` unique
 * index — Stripe retries up to 3 days, but only the first delivery flips
 * the merchant's subscription.
 *
 * Idempotency boundary lives at the DB layer: every successful event is
 * persisted with `providerEventId = evt_…` under a unique partial index.
 * A retry hits 11000 (duplicate key) and we short-circuit.
 *
 * In dev (no STRIPE_WEBHOOK_SECRET) the endpoint is intentionally disabled
 * so a misconfigured deployment doesn't silently accept unsigned events.
 */
export const stripeWebhookRouter = express.Router();

interface StripeEvent<T = unknown> {
  id: string;
  type: string;
  data: { object: T };
}

interface CheckoutSessionObject {
  id: string;
  object?: string;
  /**
   * Set on `mode=subscription` sessions only. Stripe omits the field on
   * one-shot `mode=payment` sessions.
   */
  mode?: "payment" | "subscription" | "setup";
  customer?: string;
  customer_email?: string;
  subscription?: string;
  payment_intent?: string;
  payment_status?: string;
  status?: string;
  amount_total?: number;
  currency?: string;
  metadata?: Record<string, string>;
}

interface SubscriptionObject {
  id: string;
  customer?: string;
  status?:
    | "active"
    | "past_due"
    | "trialing"
    | "incomplete"
    | "incomplete_expired"
    | "canceled"
    | "unpaid"
    | "paused";
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  canceled_at?: number;
  items?: { data?: Array<{ price?: { id?: string } }> };
  metadata?: Record<string, string>;
}

interface InvoiceObject {
  id: string;
  customer?: string;
  subscription?: string;
  payment_intent?: string;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  status?: string;
  hosted_invoice_url?: string;
  period_start?: number;
  period_end?: number;
  next_payment_attempt?: number | null;
  lines?: { data?: Array<{ price?: { id?: string } }> };
  metadata?: Record<string, string>;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function fromUnixSeconds(s: number | undefined | null): Date | null {
  if (typeof s !== "number" || !Number.isFinite(s)) return null;
  return new Date(s * 1000);
}

stripeWebhookRouter.post(
  "/",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req: Request, res: Response) => {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      // Hard refuse rather than silently accept unsigned traffic.
      return res.status(503).json({ ok: false, error: "stripe_webhook_disabled" });
    }
    const rawBuf = req.body as Buffer;
    const rawString = rawBuf.toString("utf8");

    const verdict = verifyStripeWebhook({
      rawBody: rawString,
      signatureHeader: req.headers["stripe-signature"],
      secret: env.STRIPE_WEBHOOK_SECRET,
    });
    if (!verdict.ok) {
      return res.status(401).json({ ok: false, error: verdict.reason });
    }

    let event: StripeEvent;
    try {
      event = JSON.parse(rawString) as StripeEvent;
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_json" });
    }
    if (!event?.id || !event?.type) {
      return res.status(400).json({ ok: false, error: "missing_event_fields" });
    }

    try {
      const result = await dispatchStripeEvent(event);
      const status = result.ok ? 200 : result.error === "missing_merchant_metadata" || result.error === "missing_plan_metadata" || result.error === "payment_row_not_found" ? 200 : 200;
      return res.status(status).json(result);
    } catch (err) {
      console.error(`[stripe] handler ${event.type} threw`, (err as Error).message);
      // Return 500 so Stripe retries — handlers shouldn't normally throw,
      // they should return {ok:false} for known failure modes.
      return res.status(500).json({ ok: false, error: "handler_threw" });
    }
  },
);

interface DispatchResult {
  ok: boolean;
  duplicate?: boolean;
  ignored?: boolean;
  paymentId?: string;
  merchantId?: string;
  error?: string;
  type?: string;
}

/**
 * Dispatch a verified, parsed Stripe event to the right handler.
 * Exported so tests can drive handlers without going through Express.
 */
export async function dispatchStripeEvent(event: StripeEvent): Promise<DispatchResult> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data?.object as CheckoutSessionObject | undefined;
      if (!session?.id) return { ok: false, error: "missing_session" };
      // Subscription mode → record IDs only; activation arrives via
      // invoice.payment_succeeded so we have a single source of truth.
      if (session.mode === "subscription") {
        return handleSubscriptionCheckoutCompleted(event.id, session);
      }
      // Legacy mode=payment path — kept verbatim so the one-shot Checkout
      // flow from Sprint B still works.
      if (session.payment_status && session.payment_status !== "paid") {
        return { ok: true, ignored: true, type: event.type };
      }
      return activateFromCheckoutSession({ eventId: event.id, session });
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data?.object as SubscriptionObject | undefined;
      if (!sub?.id) return { ok: false, error: "missing_subscription" };
      return handleSubscriptionUpdated(event, sub);
    }
    case "invoice.payment_succeeded": {
      const inv = event.data?.object as InvoiceObject | undefined;
      if (!inv?.id) return { ok: false, error: "missing_invoice" };
      return handleInvoicePaymentSucceeded(event.id, inv);
    }
    case "invoice.payment_failed": {
      const inv = event.data?.object as InvoiceObject | undefined;
      if (!inv?.id) return { ok: false, error: "missing_invoice" };
      return handleInvoicePaymentFailed(event.id, inv);
    }
    default:
      return { ok: true, ignored: true, type: event.type };
  }
}

interface ActivationResult {
  ok: boolean;
  duplicate?: boolean;
  paymentId?: string;
  error?: string;
}

export async function activateFromCheckoutSession(args: {
  eventId: string;
  session: CheckoutSessionObject;
}): Promise<ActivationResult> {
  const session = args.session;
  const meta = session.metadata ?? {};
  const merchantIdStr = meta.merchantId;
  const planTier = meta.plan;
  const paymentIdHint = meta.paymentId;
  const periodDays = Number(meta.periodDays || env.STRIPE_PERIOD_DAYS) || env.STRIPE_PERIOD_DAYS;

  if (!merchantIdStr || !Types.ObjectId.isValid(merchantIdStr)) {
    return { ok: false, error: "missing_merchant_metadata" };
  }
  if (!planTier || !isPlanTier(planTier)) {
    return { ok: false, error: "missing_plan_metadata" };
  }
  const merchantObjId = new Types.ObjectId(merchantIdStr);

  // Atomic event-id claim. Two conditions can land here:
  //   1. We already processed this event id → duplicate.
  //   2. The Payment row already had a different event id stamped → still
  //      a duplicate (older retry path) and we no-op.
  // Either way, success is idempotent: 200 with `duplicate: true`.
  const filter: Record<string, unknown> = paymentIdHint && Types.ObjectId.isValid(paymentIdHint)
    ? { _id: new Types.ObjectId(paymentIdHint), merchantId: merchantObjId }
    : { providerSessionId: session.id, merchantId: merchantObjId };

  const existing = await Payment.findOne(filter);
  if (!existing) {
    // Defensive: a webhook for a session we never minted means the metadata
    // was forged. Refuse to activate.
    return { ok: false, error: "payment_row_not_found" };
  }
  if (existing.providerEventId === args.eventId || existing.status === "approved") {
    return { ok: true, duplicate: true, paymentId: String(existing._id) };
  }

  const merchant = await Merchant.findById(merchantObjId).select(
    "subscription email businessName",
  );
  if (!merchant) return { ok: false, error: "merchant_missing" };

  const plan = getPlan(planTier);
  const now = new Date();
  const periodStart = now;
  const periodEnd = addDays(now, periodDays);

  merchant.subscription = merchant.subscription ?? {};
  const sub = merchant.subscription as Record<string, unknown>;
  // Capture prevTier before overwriting — checkout is rarely a downgrade
  // (most merchants check out from trial), but if a paid merchant
  // re-checks-out at a lower tier we must still enforce capacity.
  const prevTier = sub.tier as PlanTier | undefined;
  sub.tier = plan.tier;
  sub.rate = plan.priceBDT;
  sub.status = "active";
  sub.activatedAt = now;
  sub.activatedBy = "stripe";
  sub.currentPeriodEnd = periodEnd;
  sub.trialEndsAt = null;
  sub.pendingPaymentId = null;
  await merchant.save();
  invalidateSubscriptionCache(String(merchant._id));

  // FIX (downgrade enforcement): defensive call — no-op when prevTier
  // is undefined (trial→paid) or when plan.tier >= prevTier.
  void enforceDowngradeIfNeeded({
    merchantId: merchant._id as Types.ObjectId,
    prevTier,
    newTier: plan.tier,
    source: "stripe_checkout",
  });

  existing.status = "approved";
  existing.providerEventId = args.eventId;
  existing.providerSessionId = session.id;
  existing.providerChargeId = session.payment_intent ?? existing.providerChargeId;
  existing.reviewedAt = now;
  existing.reviewerNote = "Auto-approved via Stripe Checkout";
  existing.periodStart = periodStart;
  existing.periodEnd = periodEnd;
  // Stripe ships amount_total in smallest unit; mirror onto the row so the
  // history shows what was actually charged (not the catalog price).
  if (typeof session.amount_total === "number" && session.currency) {
    existing.amount = session.amount_total / 100;
    existing.currency = session.currency.toUpperCase();
  }
  try {
    await existing.save();
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e?.code === 11000) {
      // Another concurrent webhook delivery beat us — that's fine, both
      // converged on the same final state.
      return { ok: true, duplicate: true, paymentId: String(existing._id) };
    }
    throw err;
  }

  void writeAudit({
    merchantId: merchant._id,
    actorId: merchant._id,
    actorType: "system",
    action: "payment.checkout_completed",
    subjectType: "payment",
    subjectId: existing._id,
    meta: {
      provider: "stripe",
      eventId: args.eventId,
      plan: plan.tier,
      amount: existing.amount,
      currency: existing.currency,
      periodEnd,
    },
  });
  void writeAudit({
    merchantId: merchant._id,
    actorId: merchant._id,
    actorType: "system",
    action: "subscription.activated",
    subjectType: "merchant",
    subjectId: merchant._id,
    meta: { tier: plan.tier, periodEnd, source: "stripe" },
  });

  // Receipt email — mirrors the manual approval flow. Fire-and-forget.
  const tpl = buildPaymentApprovedEmail({
    businessName: merchant.businessName,
    planName: plan.name,
    amount: existing.amount,
    currency: existing.currency,
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
    console.error("[stripe] receipt email failed", (err as Error).message),
  );

  return { ok: true, paymentId: String(existing._id) };
}

/* ───────────────── subscription-mode webhook handlers ────────────────── */

/**
 * Resolve a merchant by `metadata.merchantId` (preferred) or by
 * `stripeCustomerId` / `stripeSubscriptionId` lookup. The first is the
 * happy path because we set the metadata on subscription creation;
 * fallbacks cover the case where Stripe fires events on a Subscription
 * created out-of-band (e.g. portal-driven plan switch on a parent
 * subscription that already existed).
 */
async function resolveMerchantId(args: {
  metadata?: Record<string, string>;
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<Types.ObjectId | null> {
  const metaId = args.metadata?.merchantId;
  if (metaId && Types.ObjectId.isValid(metaId)) {
    return new Types.ObjectId(metaId);
  }
  if (args.subscriptionId) {
    const m = await Merchant.findOne({ stripeSubscriptionId: args.subscriptionId })
      .select("_id")
      .lean();
    if (m) return m._id;
  }
  if (args.customerId) {
    const m = await Merchant.findOne({ stripeCustomerId: args.customerId })
      .select("_id")
      .lean();
    if (m) return m._id;
  }
  return null;
}

function planTierFromPriceId(priceId: string | undefined | null): PlanTier | null {
  if (!priceId) return null;
  for (const tier of PLAN_TIERS) {
    const envKey = `STRIPE_PRICE_${tier.toUpperCase()}` as keyof typeof env;
    if (env[envKey] === priceId) return tier;
  }
  return null;
}

/**
 * Handle `checkout.session.completed` for `mode=subscription`.
 *
 * On the first delivery this stamps the merchant doc with
 * `stripeCustomerId` + `stripeSubscriptionId` + `billingProvider`.
 * Activation / period rollover is done by `invoice.payment_succeeded`
 * (which always fires immediately after for paid subscriptions) so we
 * never have two sources of truth for the active state.
 *
 * Idempotency: every field set is `set`-style and re-running the same
 * event simply re-asserts the same values.
 */
async function handleSubscriptionCheckoutCompleted(
  eventId: string,
  session: CheckoutSessionObject,
): Promise<DispatchResult> {
  const merchantId = await resolveMerchantId({
    metadata: session.metadata,
    customerId: session.customer ?? null,
    subscriptionId: session.subscription ?? null,
  });
  if (!merchantId) return { ok: false, error: "merchant_missing" };
  if (!session.subscription) return { ok: false, error: "missing_subscription_on_session" };

  await Merchant.updateOne(
    { _id: merchantId },
    {
      $set: {
        stripeCustomerId: session.customer ?? undefined,
        stripeSubscriptionId: session.subscription,
        "subscription.billingProvider": "stripe_subscription",
        "subscription.pendingPaymentId": null,
      },
    },
  );
  invalidateSubscriptionCache(String(merchantId));

  void writeAudit({
    merchantId,
    actorId: merchantId,
    actorType: "system",
    action: "subscription.recurring_started",
    subjectType: "merchant",
    subjectId: merchantId,
    meta: {
      provider: "stripe_subscription",
      eventId,
      stripeCustomerId: session.customer ?? null,
      stripeSubscriptionId: session.subscription,
      plan: session.metadata?.plan ?? null,
    },
  });
  return { ok: true, merchantId: String(merchantId), type: "checkout.session.completed" };
}

/**
 * Handle `customer.subscription.updated` and `customer.subscription.deleted`.
 *
 * Stripe fires `updated` for state transitions (active → past_due,
 * past_due → canceled, plan switch via portal, period rollover, etc.) and
 * `deleted` once at the end of life (after grace, on cancel-immediately,
 * or after dunning gives up). Both are idempotent state-set operations
 * so retries are harmless.
 */
async function handleSubscriptionUpdated(
  event: StripeEvent,
  sub: SubscriptionObject,
): Promise<DispatchResult> {
  const merchantId = await resolveMerchantId({
    metadata: sub.metadata,
    customerId: sub.customer ?? null,
    subscriptionId: sub.id,
  });
  if (!merchantId) return { ok: false, error: "merchant_missing" };

  const merchant = await Merchant.findById(merchantId).select("subscription email businessName");
  if (!merchant) return { ok: false, error: "merchant_missing" };
  merchant.subscription = merchant.subscription ?? {};
  const subDoc = merchant.subscription as Record<string, unknown>;
  const stripeStatus = sub.status ?? "active";
  // Map Stripe states to ours. We only flip status here; grace bookkeeping
  // is owned by `invoice.payment_failed`. `canceled` is final — we keep
  // `currentPeriodEnd` so the merchant retains access until then.
  const wasCanceledEvent = event.type === "customer.subscription.deleted";
  if (wasCanceledEvent || stripeStatus === "canceled") {
    subDoc.status = "cancelled";
  } else if (stripeStatus === "active" || stripeStatus === "trialing") {
    subDoc.status = "active";
    subDoc.gracePeriodEndsAt = null;
  } else if (stripeStatus === "past_due" || stripeStatus === "unpaid") {
    subDoc.status = "past_due";
  } else if (stripeStatus === "paused") {
    subDoc.status = "paused";
  }
  // Always sync the period end — even on cancellation it's the access cutoff.
  const cpe = fromUnixSeconds(sub.current_period_end);
  if (cpe) subDoc.currentPeriodEnd = cpe;

  // Plan switch via Stripe Portal — re-derive tier from the price id.
  // Capture the previous tier BEFORE we overwrite it so the downgrade
  // helper below can compare old vs new and run capacity enforcement.
  const prevTier = subDoc.tier as PlanTier | undefined;
  const priceId = sub.items?.data?.[0]?.price?.id;
  const tier = planTierFromPriceId(priceId);
  if (tier) {
    const plan = getPlan(tier);
    subDoc.tier = plan.tier;
    subDoc.rate = plan.priceBDT;
  }

  // Stamp the subscription id idempotently. If we never saw the id before
  // (e.g. portal-driven cancellation of a record we lost), set it now.
  if (!merchant.stripeSubscriptionId) {
    merchant.stripeSubscriptionId = sub.id;
  }
  if (sub.customer && !merchant.stripeCustomerId) {
    merchant.stripeCustomerId = sub.customer;
  }
  merchant.subscription.billingProvider = "stripe_subscription";

  await merchant.save();
  invalidateSubscriptionCache(String(merchant._id));

  // FIX (downgrade enforcement): if the Stripe portal switched the
  // merchant to a lower tier (e.g. Scale → Starter), the previous code
  // updated `subDoc.tier` and walked away — leaving any provider-locked
  // (Woo on Starter) or over-cap integrations active. Now we run the
  // shared helper which calls `enforceIntegrationCapacity` and fires a
  // merchant-facing notification listing what was disabled. Pure no-op
  // for upgrades or same-tier writes.
  if (tier) {
    void enforceDowngradeIfNeeded({
      merchantId: merchant._id as Types.ObjectId,
      prevTier,
      newTier: tier,
      source: "stripe_portal",
    });
  }

  void writeAudit({
    merchantId: merchant._id,
    actorId: merchant._id,
    actorType: "system",
    action: wasCanceledEvent ? "subscription.cancelled" : "subscription.synced",
    subjectType: "merchant",
    subjectId: merchant._id,
    meta: {
      eventId: event.id,
      stripeStatus,
      tier: tier ?? subDoc.tier ?? null,
      currentPeriodEnd: cpe ?? null,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    },
  });
  return { ok: true, merchantId: String(merchant._id), type: event.type };
}

/**
 * Handle `invoice.payment_succeeded`.
 *
 * This is the single source of truth for activation in the recurring
 * flow. Idempotency: `Payment.invoiceId` is sparse-unique, so a duplicate
 * delivery hits 11000 and we short-circuit — but we still re-assert the
 * merchant's active state so a partial-write retry converges to "active".
 */
async function handleInvoicePaymentSucceeded(
  eventId: string,
  inv: InvoiceObject,
): Promise<DispatchResult> {
  const merchantId = await resolveMerchantId({
    metadata: inv.metadata,
    customerId: inv.customer ?? null,
    subscriptionId: inv.subscription ?? null,
  });
  if (!merchantId) return { ok: false, error: "merchant_missing" };

  // Best-effort idempotency check first — saves a Merchant.save() on retries.
  const existingPayment = await Payment.findOne({ invoiceId: inv.id })
    .select("_id status providerEventId")
    .lean();
  const alreadyApproved =
    !!existingPayment &&
    existingPayment.status === "approved" &&
    existingPayment.providerEventId === eventId;

  const merchant = await Merchant.findById(merchantId).select(
    "subscription email businessName stripeCustomerId stripeSubscriptionId",
  );
  if (!merchant) return { ok: false, error: "merchant_missing" };

  // Tier mapping: prefer the price id on the invoice line. Fall back to
  // the merchant's currently-stored tier so we don't downgrade on a
  // mid-cycle invoice that doesn't include line items (rare).
  const priceId = inv.lines?.data?.[0]?.price?.id;
  const inferredTier = planTierFromPriceId(priceId);
  const tier =
    inferredTier ??
    ((merchant.subscription?.tier as PlanTier | undefined) ?? "starter");
  const plan = getPlan(tier);

  const periodStart = fromUnixSeconds(inv.period_start) ?? new Date();
  const periodEnd = fromUnixSeconds(inv.period_end) ?? addDays(new Date(), env.STRIPE_PERIOD_DAYS);

  // Idempotent merchant flip — every field is a set, never a delta.
  // Capture the previous tier BEFORE the assignment so the downgrade
  // helper below sees the real before-state.
  merchant.subscription = merchant.subscription ?? {};
  const subDoc = merchant.subscription as Record<string, unknown>;
  const prevTier = subDoc.tier as PlanTier | undefined;
  subDoc.status = "active";
  subDoc.tier = plan.tier;
  subDoc.rate = plan.priceBDT;
  subDoc.activatedAt = subDoc.activatedAt ?? new Date();
  subDoc.activatedBy = "stripe_subscription";
  subDoc.currentPeriodEnd = periodEnd;
  subDoc.trialEndsAt = null;
  subDoc.pendingPaymentId = null;
  subDoc.gracePeriodEndsAt = null;
  subDoc.billingProvider = "stripe_subscription";
  if (inv.subscription && !merchant.stripeSubscriptionId) {
    merchant.stripeSubscriptionId = inv.subscription;
  }
  if (inv.customer && !merchant.stripeCustomerId) {
    merchant.stripeCustomerId = inv.customer;
  }
  await merchant.save();
  invalidateSubscriptionCache(String(merchant._id));

  // FIX (downgrade enforcement): the recurring invoice can land at a
  // tier lower than the merchant's previous one if they used the Stripe
  // portal to switch plans mid-cycle and the new period rolled over.
  // Run the same shared helper as the portal handler — no-op for
  // upgrades / same-tier renewals.
  void enforceDowngradeIfNeeded({
    merchantId: merchant._id as Types.ObjectId,
    prevTier,
    newTier: plan.tier,
    source: "stripe_invoice",
  });

  // Upsert the Payment row keyed on invoiceId. setOnInsert handles the
  // first-time insert; the $set keeps converging to the final values on
  // any retry. This is the linchpin that makes duplicate webhook
  // deliveries safe.
  const amount =
    typeof inv.amount_paid === "number" && inv.amount_paid > 0
      ? inv.amount_paid / 100
      : plan.priceBDT;
  const currency = (inv.currency ?? "USD").toUpperCase();
  const upserted = await Payment.findOneAndUpdate(
    { invoiceId: inv.id },
    {
      $setOnInsert: {
        merchantId,
        method: "card",
        provider: "stripe",
        invoiceId: inv.id,
        plan: plan.tier,
        notes: "Stripe subscription invoice",
      },
      $set: {
        status: "approved",
        amount,
        currency,
        subscriptionId: inv.subscription ?? null,
        providerChargeId: inv.payment_intent ?? null,
        providerEventId: eventId,
        reviewedAt: new Date(),
        reviewerNote: "Auto-approved via Stripe subscription",
        periodStart,
        periodEnd,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (!alreadyApproved) {
    void writeAudit({
      merchantId,
      actorId: merchantId,
      actorType: "system",
      action: "subscription.payment_recovered",
      subjectType: "payment",
      subjectId: upserted!._id,
      meta: {
        eventId,
        invoiceId: inv.id,
        amount,
        currency,
        periodEnd,
      },
    });

    const tpl = buildPaymentApprovedEmail({
      businessName: merchant.businessName,
      planName: plan.name,
      amount,
      currency,
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
      console.error("[stripe] subscription receipt email failed", (err as Error).message),
    );
  }

  return {
    ok: true,
    duplicate: alreadyApproved,
    paymentId: upserted ? String(upserted._id) : undefined,
    merchantId: String(merchantId),
    type: "invoice.payment_succeeded",
  };
}

/**
 * Handle `invoice.payment_failed`.
 *
 * Stripe will keep retrying via smart-retry for ~3 weeks; we want a
 * tighter customer-visible grace window (default 7 days) so the merchant
 * feels the pressure to update their card. We:
 *   - Flip status to past_due
 *   - Stamp `gracePeriodEndsAt = now + STRIPE_GRACE_DAYS` (only on the
 *     FIRST failure — retries don't extend it)
 *   - Email a dunning notice on first failure only (we dedupe via the
 *     payment row's existing eventId)
 *
 * The grace worker (separate sweep) flips past_due → suspended once the
 * deadline passes. Recovery on a later `invoice.payment_succeeded` clears
 * the grace timer.
 */
async function handleInvoicePaymentFailed(
  eventId: string,
  inv: InvoiceObject,
): Promise<DispatchResult> {
  const merchantId = await resolveMerchantId({
    metadata: inv.metadata,
    customerId: inv.customer ?? null,
    subscriptionId: inv.subscription ?? null,
  });
  if (!merchantId) return { ok: false, error: "merchant_missing" };

  const merchant = await Merchant.findById(merchantId).select(
    "subscription email businessName",
  );
  if (!merchant) return { ok: false, error: "merchant_missing" };
  merchant.subscription = merchant.subscription ?? {};
  const subDoc = merchant.subscription as Record<string, unknown>;

  // Only set gracePeriodEndsAt on the first failure for this invoice.
  // Stripe smart-retry can fire payment_failed multiple times per invoice
  // — extending grace each time would let merchants stall indefinitely.
  const isFirstFailure = !subDoc.gracePeriodEndsAt;
  if (isFirstFailure) {
    subDoc.gracePeriodEndsAt = addDays(new Date(), env.STRIPE_GRACE_DAYS);
  }
  // Only flip status if not already in a worse state. A merchant who's
  // already been suspended shouldn't bounce back to past_due.
  if (subDoc.status === "active" || subDoc.status === "trial") {
    subDoc.status = "past_due";
  }
  await merchant.save();
  invalidateSubscriptionCache(String(merchant._id));

  // Persist a paper-trail Payment row in `pending` (so the merchant sees
  // what failed) — sparse-unique on invoiceId so retries are no-ops.
  await Payment.findOneAndUpdate(
    { invoiceId: inv.id },
    {
      $setOnInsert: {
        merchantId,
        method: "card",
        provider: "stripe",
        invoiceId: inv.id,
        plan: (subDoc.tier as PlanTier | undefined) ?? "starter",
        amount:
          typeof inv.amount_due === "number" ? inv.amount_due / 100 : 0,
        currency: (inv.currency ?? "USD").toUpperCase(),
      },
      $set: {
        status: "pending",
        subscriptionId: inv.subscription ?? null,
        providerEventId: eventId,
        notes: "Invoice payment failed — Stripe will retry",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (isFirstFailure) {
    const tpl = buildPaymentFailedEmail({
      businessName: merchant.businessName,
      gracePeriodEndsAt: subDoc.gracePeriodEndsAt as Date,
      billingUrl: webUrl("/dashboard/billing"),
    });
    void sendEmail({
      to: merchant.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: "payment_failed",
    }).catch((err) =>
      console.error("[stripe] dunning email failed", (err as Error).message),
    );

    void writeAudit({
      merchantId,
      actorId: merchantId,
      actorType: "system",
      action: "subscription.payment_failed",
      subjectType: "merchant",
      subjectId: merchantId,
      meta: {
        eventId,
        invoiceId: inv.id,
        gracePeriodEndsAt: subDoc.gracePeriodEndsAt as Date,
        nextPaymentAttempt: fromUnixSeconds(inv.next_payment_attempt ?? null),
      },
    });
  }

  return {
    ok: true,
    merchantId: String(merchantId),
    type: "invoice.payment_failed",
  };
}
