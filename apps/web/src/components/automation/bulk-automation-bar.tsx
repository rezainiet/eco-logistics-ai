"use client";

import { useSyncExternalStore, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { BottomActionBar } from "@/components/dashboard/bottom-dock";
import { humanizeError } from "@/lib/friendly-errors";
import { REJECT_BATCH_LIMIT, pendingReject } from "@/lib/orders/pending-reject";

interface BulkAutomationBarProps {
  selectedIds: string[];
  /** Callback when an action lands successfully — caller refetches the list. */
  onActionDone?: () => void;
  /** Callback to clear the selection in the parent. */
  onClearSelection?: () => void;
}

/**
 * Shown when the merchant ticks one or more orders in the orders list.
 * Confirm runs immediately; Reject hands off to the app-level undo window
 * (`pendingReject`), whose banner lives in the dashboard layout so the
 * countdown, Undo and the eventual request survive leaving this page.
 */
export function BulkAutomationBar({
  selectedIds,
  onActionDone,
  onClearSelection,
}: BulkAutomationBarProps) {
  const utils = trpc.useUtils();
  const rejectPhase = useSyncExternalStore(
    pendingReject.subscribe,
    () => pendingReject.getState().phase,
    () => "idle" as const,
  );
  const [confirming, setConfirming] = useState(false);
  const confirm = trpc.orders.bulkConfirmOrders.useMutation({
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.confirmed.length) parts.push(`${r.confirmed.length} confirmed`);
      if (r.alreadyConfirmed.length) parts.push(`${r.alreadyConfirmed.length} already done`);
      if (r.rejectedTooLate.length) parts.push(`${r.rejectedTooLate.length} too late`);
      if (r.notFound.length) parts.push(`${r.notFound.length} not found`);
      toast.success(parts.join(" · ") || "No changes");
      void utils.orders.invalidate();
      onActionDone?.();
      onClearSelection?.();
    },
    onError: (err) => toast.error(humanizeError(err)),
  });

  if (selectedIds.length === 0) return null;

  return (
    <BulkActionBarView
      count={selectedIds.length}
      confirming={confirming}
      rejectBusy={rejectPhase !== "idle"}
      onClear={() => onClearSelection?.()}
      onReject={() => {
        const started = pendingReject.request(selectedIds, (ids) =>
          utils.client.orders.bulkRejectOrders.mutate({ ids }),
        );
        // The ids are captured by the store; the selection is done with.
        if (started === "started") onClearSelection?.();
      }}
      onConfirm={async () => {
        setConfirming(true);
        try {
          await confirm.mutateAsync({ ids: selectedIds.slice(0, REJECT_BATCH_LIMIT) });
        } catch {
          // onError already toasted.
        } finally {
          setConfirming(false);
        }
      }}
    />
  );
}

export interface BulkActionBarViewProps {
  count: number;
  confirming: boolean;
  /** Another reject is still in its undo window / on the wire. */
  rejectBusy: boolean;
  onClear: () => void;
  onReject: () => void;
  onConfirm: () => void;
}

/**
 * Presentational bar: a BottomActionBar — fixed above the mobile nav, the
 * safe area and the bottom dock (the reject undo banner), with an in-flow
 * spacer so the pagination above can scroll clear. It used to be sticky, but
 * its containing block (the orders page root) starts at y=322 under the
 * incident/billing banners on a 320×568 phone, and a sticky bar can't rise
 * above that — near the top of the page it overlapped the dock. On md+ the
 * inset is 0, so it sits 0.75rem from the bottom as before. Wraps instead of
 * overflowing on 320px screens.
 */
export function BulkActionBarView({
  count,
  confirming,
  rejectBusy,
  onClear,
  onReject,
  onConfirm,
}: BulkActionBarViewProps) {
  const tooMany = count > REJECT_BATCH_LIMIT;
  const busy = confirming;
  return (
    <BottomActionBar
      role="region"
      aria-label="Bulk actions for selected orders"
      className="flex max-w-3xl flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-border bg-surface-raised px-4 py-2 shadow-md"
    >
      <div className="text-sm">
        <span className="font-medium text-fg">{count}</span>{" "}
        <span className="text-fg-muted">selected</span>
        {tooMany ? (
          <span className="ml-2 text-xs text-warning">(max {REJECT_BATCH_LIMIT} per batch)</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
          Clear
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || tooMany || rejectBusy}
          title={rejectBusy ? "Another reject is still finishing — wait for it to complete or undo it." : undefined}
          onClick={onReject}
        >
          <XCircle className="mr-1 h-3 w-3" aria-hidden />
          Reject {count}
        </Button>
        <Button size="sm" disabled={busy || tooMany} onClick={onConfirm}>
          {confirming ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden />
          )}
          Confirm {count}
        </Button>
      </div>
    </BottomActionBar>
  );
}
