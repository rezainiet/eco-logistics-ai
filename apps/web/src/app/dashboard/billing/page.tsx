"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  CreditCard,
  Crown,
  Receipt,
  Sparkles,
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
  const plan = trpc.billing.getPlan.useQuery();
  const plans = trpc.billing.listPlans.useQuery();
  const usage = trpc.billing.getUsage.useQuery();
  const payments = trpc.billing.listPayments.useQuery({ limit: 25 });
  const utils = trpc.useUtils();

  const submitPayment = trpc.billing.submitPayment.useMutation({
    onSuccess: () => {
      toast.success("Payment submitted", "We'll email you once it's approved.");
      utils.billing.getPlan.invalidate();
      utils.billing.listPayments.invalidate();
      setForm({ plan: "growth", method: "bkash", amount: "", txnId: "", senderPhone: "", proofUrl: "", notes: "" });
    },
    onError: (err) => toast.error("Could not submit", err.message),
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
            <div className="font-medium text-danger">Subscription is past due</div>
            <p className="text-fg-subtle">Renew to restore access to billable features.</p>
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
            {subscription?.status === "active" ? (
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
                  <Button
                    className="w-full"
                    variant={isCurrent ? "outline" : "default"}
                    onClick={() => setForm((f) => ({ ...f, plan: p.tier, amount: String(p.priceBDT) }))}
                    disabled={isCurrent}
                  >
                    {isCurrent ? "Current plan" : "Choose plan"}
                  </Button>
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
              <Label>Transaction ID</Label>
              <Input
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
                <TableHead>Amount</TableHead>
                <TableHead>Txn ID</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.data?.length ? (
                payments.data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{formatDate(p.createdAt)}</TableCell>
                    <TableCell className="capitalize">{p.plan}</TableCell>
                    <TableCell className="capitalize">{p.method.replace("_", " ")}</TableCell>
                    <TableCell>{formatBDT(p.amount)}</TableCell>
                    <TableCell className="font-mono text-xs">{p.txnId ?? "—"}</TableCell>
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
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-xs text-fg-faint">
                    No payments yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
