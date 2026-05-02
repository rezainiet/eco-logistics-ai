"use client";

import { Banknote, CheckCircle2, Clock, Smartphone, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * BD-first payment rail card. Surfaces bKash / Nagad / bank instructions
 * pulled from server env, plus the live status of any pending submission.
 *
 * Renders only when at least one rail is enabled (i.e. the corresponding
 * env entry is set on the API). Stripe stays a separate UI affordance
 * lower on the page.
 *
 * Drop into the billing page near the top — additive, safe.
 */
export function BdPaymentRails() {
  const instructions = trpc.billing.getPaymentInstructions.useQuery(undefined, {
    staleTime: 60_000,
  });
  const plan = trpc.billing.getPlan.useQuery(undefined, { staleTime: 30_000 });

  const enabledOptions = (instructions.data?.options ?? []).filter((o) => o.enabled);
  if (instructions.isLoading) return null;
  if (enabledOptions.length === 0) return null;

  const pendingId = plan.data?.subscription?.pendingPaymentId ?? null;

  return (
    <div className="space-y-3">
      {pendingId ? <PendingBanner /> : null}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Pay from Bangladesh</CardTitle>
              <CardDescription>
                Send via bKash, Nagad, or bank transfer. Submit your transaction
                ID below and we activate your plan once verified (usually under
                an hour during business hours).
              </CardDescription>
            </div>
            <Badge variant="success" className="hidden sm:inline-flex">
              Recommended
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {enabledOptions.map((opt) => (
              <RailTile key={opt.method} option={opt} />
            ))}
          </div>
          <p className="mt-4 text-xs text-fg-faint">
            Looking for card payment? Use the Stripe option further down — it
            stays available for international cards.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function RailTile({
  option,
}: {
  option: {
    method: "bkash" | "nagad" | "bank_transfer";
    label: string;
    destination?: string;
    hint?: string;
    instructions: string[];
  };
}) {
  const Icon = option.method === "bank_transfer" ? Banknote : Smartphone;
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-fg-muted" aria-hidden />
        <div className="font-medium text-fg">{option.label}</div>
      </div>
      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-fg-muted">Send to</span>
          <span className="font-mono text-right text-fg">
            {option.destination ?? "—"}
          </span>
        </div>
        {option.hint ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-fg-muted">Type</span>
            <span className="text-right text-fg">{option.hint}</span>
          </div>
        ) : null}
      </div>
      <ol className="mt-3 list-decimal space-y-1 pl-4 text-xs text-fg-muted">
        {option.instructions.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function PendingBanner() {
  return (
    <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/8 p-3">
      <Clock className="mt-0.5 h-4 w-4 text-warning" aria-hidden />
      <div className="text-sm">
        <div className="font-medium text-warning">Payment under review</div>
        <p className="mt-0.5 text-fg-muted">
          We received your submission and our team is verifying it. You will be
          notified by email when your plan is activated. This usually takes
          under an hour during business hours.
        </p>
      </div>
    </div>
  );
}

/**
 * Inline payment-status indicator — drop next to a row in the payment
 * history table. Pure presentational, takes status + optional reviewer note.
 */
export function PaymentStatusBadge({
  status,
  reviewerNote,
}: {
  status: "pending" | "approved" | "rejected" | "refunded" | string;
  reviewerNote?: string | null;
}) {
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-xs font-medium text-success">
        <CheckCircle2 className="h-3 w-3" aria-hidden /> Approved
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span
        title={reviewerNote ?? undefined}
        className="inline-flex items-center gap-1 rounded-full bg-danger-subtle px-2 py-0.5 text-xs font-medium text-danger"
      >
        <XCircle className="h-3 w-3" aria-hidden /> Rejected
      </span>
    );
  }
  if (status === "refunded") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-fg-muted">
        Refunded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning">
      <Clock className="h-3 w-3" aria-hidden /> Pending
    </span>
  );
}
