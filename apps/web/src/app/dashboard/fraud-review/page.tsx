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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";

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
  low: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
  medium: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
  high: "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
};

const STATUS_CLASS: Record<QueueItem["reviewStatus"], string> = {
  not_required: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
  pending_call: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
  no_answer: "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
  verified: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
  rejected: "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
};

function formatBDT(n: number): string {
  return `৳ ${n.toLocaleString()}`;
}

function formatRelative(date: Date | string | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

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
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-[#F3F4F6]">
          Fraud review queue
        </h1>
        <p className="mt-1 text-sm text-[#9CA3AF]">
          Call risky customers to verify COD orders before booking shipment.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="In queue" value={total.toLocaleString()} icon={ShieldAlert} accent="#EF4444" />
        <StatCard
          label="Verified today"
          value={today.verified.toLocaleString()}
          icon={ShieldCheck}
          accent="#10B981"
        />
        <StatCard
          label="Rejected today"
          value={today.rejected.toLocaleString()}
          icon={XCircle}
          accent="#F59E0B"
        />
        <StatCard
          label="COD saved today"
          value={formatBDT(today.codSaved)}
          icon={CheckCircle2}
          accent="#8B5CF6"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6] lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base font-semibold">Queue</CardTitle>
              <CardDescription className="text-[#9CA3AF]">
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
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                <ShieldCheck className="h-6 w-6 text-[#34D399]" />
                <p className="text-sm font-medium text-[#F3F4F6]">Queue is clear</p>
                <p className="text-xs text-[#9CA3AF]">No orders are waiting on review.</p>
              </div>
            ) : (
              <ul className="max-h-[600px] divide-y divide-[rgba(209,213,219,0.06)] overflow-auto">
                {items.map((it) => {
                  const active = it.id === selectedId;
                  return (
                    <li key={it.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(it.id)}
                        className={`flex w-full flex-col gap-1 border-l-2 px-4 py-3 text-left transition-colors ${
                          active
                            ? "border-[#0084D4] bg-[rgba(0,132,212,0.08)]"
                            : "border-transparent hover:bg-[rgba(26,29,46,0.6)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-[#F3F4F6]">
                            {it.customer.name}
                          </span>
                          <Badge
                            variant="outline"
                            className={`border-transparent ${LEVEL_CLASS[it.level]}`}
                          >
                            {it.riskScore}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-[#9CA3AF]">
                          <span className="font-mono">{it.customer.phone}</span>
                          <span className="text-[#4B5563]">·</span>
                          <span>{formatBDT(it.cod)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs text-[#9CA3AF]">
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

        <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6] lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              {detail.data ? `Order ${detail.data.orderNumber}` : "Select an order"}
            </CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              {detail.data
                ? `Scored ${formatRelative(detail.data.fraud.scoredAt ?? null)}`
                : "Pick an order from the queue to review its risk signals."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!selectedId ? (
              <div className="flex items-center justify-center py-12 text-sm text-[#9CA3AF]">
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

                <div className="rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#111318] p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-[0.4px] text-[#9CA3AF]">
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
                          className="flex items-start gap-2 text-xs text-[#D1D5DB]"
                        >
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#FBBF24]" />
                          <div className="flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">{sig.key.replace(/_/g, " ")}</span>
                              <span className="text-[#6B7280]">+{sig.weight}</span>
                            </div>
                            {sig.detail ? (
                              <p className="text-[#9CA3AF]">{sig.detail}</p>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-xs text-[#9CA3AF]">No signals recorded.</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="review-notes"
                    className="text-xs uppercase tracking-[0.4px] text-[#9CA3AF]"
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
                    className="w-full resize-none rounded-md border border-[rgba(209,213,219,0.15)] bg-[#111318] px-3 py-2 text-sm text-[#F3F4F6] placeholder:text-[#6B7280] focus:border-[#0084D4] focus:outline-none"
                  />
                </div>

                <div className="flex flex-col gap-2 border-t border-[rgba(209,213,219,0.08)] pt-4 sm:flex-row">
                  <Button
                    className="flex-1 bg-[#0084D4] text-white hover:bg-[#0072BB] disabled:opacity-60"
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
                    className="flex-1 bg-[#10B981] text-white hover:bg-[#059669] disabled:opacity-60"
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
                    className="flex-1 border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.08)] text-[#FBBF24] hover:bg-[rgba(245,158,11,0.15)] disabled:opacity-60"
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
                    className="flex-1 border-[rgba(239,68,68,0.4)] bg-[rgba(239,68,68,0.08)] text-[#FCA5A5] hover:bg-[rgba(239,68,68,0.15)] disabled:opacity-60"
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

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  icon: typeof ShieldAlert;
  accent: string;
}) {
  return (
    <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-[0.4px] text-[#9CA3AF]">
          {label}
        </CardTitle>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${accent}22` }}
        >
          <Icon className="h-4 w-4" style={{ color: accent }} />
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold text-[#F3F4F6]">{value}</p>
      </CardContent>
    </Card>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[rgba(209,213,219,0.06)] pb-2 last:border-b-0">
      <span className="text-xs uppercase tracking-[0.4px] text-[#9CA3AF]">{label}</span>
      <span className={`text-right text-sm text-[#F3F4F6] ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}
