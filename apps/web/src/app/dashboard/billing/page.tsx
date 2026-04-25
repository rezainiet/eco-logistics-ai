"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  CreditCard,
  Crown,
  Download,
  FileImage,
  Loader2,
  Paperclip,
  Receipt,
  Sparkles,
  Upload,
  Zap,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";

const PLAN_ICON = {
  starter: Sparkles,
  growth: Zap,
  scale: CreditCard,
  enterprise: Crown,
} as const;

const METRIC_LABEL: Record<string, string> = {
  ordersCreated: "Orders created",
  shipmentsBooked: "Shipments booked",
  fraudReviewsUsed: "Fraud reviews",
  callsInitiated: "Calls initiated",
  callMinutesUsed: "Call minutes used",
};

const METHOD_HELP: Record<string, { label: string; hint: string }> = {
  bkash: { label: "bKash", hint: "Send to 01XXXXXXXXX (Personal). Use the provided reference." },
  nagad: { label: "Nagad", hint: "Send to 01XXXXXXXXX (Personal)." },
  bank_transfer: { label: "Bank transfer", hint: "DBBL — A/C 1234567890 — Logistics Ltd." },
  card: { label: "Card", hint: "Manual card receipt (Stripe coming soon)." },
  other: { label: "Other", hint: "Add details in the notes field." },
};

function formatBDT(n: number): string {
  return `৳ ${n.toLocaleString()}`;
}

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function BillingPage() {
  const params = useSearchParams();
  const plan = trpc.billing.getPlan.useQuery();
  const plans = trpc.billing.listPlans.useQuery();
  const usage = trpc.billing.getUsage.useQuery();
  const payments = trpc.billing.listPayments.useQuery({ limit: 25 });
  const utils = trpc.useUtils();

  // Surface Stripe redirect outcome the moment the merchant lands back here.
  // The webhook may not have fired yet — we still poll listPayments so the
  // status flips to `approved` within a couple seconds of activation.
  useEffect(() => {
    const stripeFlag = params.get("stripe");
    if (!stripeFlag) return;
    if (stripeFlag === "success") {
      toast.success(
        "Payment received",
        "We're activating your plan now. The new tier appears in a moment.",
      );
    } else if (stripeFlag === "cancel") {
      toast.error("Checkout cancelled", "No charge was made.");
    }
    void utils.billing.getPlan.invalidate();
    void utils.billing.listPayments.invalidate();
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("stripe");
      url.searchParams.delete("payment");
      window.history.replaceState({}, "", url.toString());
    }
  }, [params, utils]);

  const submitPayment = trpc.billing.submitPayment.useMutation({
    onSuccess: async (created) => {
      toast.success("Payment submitted", "We'll email you once it's approved.");
      await utils.billing.getPlan.invalidate();
      await utils.billing.listPayments.invalidate();
      const file = pendingProofRef.current;
      if (file) {
        try {
          await uploadProof.mutateAsync({
            paymentId: created.id,
            ...(await readFileAsBase64(file)),
          });
          await utils.billing.listPayments.invalidate();
        } catch (err) {
          toast.error("Receipt saved, but proof upload failed", (err as Error).message);
        } finally {
          pendingProofRef.current = null;
        }
      }
      setForm({ plan: "growth", method: "bkash", amount: "", txnId: "", senderPhone: "", proofUrl: "", notes: "" });
      setProofPreview(null);
    },
    onError: (err) => toast.error("Could not submit", err.message),
  });

  const uploadProof = trpc.billing.uploadPaymentProof.useMutation();

  const stripeCheckout = trpc.billing.createCheckoutSession.useMutation({
    onSuccess: (data) => {
      if (data.mocked) {
        toast.success(
          "Stripe is in mock mode",
          "STRIPE_SECRET_KEY isn't set — opening the success page directly.",
        );
      }
      // Same-tab redirect so the merchant never sees a flash of the old page.
      window.location.href = data.url;
    },
    onError: (err) => toast.error("Couldn't start checkout", err.message),
  });

  const subscribe = trpc.billing.createSubscriptionCheckout.useMutation({
    onSuccess: (data) => {
      if (data.mocked) {
        toast.success(
          "Stripe is in mock mode",
          "STRIPE_SECRET_KEY isn't set — opening the success page directly.",
        );
      }
      window.location.href = data.url;
    },
    onError: (err) => toast.error("Couldn't start subscription", err.message),
  });

  const openPortal = trpc.billing.createPortalSession.useMutation({
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err) => toast.error("Couldn't open billing portal", err.message),
  });

  const cancel = trpc.billing.cancel.useMutation({
    onSuccess: () => {
      toast.success("Subscription cancelled", "Access continues until the period ends.");
      utils.billing.getPlan.invalidate();
    },
  });

  const [form, setForm] = useState({
    plan: "growth" as "starter" | "growth" | "scale" | "enterprise",
    method: "bkash" as "bkash" | "nagad" | "bank_transfer" | "card" | "other",
    amount: "",
    txnId: "",
    senderPhone: "",
    proofUrl: "",
    notes: "",
  });
  const pendingProofRef = useRef<File | null>(null);
  const [proofPreview, setProofPreview] = useState<{
    name: string;
    size: number;
    type: string;
  } | null>(null);
  const [viewingProofId, setViewingProofId] = useState<string | null>(null);

  const currentPlan = plan.data?.plan;
  const subscription = plan.data?.subscription;
  const selectedCataloguePlan = useMemo(
    () => plans.data?.find((p) => p.tier === form.plan),
    [plans.data, form.plan],
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Invalid amount");
      return;
    }
    submitPayment.mutate({
      plan: form.plan,
      method: form.method,
      amount,
      txnId: form.txnId || undefined,
      senderPhone: form.senderPhone || undefined,
      proofUrl: form.proofUrl || undefined,
      notes: form.notes || undefined,
    });
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-fg">Billing &amp; subscription</h1>
        <p className="text-sm text-fg-subtle">
          Manage your plan, track monthly usage, and submit payments.
        </p>
      </header>

      {/* Banners */}
      {subscription?.trialExpired ? (
        <div className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger/8 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
          <div className="text-sm">
            <div className="font-medium text-danger">Your trial has ended</div>
            <p className="text-fg-subtle">
              Upgrade to continue creating orders, booking shipments, and running fraud reviews.
            </p>
          </div>
        </div>
      ) : subscription?.status === "trial" && (subscription.trialDaysLeft ?? 0) <= 3 ? (
        <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/8 p-4">
          <Clock className="mt-0.5 h-5 w-5 text-warning" />
          <div className="text-sm">
            <div className="font-medium text-warning">
              Trial ends in {subscription.trialDaysLeft} day{subscription.trialDaysLeft === 1 ? "" : "s"}
            </div>
            <p className="text-fg-subtle">
              Submit a payment below to keep your account active.
            </p>
          </div>
        </div>
      ) : subscription?.status === "past_due" ? (
        <div className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger/8 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
          <div className="text-sm">
            <div className="font-medium text-danger">
              Payment failed — {subscription.graceDaysLeft != null
                ? subscription.graceDaysLeft <= 0
                  ? "grace period expired, suspension imminent"
                  : `${subscription.graceDaysLeft} day${subscription.graceDaysLeft === 1 ? "" : "s"} of grace remaining`
                : "subscription is past due"}
            </div>
            <p className="text-fg-subtle">
              Update your card via the customer portal to recover automatically.{" "}
              {plan.data?.stripe?.hasCustomer ? (
                <button
                  type="button"
                  onClick={() => openPortal.mutate()}
                  className="font-medium underline underline-offset-2 hover:text-fg"
                  disabled={openPortal.isPending}
                >
                  {openPortal.isPending ? "Opening…" : "Open portal →"}
                </button>
              ) : null}
            </p>
          </div>
        </div>
      ) : subscription?.status === "suspended" ? (
        <div className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger/8 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
          <div className="text-sm">
            <div className="font-medium text-danger">Account suspended</div>
            <p className="text-fg-subtle">
              We couldn't recover payment within the grace window. Update your card to reactivate
              instantly.
            </p>
          </div>
        </div>
      ) : null}

      {/* Current plan + usage */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-1">
          <CardHeader>
            <CardDescription className="uppercase tracking-[0.4px] text-fg-faint text-[11px]">
              Current plan
            </CardDescription>
            <CardTitle className="text-xl text-fg">
              {currentPlan?.name ?? "Loading..."}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-fg-subtle">Status</span>
              <Badge
                className={
                  subscription?.status === "active"
                    ? "bg-success-subtle text-success"
                    : subscription?.status === "trial"
                      ? "bg-warning-subtle text-warning"
                      : "bg-danger-subtle text-danger"
                }
              >
                {subscription?.status ?? "—"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-fg-subtle">Price</span>
              <span className="text-fg">{currentPlan ? formatBDT(currentPlan.priceBDT) : "—"} / mo</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-fg-subtle">Trial ends</span>
              <span className="text-fg">{formatDate(subscription?.trialEndsAt ?? null)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-fg-subtle">Next renewal</span>
              <span className="text-fg">{formatDate(subscription?.currentPeriodEnd ?? null)}</span>
            </div>
            {subscription?.pendingPaymentId ? (
              <div className="rounded-md border border-info/30 bg-info/8 p-2 text-xs text-info">
                Payment under review — we'll activate once approved.
              </div>
            ) : null}
            {plan.data?.stripe?.hasCustomer ? (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => openPortal.mutate()}
                disabled={openPortal.isPending}
              >
                {openPortal.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CreditCard className="mr-2 h-4 w-4" />
                )}
                Manage billing
              </Button>
            ) : null}
            {subscription?.status === "active" &&
            subscription.billingProvider === "manual" ? (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  if (confirm("Cancel subscription? Access continues until the period ends.")) {
                    cancel.mutate();
                  }
                }}
                disabled={cancel.isPending}
              >
                Cancel subscription
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base text-fg">Usage this month</CardTitle>
            <CardDescription className="text-fg-subtle">
              Period {usage.data?.period ?? "—"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {usage.data?.meters.map((m) => {
              const label = METRIC_LABEL[m.metric] ?? m.metric;
              const limitLabel = m.limit === null ? "unlimited" : m.limit.toLocaleString();
              return (
                <div key={m.metric}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-fg-muted">{label}</span>
                    <span
                      className={
                        m.blocked
                          ? "text-danger"
                          : m.warning
                            ? "text-warning"
                            : "text-fg-subtle"
                      }
                    >
                      {m.used.toLocaleString()} / {limitLabel}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
                    <div
                      className={
                        m.blocked
                          ? "h-full bg-danger"
                          : m.warning
                            ? "h-full bg-warning"
                            : "h-full bg-brand"
                      }
                      style={{ width: `${Math.round(m.ratio * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {!usage.data?.meters.length && (
              <div className="text-xs text-fg-faint">Loading usage…</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Upgrade cards */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.4px] text-fg-subtle">
          Plans
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {plans.data?.map((p) => {
            const Icon = PLAN_ICON[p.tier] ?? Sparkles;
            const isCurrent = subscription?.tier === p.tier;
            return (
              <Card
                key={p.tier}
                className={
                  isCurrent
                    ? "border-brand shadow-[0_0_12px_rgba(0,132,212,0.15)]"
                    : ""
                }
              >
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-brand" />
                    <CardTitle className="text-base">{p.name}</CardTitle>
                  </div>
                  <CardDescription className="text-fg-subtle">{p.tagline}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="text-2xl font-semibold text-fg">
                    {formatBDT(p.priceBDT)}
                    <span className="ml-1 text-xs text-fg-subtle">/ month</span>
                  </div>
                  <ul className="space-y-1 text-xs text-fg-muted">
                    {p.highlights.map((h) => (
                      <li key={h} className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="space-y-2">
                    <Button
                      className="w-full"
                      onClick={() => subscribe.mutate({ plan: p.tier })}
                      disabled={isCurrent || subscribe.isPending}
                    >
                      {subscribe.isPending && subscribe.variables?.plan === p.tier ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <CreditCard className="mr-2 h-4 w-4" />
                      )}
                      {isCurrent ? "Current plan" : "Subscribe monthly"}
                    </Button>
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={() => stripeCheckout.mutate({ plan: p.tier })}
                      disabled={isCurrent || stripeCheckout.isPending}
                    >
                      {stripeCheckout.isPending && stripeCheckout.variables?.plan === p.tier ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      {isCurrent ? "—" : "Pay one-shot"}
                    </Button>
                    <Button
                      className="w-full"
                      variant="ghost"
                      onClick={() => setForm((f) => ({ ...f, plan: p.tier, amount: String(p.priceBDT) }))}
                      disabled={isCurrent}
                    >
                      {isCurrent ? "—" : "Pay manually (bKash/Nagad)"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Payment form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Submit payment</CardTitle>
          <CardDescription className="text-fg-subtle">
            Bangladesh-ready manual payments. Pay via bKash / Nagad / Bank, then submit the transaction id.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Plan</Label>
              <Select
                value={form.plan}
                onValueChange={(v) => setForm((f) => ({ ...f, plan: v as typeof f.plan }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plans.data?.map((p) => (
                    <SelectItem key={p.tier} value={p.tier}>
                      {p.name} — {formatBDT(p.priceBDT)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Payment method</Label>
              <Select
                value={form.method}
                onValueChange={(v) => setForm((f) => ({ ...f, method: v as typeof f.method }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(METHOD_HELP).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-fg-faint">{METHOD_HELP[form.method]?.hint}</p>
            </div>
            <div className="space-y-1.5">
              <Label>Amount (BDT)</Label>
              <Input
                type="number"
                min={1}
                value={form.amount}
                placeholder={selectedCataloguePlan ? String(selectedCataloguePlan.priceBDT) : ""}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-txn-id">Transaction ID</Label>
              <Input
                id="payment-txn-id"
                value={form.txnId}
                onChange={(e) => setForm((f) => ({ ...f, txnId: e.target.value }))}
                placeholder="e.g. 9A3C8F21"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Sender phone</Label>
              <Input
                value={form.senderPhone}
                onChange={(e) => setForm((f) => ({ ...f, senderPhone: e.target.value }))}
                placeholder="+8801XXXXXXXXX"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Proof URL (optional)</Label>
              <Input
                value={form.proofUrl}
                onChange={(e) => setForm((f) => ({ ...f, proofUrl: e.target.value }))}
                placeholder="https://…/screenshot.png"
              />
              <p className="text-2xs text-fg-faint">
                Or upload a screenshot below — uploads override the URL.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Upload screenshot (optional)</Label>
              <ProofUploader
                preview={proofPreview}
                onPick={(file) => {
                  if (!file) {
                    pendingProofRef.current = null;
                    setProofPreview(null);
                    return;
                  }
                  if (file.size > 2_000_000) {
                    toast.error("File too large", "Keep proof under 2MB.");
                    return;
                  }
                  pendingProofRef.current = file;
                  setProofPreview({ name: file.name, size: file.size, type: file.type });
                }}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>Notes (optional)</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Anything we should know"
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={submitPayment.isPending}>
                {submitPayment.isPending ? "Submitting…" : "Submit payment"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Invoice history */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-fg-subtle" />
            <CardTitle className="text-base">Payment history</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Proof</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.data?.length ? (
                payments.data.map((p) => {
                  const provider = p.provider ?? "manual";
                  const reference =
                    provider === "stripe"
                      ? "Stripe"
                      : p.txnId ?? "—";
                  const periodLabel =
                    p.periodStart && p.periodEnd
                      ? `${formatDate(p.periodStart)} → ${formatDate(p.periodEnd)}`
                      : "—";
                  const hasProof = !!p.proofFile || !!p.proofUrl;
                  return (
                    <TableRow key={p.id}>
                      <TableCell>{formatDate(p.createdAt)}</TableCell>
                      <TableCell className="capitalize">{p.plan}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 capitalize">
                          {provider === "stripe" ? (
                            <Badge className="border-transparent bg-info-subtle text-info">
                              <CreditCard className="mr-1 h-3 w-3" /> Card
                            </Badge>
                          ) : (
                            <span>{p.method.replace("_", " ")}</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {p.currency === "USD"
                          ? `$${p.amount.toLocaleString()}`
                          : formatBDT(p.amount)}
                      </TableCell>
                      <TableCell className="font-mono text-2xs">{reference}</TableCell>
                      <TableCell className="text-xs text-fg-subtle">{periodLabel}</TableCell>
                      <TableCell>
                        {hasProof ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-2xs"
                            onClick={() => setViewingProofId(p.id)}
                          >
                            <FileImage className="mr-1 h-3 w-3" /> View
                          </Button>
                        ) : (
                          <span className="text-2xs text-fg-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            p.status === "approved"
                              ? "bg-success-subtle text-success"
                              : p.status === "rejected"
                                ? "bg-danger-subtle text-danger"
                                : "bg-warning-subtle text-warning"
                          }
                        >
                          {p.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-xs text-fg-faint">
                    No payments yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ProofViewerDialog
        paymentId={viewingProofId}
        onClose={() => setViewingProofId(null)}
      />
    </div>
  );
}

function ProofUploader({
  preview,
  onPick,
}: {
  preview: { name: string; size: number; type: string } | null;
  onPick: (file: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,application/pdf"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="mr-1.5 h-3.5 w-3.5" />
        {preview ? "Replace file" : "Choose file"}
      </Button>
      {preview ? (
        <div className="flex items-center gap-2 text-2xs text-fg-subtle">
          <Paperclip className="h-3 w-3" />
          <span className="font-medium text-fg">{preview.name}</span>
          <span>{Math.round(preview.size / 1024)} KB</span>
          <button
            type="button"
            onClick={() => onPick(null)}
            className="text-danger underline-offset-4 hover:underline"
          >
            Remove
          </button>
        </div>
      ) : (
        <span className="text-2xs text-fg-faint">PNG, JPG, WebP or PDF · up to 2MB</span>
      )}
    </div>
  );
}

function ProofViewerDialog({
  paymentId,
  onClose,
}: {
  paymentId: string | null;
  onClose: () => void;
}) {
  const open = paymentId !== null;
  const proof = trpc.billing.getPaymentProof.useQuery(
    { paymentId: paymentId ?? "" },
    { enabled: open, retry: false },
  );
  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Proof of payment</DialogTitle>
        </DialogHeader>
        {proof.isLoading ? (
          <div className="flex items-center justify-center py-10 text-fg-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : proof.error ? (
          <p className="py-6 text-center text-sm text-fg-faint">
            {proof.error.message ?? "No proof on file."}
          </p>
        ) : proof.data ? (
          <ProofViewerBody data={proof.data} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ProofViewerBody({
  data,
}: {
  data: {
    kind: "inline" | "url";
    contentType: string | null;
    filename: string | null;
    sizeBytes: number | null;
    dataUrl: string | null;
    uploadedAt: Date | string | null;
  };
}) {
  if (!data.dataUrl) {
    return <p className="py-6 text-center text-sm text-fg-faint">No proof on file.</p>;
  }
  const isPdf = data.contentType === "application/pdf";
  const isImage = data.contentType?.startsWith("image/") ?? data.kind === "url";
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="font-medium text-fg">
            {data.filename ?? (data.kind === "url" ? "External URL" : "Uploaded receipt")}
          </p>
          <p className="text-fg-faint">
            {data.contentType ?? "—"}
            {data.sizeBytes ? ` · ${Math.round(data.sizeBytes / 1024)} KB` : ""}
            {data.uploadedAt ? ` · ${new Date(data.uploadedAt).toLocaleString()}` : ""}
          </p>
        </div>
        <a
          href={data.dataUrl}
          target="_blank"
          rel="noreferrer"
          download={data.filename ?? undefined}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-stroke/14 px-2.5 text-2xs text-fg hover:bg-surface-raised"
        >
          <Download className="h-3 w-3" />
          {data.kind === "url" ? "Open" : "Download"}
        </a>
      </div>
      {isPdf ? (
        <iframe
          src={data.dataUrl}
          className="h-[480px] w-full rounded-md border border-stroke/12"
          title="Payment proof"
        />
      ) : isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.dataUrl}
          alt="Payment proof"
          className="max-h-[480px] w-full rounded-md border border-stroke/12 object-contain"
        />
      ) : (
        <p className="text-fg-subtle">
          Preview not available — use the download button to inspect.
        </p>
      )}
    </div>
  );
}

/**
 * Read a file as base64 (no data: prefix). Strips header so the API gets a
 * plain payload it can decode without parsing the data-URL form.
 */
async function readFileAsBase64(
  file: File,
): Promise<{ contentType: string; filename: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("unexpected reader result"));
      const idx = result.indexOf(",");
      const data = idx >= 0 ? result.slice(idx + 1) : result;
      resolve({
        contentType: file.type || "application/octet-stream",
        filename: file.name,
        data,
      });
    };
    reader.readAsDataURL(file);
  });
}
