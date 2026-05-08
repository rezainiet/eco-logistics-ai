"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowLeft, MessageCircle, RefreshCw } from "lucide-react";
import { getBrandingSync } from "@ecom/branding";
import { Button } from "@/components/ui/button";

const SAAS_BRANDING = getBrandingSync();

/**
 * Maps the upstream `?reason=` query into a human explanation. The keys
 * mirror the codes Stripe and our bKash adapter return on payment_intent
 * / charge failures. Anything we don't recognise falls back to the
 * generic line so we never show a raw API enum to the merchant.
 */
const REASON_DETAIL: Record<string, { title: string; body: string }> = {
  card_declined: {
    title: "Your card was declined.",
    body: "Your bank declined the charge. Try a different card, or contact your bank if it keeps happening.",
  },
  insufficient_funds: {
    title: "Not enough funds on the card.",
    body: "The charge couldn't be completed because the card has insufficient funds. Try another card or top up.",
  },
  expired_card: {
    title: "That card has expired.",
    body: "The expiry date on this card has passed. Use a different card to continue.",
  },
  authentication_required: {
    title: "Your bank needs to confirm the payment.",
    body: "The transaction needs an extra verification step from your bank (3-D Secure / OTP). Retry and complete the prompt this time.",
  },
  bkash_timeout: {
    title: "bKash didn't confirm in time.",
    body: "We didn't see a successful confirmation from bKash. If you were charged, the amount will be reversed within 5–7 working days. You can retry below.",
  },
  cancelled: {
    title: "Payment was cancelled.",
    body: "You closed the payment window before it finished. No charge was made.",
  },
};

function PaymentFailedInner() {
  const params = useSearchParams();
  const reason = params.get("reason") ?? "";
  const planSlug = params.get("plan") ?? "";

  const detail = REASON_DETAIL[reason] ?? {
    title: "Your payment didn't go through.",
    body: "Something blocked the charge. No money was taken. Try again, or pick a different payment method.",
  };

  // Retry destination preserves the chosen plan so the merchant doesn't
  // re-pick it on the billing page. Falls back to /dashboard/billing for
  // the no-plan case.
  const retryHref = planSlug
    ? `/dashboard/billing?plan=${encodeURIComponent(planSlug)}`
    : "/dashboard/billing";

  return (
    <div className="cordon-card animate-slide-up border border-stroke/30 bg-surface p-8 shadow-elevated">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-subtle text-danger">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          {detail.title}
        </h1>
        <p className="max-w-sm text-sm text-fg-subtle">{detail.body}</p>
      </div>

      <div className="mt-6 rounded-xl border border-stroke/30 bg-surface-raised/50 p-4 text-xs text-fg-muted">
        <p className="font-medium text-fg-muted">Common fixes</p>
        <ul className="mt-2 space-y-1.5 list-disc pl-4">
          <li>Make sure the card is enabled for international / online payments.</li>
          <li>Try a different card or use bKash / Nagad receipt upload on the Billing page.</li>
          <li>If the card was just charged, wait 30–60 seconds before retrying — duplicate attempts can trigger bank flags.</li>
        </ul>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        <Button asChild className="h-11 w-full bg-brand font-semibold text-brand-fg hover:bg-brand-hover">
          <Link href={retryHref} className="inline-flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Retry payment
          </Link>
        </Button>
        <Button
          asChild
          variant="outline"
          className="h-10 w-full border-stroke/30 bg-transparent text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <a
            href={`mailto:${SAAS_BRANDING.supportEmail}?subject=Payment%20issue`}
            className="inline-flex items-center gap-2"
          >
            <MessageCircle className="h-4 w-4" /> Email support
          </a>
        </Button>
      </div>

      <div className="mt-6 flex justify-center text-xs">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-fg-faint hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Continue without upgrading
        </Link>
      </div>
    </div>
  );
}

export default function PaymentFailedPage() {
  return (
    <Suspense fallback={null}>
      <PaymentFailedInner />
    </Suspense>
  );
}
