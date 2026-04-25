"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  PhoneCall,
  PhoneOff,
  ShieldAlert,
  ShieldCheck,
  XCircle,
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
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { formatBDT, formatRelative } from "@/lib/formatters";

type FilterValue = "all_open" | "pending_call" | "no_answer";

type QueueItem = {
  id: string;
  orderNumber: string;
  customer: { name: string; phone: string; district: string };
  cod: number;
  total: number;
  riskScore: number;
  level: "low" | "medium" | "high";
  reviewStatus: "pending_call" | "no_answer" | "verified" | "rejected" | "not_required";
  reasons: string[];
  scoredAt: Date | string | null;
  createdAt: Date | string;
};

const LEVEL_CLASS: Record<QueueItem["level"], string> = {
  low: "bg-surface-raised text-fg-muted",
  medium: "bg-warning-subtle text-warning",
  high: "bg-danger-subtle text-danger",
};

const STATUS_CLASS: Record<QueueItem["reviewStatus"], string> = {
  not_required: "bg-surface-raised text-fg-muted",
  pending_call: "bg-warning-subtle text-warning",
  no_answer: "bg-danger-subtle text-danger",
  verified: "bg-success-subtle text-success",
  rejected: "bg-danger-subtle text-danger",
};

export default function FraudReviewPage() {
  const [filter, setFilter] = useState<FilterValue>("all_open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const utils = trpc.useUtils();

  const queue = trpc.fraud.listPendingReviews.useQuery({
    filter,
    cursor: null,
    limit: 50,
  });
  const detail = trpc.fraud.getReviewOrder.useQuery(
    { id: selectedId ?? "" },
    { enabled: !!selectedId },
  );
  const stats = trpc.fraud.getReviewStats.useQuery({ days: 7 });
  const callConfigured = trpc.call.isConfigured.useQuery();

  useEffect(() => {
    if (selectedId) return;
    const first = queue.data?.items[0];
    if (first) setSelectedId(first.id);
  }, [selectedId, queue.data]);

  useEffect(() => {
    setNotes("");
  }, [selectedId]);

  async function invalidateAll() {
    await Promise.all([
      utils.fraud.listPendingReviews.invalidate(),
      utils.fraud.getReviewStats.invalidate(),
      utils.orders.listOrders.invalidate(),
      utils.analytics.getDashboard.invalidate(),
    ]);
  }

  const verify = trpc.fraud.markVerified.useMutation({
    onSuccess: async () => {
      toast.success("Order verified", "Customer confirmed identity");
      setSelectedId(null);
      await invalidateAll();
    },
    onError: (err) => toast.error("Verify failed", err.message),
  });

  const reject = trpc.fraud.markRejected.useMutation({
    onSuccess: async (data) => {
      toast.success("Order rejected", `${formatBDT(data.codSaved)} COD saved`);
      setSelectedId(null);
      await invalidateAll();
    },
    onError: (err) => toast.error("Reject failed", err.message),
  });

  const noAnswer = trpc.fraud.markNoAnswer.useMutation({
    onSuccess: async () => {
      toast.info("Marked no answer");
      setSelectedId(null);
      await invalidateAll();
    },
    onError: (err) => toast.error("Update failed", err.message),
  });

  const initiateCall = trpc.call.initiateCall.useMutation({
    onSuccess: () => toast.success("Calling customer…"),
    onError: (err) => toast.error("Call failed", err.message),
  });

  const items: QueueItem[] = (queue.data?.items ?? []) as QueueItem[];
  const total = queue.data?.total ?? 0;
  const today = stats.data?.today ?? { risky: 0, verified: 0, rejected: 0, codSaved: 0 };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Risk operations"
        title="Fraud review queue"
        description="Call risky customers to verify COD orders before booking shipment."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="In queue" value={total.toLocaleString()} icon={ShieldAlert} tone="danger" />
        <StatCard
          label="Verified today"
          value={today.verified.toLocaleString()}
          icon={ShieldCheck}
          tone="success"
        />
        <StatCard
          label="Rejected today"
          value={today.rejected.toLocaleString()}
          icon={XCircle}
          tone="warning"
        />
        <StatCard
          label="COD saved today"
          value={formatBDT(today.codSaved)}
          icon={CheckCircle2}
          tone="violet"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base font-semibold">Queue</CardTitle>
              <CardDescription>
                Sorted by risk score (highest first)
              </CardDescription>
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_open">All open</SelectItem>
                <SelectItem value="pending_call">Pending call</SelectItem>
                <SelectItem value="no_answer">No answer</SelectItem>
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent className="p-0">
            {queue.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-16 animate-shimmer rounded-md" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                tone="success"
                title="Queue is clear"
                description="No orders are waiting on review. New risky orders will appear here automatically."
                className="m-4 border-0 bg-transparent"
              />
            ) : (
              <ul className="max-h-[600px] divide-y divide-stroke/6 overflow-auto">
                {items.map((it) => {
                  const active = it.id === selectedId;
                  return (
                    <li key={it.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(it.id)}
                        className={`flex w-full flex-col gap-1 border-l-2 px-4 py-3 text-left transition-colors ${
                          active
                            ? "border-brand bg-brand-subtle"
                            : "border-transparent hover:bg-surface-raised/60"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-fg">
                            {it.customer.name}
                          </span>
                          <Badge
                            variant="outline"
                            className={`border-transparent ${LEVEL_CLASS[it.level]}`}
                          >
                            {it.riskScore}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-fg-subtle">
                          <span className="font-mono">{it.customer.phone}</span>
                          <span className="text-fg-faint">·</span>
                          <span>{formatBDT(it.cod)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs text-fg-subtle">
                          <span className="truncate">{it.orderNumber}</span>
                          <Badge
                            variant="outline"
                            className={`border-transparent text-[10px] ${STATUS_CLASS[it.reviewStatus]}`}
                          >
                            {it.reviewStatus.replace("_", " ")}
                          </Badge>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              {detail.data ? `Order ${detail.data.orderNumber}` : "Select an order"}
            </CardTitle>
            <CardDescription>
              {detail.data
                ? `Scored ${formatRelative(detail.data.fraud.scoredAt ?? null)}`
                : "Pick an order from the queue to review its risk signals."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!selectedId ? (
              <div className="flex items-center justify-center py-12 text-sm text-fg-subtle">
                No order selected.
              </div>
            ) : detail.isLoading || !detail.data ? (
              <div className="space-y-3">
                <div className="h-6 w-1/2 animate-shimmer rounded-md" />
                <div className="h-24 animate-shimmer rounded-md" />
                <div className="h-24 animate-shimmer rounded-md" />
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <InfoRow label="Customer" value={detail.data.customer.name} />
                  <InfoRow label="Phone" value={detail.data.customer.phone} mono />
                  <InfoRow label="District" value={detail.data.customer.district} />
                  <InfoRow label="COD" value={formatBDT(detail.data.cod)} />
                  <InfoRow
                    label="Order total"
                    value={formatBDT(detail.data.total)}
                  />
                  <InfoRow
                    label="Order status"
                    value={detail.data.status.replace("_", " ")}
                  />
                </div>

                <div className="rounded-lg border border-stroke/8 bg-surface-overlay p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                      Risk score
                    </span>
                    <Badge
                      variant="outline"
                      className={`border-transparent ${LEVEL_CLASS[detail.data.fraud.level]}`}
                    >
                      {detail.data.fraud.riskScore} · {detail.data.fraud.level}
                    </Badge>
                  </div>
                  {detail.data.fraud.signals.length > 0 ? (
                    <ul className="mt-3 space-y-2">
                      {detail.data.fraud.signals.map((sig) => (
                        <li
                          key={sig.key}
                          className="flex items-start gap-2 text-xs text-fg-muted"
                        >
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                          <div className="flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">{sig.key.replace(/_/g, " ")}</span>
                              <span className="text-fg-faint">+{sig.weight}</span>
                            </div>
                            {sig.detail ? (
                              <p className="text-fg-subtle">{sig.detail}</p>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-xs text-fg-subtle">No signals recorded.</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="review-notes"
                    className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle"
                  >
                    Notes (optional)
                  </label>
                  <textarea
                    id="review-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="Customer confirmed address / said wrong number / won't answer…"
                    className="w-full resize-none rounded-md border border-stroke/14 bg-surface-raised px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-brand/50 focus:outline-none focus:ring-2 focus:ring-brand/30"
                  />
                </div>

                <div className="flex flex-col gap-2 border-t border-stroke/8 pt-4 sm:flex-row">
                  <Button
                    className="flex-1 bg-brand text-white hover:bg-brand-hover disabled:opacity-60"
                    disabled={
                      !callConfigured.data?.configured || initiateCall.isPending
                    }
                    onClick={() =>
                      initiateCall.mutate({
                        customerPhone: detail.data!.customer.phone,
                        customerName: detail.data!.customer.name,
                        orderId: detail.data!.id,
                      })
                    }
                  >
                    <PhoneCall className="mr-1.5 h-4 w-4" />
                    Call customer
                  </Button>
                  <Button
                    className="flex-1 bg-success text-white hover:bg-success/90 disabled:opacity-60"
                    disabled={verify.isPending}
                    onClick={() =>
                      verify.mutate({
                        id: detail.data!.id,
                        notes: notes.trim() || undefined,
                      })
                    }
                  >
                    <ShieldCheck className="mr-1.5 h-4 w-4" />
                    {verify.isPending ? "Verifying…" : "Verify"}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 border-warning-border bg-warning-subtle text-warning hover:bg-warning/20 hover:text-warning disabled:opacity-60"
                    disabled={noAnswer.isPending}
                    onClick={() =>
                      noAnswer.mutate({
                        id: detail.data!.id,
                        notes: notes.trim() || undefined,
                      })
                    }
                  >
                    <PhoneOff className="mr-1.5 h-4 w-4" />
                    No answer
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 border-danger-border bg-danger-subtle text-danger hover:bg-danger/20 hover:text-danger disabled:opacity-60"
                    disabled={reject.isPending}
                    onClick={() =>
                      reject.mutate({
                        id: detail.data!.id,
                        notes: notes.trim() || undefined,
                      })
                    }
                  >
                    <XCircle className="mr-1.5 h-4 w-4" />
                    {reject.isPending ? "Rejecting…" : "Reject"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-stroke/6 pb-2 last:border-b-0">
      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
        {label}
      </span>
      <span className={`text-right text-sm text-fg ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}
