"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  PhoneCall,
  PhoneOff,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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

import { humanizeError } from "@/lib/friendly-errors";
type FilterValue = "all_open" | "pending_call" | "no_answer";

type QueueItem = {
  id: string;
  orderNumber: string;
  customer: { name: string; phone: string; district: string };
  cod: number;
  total: number;
  riskScore: number;
  level: "low" | "medium" | "high";
  reviewStatus:
    | "pending_call"
    | "no_answer"
    | "verified"
    | "rejected"
    | "not_required"
    | "optional_review";
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
  optional_review: "bg-warning-subtle text-warning",
  pending_call: "bg-warning-subtle text-warning",
  no_answer: "bg-danger-subtle text-danger",
  verified: "bg-success-subtle text-success",
  rejected: "bg-danger-subtle text-danger",
};

/** How long the merchant has to undo a reject — matches restoreOrder's
 *  RESTORE_WINDOW_MS but trimmed for a usable banner countdown. */
const UNDO_BANNER_MS = 30_000;

interface LastRejected {
  id: string;
  orderNumber: string;
  codSaved: number;
  at: number;
}

export default function FraudReviewPage() {
  const [filter, setFilter] = useState<FilterValue>("all_open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [confirmRejectOpen, setConfirmRejectOpen] = useState(false);
  const [pendingRejectId, setPendingRejectId] = useState<string | null>(null);
  const [lastRejected, setLastRejected] = useState<LastRejected | null>(null);
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
    onError: (err) => toast.error("Verify failed", humanizeError(err)),
  });

  const reject = trpc.fraud.markRejected.useMutation({
    onSuccess: async (data, variables) => {
      const orderNumber =
        detail.data?.id === variables.id
          ? detail.data?.orderNumber ?? variables.id
          : variables.id;
      toast.success("Order rejected", `${formatBDT(data.codSaved)} COD saved`);
      setLastRejected({
        id: variables.id,
        orderNumber,
        codSaved: data.codSaved ?? 0,
        at: Date.now(),
      });
      setSelectedId(null);
      setConfirmRejectOpen(false);
      setPendingRejectId(null);
      await invalidateAll();
    },
    onError: (err) => {
      toast.error("Reject failed", humanizeError(err));
      setConfirmRejectOpen(false);
      setPendingRejectId(null);
    },
  });

  const restore = trpc.orders.restoreOrder.useMutation({
    onSuccess: async () => {
      toast.success("Order restored", "Back in your review queue.");
      setLastRejected(null);
      await invalidateAll();
    },
    onError: (err) => toast.error("Restore failed", humanizeError(err)),
  });

  // Auto-clear the undo banner once the window elapses. The server-side
  // restoreOrder window is wider (24h), but the banner is a fast-undo
  // affordance only — after this expires the merchant has to find the
  // order in cancelled-orders to restore.
  useEffect(() => {
    if (!lastRejected) return;
    const t = setTimeout(() => setLastRejected(null), UNDO_BANNER_MS);
    return () => clearTimeout(t);
  }, [lastRejected]);

  // Live "Xs left" countdown so the undo window is obvious instead of an
  // implicit "auto-dismisses in 30s" copy line. Re-renders once per second
  // — cheap, single page, no perf concern.
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  useEffect(() => {
    if (!lastRejected) {
      setUndoSecondsLeft(0);
      return;
    }
    const tick = () => {
      const elapsed = Date.now() - lastRejected.at;
      const left = Math.max(0, Math.ceil((UNDO_BANNER_MS - elapsed) / 1000));
      setUndoSecondsLeft(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastRejected]);

  const noAnswer = trpc.fraud.markNoAnswer.useMutation({
    onSuccess: async () => {
      toast.info("Marked no answer");
      setSelectedId(null);
      await invalidateAll();
    },
    onError: (err) => toast.error("Update failed", humanizeError(err)),
  });

  const initiateCall = trpc.call.initiateCall.useMutation({
    onSuccess: () => toast.success("Calling customer…"),
    onError: (err) => toast.error("Call failed", humanizeError(err)),
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

      {lastRejected ? (
        // Sticky so the affordance survives long-scroll review sessions —
        // the merchant can scroll the queue and still see "I just rejected
        // this, undo is right here". Without sticky, the banner scrolled
        // off-screen and the undo surface effectively disappeared.
        <div
          role="status"
          aria-live="polite"
          className="sticky top-2 z-10 flex items-start gap-3 rounded-lg border border-warning-border bg-warning-subtle/95 p-3 text-xs shadow-md backdrop-blur"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="font-semibold text-fg">
              Order {lastRejected.orderNumber} rejected
              {lastRejected.codSaved > 0 ? (
                <span className="ml-1 text-fg-muted">
                  · {formatBDT(lastRejected.codSaved)} COD saved
                </span>
              ) : null}
            </p>
            <p className="text-fg-muted">
              Click Undo to put it back in the queue.{" "}
              <span className="tabular-nums">{undoSecondsLeft}s</span> left.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={restore.isPending}
            onClick={() => restore.mutate({ id: lastRejected.id })}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {restore.isPending ? "Restoring…" : "Undo"}
          </Button>
        </div>
      ) : null}

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
            {queue.isError ? (
              <EmptyState
                icon={AlertTriangle}
                title="Could not load review queue"
                description="Something went wrong on our end. Try again in a moment."
                className="m-4 border-0 bg-transparent"
                action={
                  <Button variant="outline" size="sm" onClick={() => queue.refetch()}>
                    Retry
                  </Button>
                }
              />
            ) : queue.isLoading ? (
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
                        {it.reasons && it.reasons.length > 0 ? (
                          // Top reasons preview — surfaces the human-language
                          // explanation right next to the score, so the
                          // queue isn't a wall of bare numbers. Capped at 2
                          // here; the detail panel below shows the full set.
                          <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-fg-subtle">
                            {it.reasons.slice(0, 2).map((reason, idx) => (
                              <li key={idx} className="flex items-start gap-1.5">
                                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-fg-faint" />
                                <span className="line-clamp-1">{reason}</span>
                              </li>
                            ))}
                            {it.reasons.length > 2 ? (
                              <li className="pl-2.5 text-fg-faint">
                                +{it.reasons.length - 2} more reason{it.reasons.length - 2 === 1 ? "" : "s"}
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
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
                  {detail.data.fraud.confidenceLabel ? (
                    <p className="mt-1 text-xs text-fg-subtle">
                      {detail.data.fraud.confidenceLabel === "Risky"
                        ? "We'd recommend confirming on the phone before booking."
                        : detail.data.fraud.confidenceLabel === "Verify"
                          ? "A quick verification call is suggested before shipping."
                          : "This order looks clean — proceed when ready."}
                    </p>
                  ) : null}

                  {/*
                    Reasons-first display. The `reasons` array is the
                    merchant-language version of the signal computation
                    (one full English sentence per finding, e.g. "Very
                    high COD amount: ৳12,000"). Surfacing this above the
                    raw signals lets a merchant decide without learning
                    our internal taxonomy. The technical signals stay
                    available below for operators who want them.
                  */}
                  {detail.data.fraud.reasons && detail.data.fraud.reasons.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                        Why this order is flagged
                      </span>
                      <ul className="space-y-1.5">
                        {detail.data.fraud.reasons.map((reason, idx) => (
                          <li
                            key={idx}
                            className="flex items-start gap-2 text-xs text-fg-muted"
                          >
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                            <span className="flex-1 leading-snug">{reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : detail.data.fraud.signals.length === 0 ? (
                    <p className="mt-3 text-xs text-fg-subtle">No signals recorded.</p>
                  ) : null}

                  {detail.data.fraud.signals.length > 0 ? (
                    /*
                      Technical signal breakdown — the per-rule contribution
                      to the score, with weights. Hidden by default behind
                      <details> so the merchant view stays uncluttered;
                      operators reviewing scoring behaviour can expand.
                    */
                    <details className="mt-3 group rounded-md border border-stroke/8 bg-surface-base/40 p-2">
                      <summary className="cursor-pointer list-none text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle hover:text-fg-muted">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="transition-transform group-open:rotate-90" aria-hidden>›</span>
                          Technical signals ({detail.data.fraud.signals.length}) · for operators
                        </span>
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {detail.data.fraud.signals.map((sig) => (
                          <li
                            key={sig.key}
                            className="flex items-start gap-2 text-xs text-fg-muted"
                          >
                            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning/70" aria-hidden />
                            <div className="flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-[11px] text-fg-subtle">{sig.key}</span>
                                <span className="text-fg-faint">+{sig.weight}</span>
                              </div>
                              {sig.detail ? (
                                <p className="text-fg-subtle">{sig.detail}</p>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
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

                {/*
                  Action bar.
                  Mobile: sticky to the bottom of the viewport so an
                  operator scrolling through risk signals can decide
                  without scrolling back up. Two-row 2x2 grid keeps
                  every action 44px tall (above the iOS / Material
                  tap-target floor) and keeps the four primary verbs
                  visible at a glance — Call / Verify / No answer /
                  Reject — without horizontal cramming. A faint top
                  border + soft backdrop blur signals the bar is
                  floating on top of content beneath it.
                  Desktop (md+): falls back to the original single
                  row, in-flow layout. No regression on operator
                  desktop workflows.
                */}
                <div className="sticky bottom-0 z-10 -mx-6 mt-2 grid grid-cols-2 gap-2 border-t border-stroke/15 bg-surface/95 px-6 py-3 backdrop-blur-sm md:static md:mx-0 md:flex md:flex-row md:gap-2 md:border-t md:border-stroke/8 md:bg-transparent md:px-0 md:py-0 md:pt-4 md:backdrop-blur-none">
                  <Button
                    className="h-11 flex-1 bg-brand text-white hover:bg-brand-hover disabled:opacity-60 md:h-10"
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
                    className="h-11 flex-1 bg-success text-white hover:bg-success/90 disabled:opacity-60 md:h-10"
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
                    className="h-11 flex-1 border-warning-border bg-warning-subtle text-warning hover:bg-warning/20 hover:text-warning disabled:opacity-60 md:h-10"
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
                    className="h-11 flex-1 border-danger-border bg-danger-subtle text-danger hover:bg-danger/20 hover:text-danger disabled:opacity-60 md:h-10"
                    disabled={reject.isPending}
                    onClick={() => {
                      setPendingRejectId(detail.data!.id);
                      setConfirmRejectOpen(true);
                    }}
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

      <ConfirmDialog
        open={confirmRejectOpen}
        onOpenChange={(v) => {
          setConfirmRejectOpen(v);
          if (!v) setPendingRejectId(null);
        }}
        title="Reject this order?"
        description={
          <>
            The customer's order will be cancelled. You can undo within
            30 seconds from the banner, or up to 24 hours from the
            cancelled-orders list.
          </>
        }
        confirmLabel="Reject order"
        destructive
        loading={reject.isPending}
        onConfirm={() => {
          if (!pendingRejectId) return;
          reject.mutate({
            id: pendingRejectId,
            notes: notes.trim() || undefined,
          });
        }}
      />
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
