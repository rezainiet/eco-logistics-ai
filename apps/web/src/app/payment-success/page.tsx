"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Receipt, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Plan label resolver. We accept the plan slug both as the lower-case key
 * and the human display name, falling back to a generic line if Stripe /
 * bKash hands us something we don't recognise. Keep this list in sync
 * with @ecom/types PLANS.
 */
const PLAN_LABEL: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
  enterprise: "Enterprise",
};

function PaymentSuccessInner() {
  const params = useSearchParams();
  const planSlug = (params.get("plan") ?? "").toLowerCase();
  const planLabel = PLAN_LABEL[planSlug] ?? null;
  const amount = params.get("amount"); // e.g. "4990"
  const currency = params.get("currency") ?? "BDT";
  const sessionId = params.get("session_id");
  const nextBilling = params.get("next_billing"); // ISO date

  const formattedAmount = amount
    ? currency === "BDT"
      ? `৳ ${Number(amount).toLocaleString()}`
      : `${currency} ${Number(amount).toLocaleString()}`
    : null;

  return (
    <div className="cordon-card animate-slide-up border border-stroke/30 bg-surface p-8 shadow-elevated">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand/15 text-brand">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Payment received.{" "}
          <span className="cordon-serif">You&apos;re live.</span>
        </h1>
        <p className="max-w-sm text-sm text-fg-subtle">
          {planLabel ? (
            <>
              Your <strong className="text-fg">{planLabel}</strong> plan is
              active. The pipeline is already scoring incoming orders.
            </>
          ) : (
            <>
              Your subscription is active. The pipeline is already scoring
              incoming orders.
            </>
          )}
        </p>
      </div>

      {/* Receipt summary — only renders the rows we have data for so a bare
          /payment-success URL doesn't show a half-empty card. */}
      {(planLabel || formattedAmount || nextBilling || sessionId) ? (
        <dl className="mt-6 divide-y divide-stroke/30 rounded-xl border border-stroke/30 bg-surface-raised/50 text-sm">
          {planLabel ? (
            <Row label="Plan" value={planLabel} />
          ) : null}
          {formattedAmount ? (
            <Row label="Amount" value={formattedAmount} />
          ) : null}
          {nextBilling ? (
            <Row
              label="Next billing"
              value={new Date(nextBilling).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            />
          ) : null}
          {sessionId ? (
            <Row label="Reference" value={<code className="font-mono text-xs">{sessionId.slice(0, 18)}…</code>} />
          ) : null}
        </dl>
      ) : null}

      <div className="mt-6 flex flex-col gap-3">
        <Button asChild className="h-11 w-full bg-brand font-semibold text-brand-fg hover:bg-brand-hover">
          <Link href="/dashboard">
            Take me to the dashboard <span className="cordon-arrow">→</span>
          </Link>
        </Button>
        <Button
          asChild
          variant="outline"
          className="h-10 w-full border-stroke/30 bg-transparent text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <Link href="/dashboard/billing" className="inline-flex items-center gap-2">
            <Receipt className="h-4 w-4" /> View receipt &amp; invoices
          </Link>
        </Button>
      </div>

      <div className="mt-6 flex items-start gap-2 rounded-md border border-brand/20 bg-brand/5 px-3 py-2 text-xs text-fg-muted">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
        <span>
          A receipt is on its way to your inbox. If your accountant needs a
          formatted invoice, the Billing page exports VAT-ready PDF.
        </span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="font-medium text-fg">{value}</dd>
    </div>
  );
}

export default function PaymentSuccessPage() {
  return (
    <Suspense fallback={null}>
      <PaymentSuccessInner />
    </Suspense>
  );
}
