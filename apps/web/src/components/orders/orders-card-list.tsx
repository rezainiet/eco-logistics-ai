"use client";

import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBDT, formatDate } from "@/lib/formatters";
import {
  REVIEW_BADGE,
  type OrderStatus as Status,
  type ReviewStatus,
  orderStatusClass,
  riskBadgeClass,
} from "@/lib/status-badges";

export type OrderCardRow = {
  id: string;
  orderNumber: string;
  status: Status;
  cod: number;
  customer: { name: string; phone: string; district: string };
  courier?: string;
  trackingNumber?: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  reviewStatus: ReviewStatus;
  createdAt: string | Date;
};

interface OrdersCardListProps {
  rows: OrderCardRow[];
  isLoading: boolean;
  selected: Set<string>;
  onToggleRow: (id: string) => void;
  onResetFilters: () => void;
}

/**
 * Mobile (< sm:) card layout for orders. Renders the same per-row data
 * the desktop table renders in `<table>` form, but as vertically-stacked
 * cards so phones don't horizontal-scroll.
 *
 * Selection state and the bookable predicate are passed in by the parent
 * so a single Set<string> stays in sync between table + cards. Actions
 * still flow through the bottom <BulkAutomationBar />.
 */
export function OrdersCardList({
  rows,
  isLoading,
  selected,
  onToggleRow,
  onResetFilters,
}: OrdersCardListProps) {
  if (isLoading) {
    return (
      <div className="space-y-2 sm:hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-28 animate-shimmer rounded-xl border border-stroke/10 bg-surface"
          />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="space-y-2 sm:hidden">
        <div className="rounded-xl border border-stroke/10 bg-surface p-4">
          <EmptyState
            icon={SearchX}
            title="No orders match your filters"
            description="Try broadening the status, phone number, or date range."
            className="border-0 bg-transparent"
            action={
              <Button
                variant="outline"
                size="sm"
                className="border-stroke/14 text-fg-muted"
                onClick={onResetFilters}
              >
                Reset filters
              </Button>
            }
          />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2 sm:hidden">
      {rows.map((r) => {
        const flagged =
          r.reviewStatus === "pending_call" || r.reviewStatus === "no_answer";
        const rejected = r.reviewStatus === "rejected";
        const cardTone = rejected
          ? "border-danger-border/40 bg-danger/5"
          : flagged
            ? "border-warning-border/40 bg-warning/5"
            : "border-stroke/10 bg-surface";
        const bookable =
          ["pending", "confirmed", "packed"].includes(r.status) &&
          !r.courier &&
          r.reviewStatus !== "pending_call" &&
          r.reviewStatus !== "no_answer" &&
          r.reviewStatus !== "rejected";
        const review =
          r.reviewStatus !== "not_required" ? REVIEW_BADGE[r.reviewStatus] : null;
        return (
          <div
            key={r.id}
            className={`rounded-xl border p-3 shadow-card ${cardTone}`}
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                aria-label={`Select order ${r.orderNumber}`}
                checked={selected.has(r.id)}
                disabled={!bookable}
                onChange={() => onToggleRow(r.id)}
                className="mt-1 h-4 w-4 cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-30"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-semibold text-fg">
                      {r.orderNumber}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-fg">
                      {r.customer.name}
                    </p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-semibold ${orderStatusClass[r.status]}`}
                  >
                    {r.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-fg-muted">
                  <span className="font-mono">{r.customer.phone}</span>
                  {r.customer.district ? <span>{r.customer.district}</span> : null}
                  <span className="font-semibold text-fg">
                    {formatBDT(r.cod)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-2xs">
                  {r.courier ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-stroke/12 px-2 py-0.5 text-fg-muted">
                      {r.courier}
                      {r.trackingNumber ? (
                        <span className="font-mono opacity-80">
                          · {r.trackingNumber}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {r.riskLevel !== "low" ? (
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${riskBadgeClass(r.riskScore)}`}
                    >
                      {r.riskLevel} risk
                    </span>
                  ) : null}
                  {review ? (
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 ${review.className}`}
                    >
                      {review.label}
                    </span>
                  ) : null}
                  <span className="ml-auto text-fg-faint">
                    {formatDate(r.createdAt)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <p className="px-1 pt-1 text-2xs text-fg-faint">
        Tap the checkbox on a card and use the action bar at the bottom of
        the screen to confirm, reject, or book the selected orders.
      </p>
    </div>
  );
}
