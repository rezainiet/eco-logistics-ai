"use client";

import { CheckCircle2, Loader2, Undo2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { humanizeError } from "@/lib/friendly-errors";

interface BulkAutomationBarProps {
  selectedIds: string[];
  /** Callback when an action lands successfully — caller refetches the list. */
  onActionDone?: () => void;
  /** Callback to clear the selection in the parent. */
  onClearSelection?: () => void;
}

/** Window the merchant has to click "Undo" before reject actually fires. */
const UNDO_WINDOW_MS = 6_000;

/**
 * Shown when the merchant ticks one or more orders in the orders list.
 * Triggers the bulk{Confirm,Reject}Orders mutations.
 *
 * Reject is a destructive, terminal-state action — there is no backend
 * "unreject". To give merchants a safety net, the UI delays the actual
 * mutation by UNDO_WINDOW_MS and shows a banner with an Undo button.
 * If they click Undo, the timer is cancelled and no mutation fires.
 * If the window expires, the mutation runs normally.
 */
export function BulkAutomationBar({
  selectedIds,
  onActionDone,
  onClearSelection,
}: BulkAutomationBarProps) {
  const utils = trpc.useUtils();
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
  const reject = trpc.orders.bulkRejectOrders.useMutation({
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.rejected.length) parts.push(`${r.rejected.length} rejected`);
      if (r.alreadyRejected.length) parts.push(`${r.alreadyRejected.length} already rejected`);
      if (r.tooLate.length) parts.push(`${r.tooLate.length} too late`);
      if (r.notFound.length) parts.push(`${r.notFound.length} not found`);
      toast.success(parts.join(" · ") || "No changes");
      void utils.orders.invalidate();
      onActionDone?.();
      onClearSelection?.();
    },
    onError: (err) => toast.error(humanizeError(err)),
  });

  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  /** Pending-reject state: ids + a count-down displayed in the bar. */
  const [pendingReject, setPendingReject] = useState<{
    ids: string[];
    msLeft: number;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup on unmount or when pendingReject is cleared.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  function startRejectCountdown(ids: string[]) {
    setPendingReject({ ids, msLeft: UNDO_WINDOW_MS });
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setPendingReject((prev) => {
        if (!prev) return prev;
        const next = prev.msLeft - 250;
        return { ...prev, msLeft: next < 0 ? 0 : next };
      });
    }, 250);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      timerRef.current = null;
      setPendingReject(null);
      setBusy("reject");
      try {
        await reject.mutateAsync({ ids });
      } finally {
        setBusy(null);
      }
    }, UNDO_WINDOW_MS);
  }

  function undoReject() {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    timerRef.current = null;
    tickRef.current = null;
    setPendingReject(null);
    toast.success("Reject cancelled — orders are unchanged.");
  }

  if (selectedIds.length === 0 && !pendingReject) return null;
  const tooMany = selectedIds.length > 200;

  if (pendingReject) {
    const seconds = Math.ceil(pendingReject.msLeft / 1000);
    return (
      <div className="sticky bottom-3 mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-subtle px-4 py-2 shadow-md text-warning">
        <div className="text-sm">
          <span className="font-medium">Rejecting {pendingReject.ids.length} order{pendingReject.ids.length === 1 ? "" : "s"}</span>{" "}
          <span className="opacity-90">in {seconds}s…</span>
        </div>
        <Button size="sm" variant="outline" onClick={undoReject}>
          <Undo2 className="mr-1 h-3 w-3" /> Undo
        </Button>
      </div>
    );
  }

  return (
    <div className="sticky bottom-3 mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-md border border-border bg-surface-raised px-4 py-2 shadow-md">
      <div className="text-sm">
        <span className="font-medium text-fg">{selectedIds.length}</span>{" "}
        <span className="text-fg-muted">selected</span>
        {tooMany ? (
          <span className="ml-2 text-xs text-warning">(max 200 per batch)</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onClearSelection?.()}
          disabled={busy !== null}
        >
          Clear
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || tooMany}
          onClick={() => startRejectCountdown(selectedIds.slice(0, 200))}
        >
          {busy === "reject" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <XCircle className="mr-1 h-3 w-3" />
          )}
          Reject {selectedIds.length}
        </Button>
        <Button
          size="sm"
          disabled={busy !== null || tooMany}
          onClick={async () => {
            setBusy("confirm");
            try {
              await confirm.mutateAsync({ ids: selectedIds.slice(0, 200) });
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "confirm" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <CheckCircle2 className="mr-1 h-3 w-3" />
          )}
          Confirm {selectedIds.length}
        </Button>
      </div>
    </div>
  );
}

/** Test-only export — pure helper for the row counter. */
export const __TEST = { UNDO_WINDOW_MS };
