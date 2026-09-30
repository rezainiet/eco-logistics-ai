"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Loader2, Undo2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { BottomDockPortal } from "@/components/dashboard/bottom-dock";
import { humanizeError } from "@/lib/friendly-errors";
import {
  type PendingRejectState,
  type PendingRejectStore,
  type RejectOutcome,
  pendingReject,
} from "@/lib/orders/pending-reject";

/** Toast copy for a finished bulk reject (pure — unit tested). */
export function rejectOutcomeMessage(o: RejectOutcome): { tone: "success" | "error"; title: string; body?: string } {
  if (o.kind === "undone") return { tone: "success", title: "Reject cancelled — orders are unchanged." };
  if (o.kind === "failed") return { tone: "error", title: "Reject failed", body: humanizeError(o.error) };
  const r = o.result;
  const parts: string[] = [];
  if (r.rejected.length) parts.push(`${r.rejected.length} rejected`);
  if (r.alreadyRejected.length) parts.push(`${r.alreadyRejected.length} already rejected`);
  if (r.tooLate.length) parts.push(`${r.tooLate.length} too late`);
  if (r.notFound.length) parts.push(`${r.notFound.length} not found`);
  return { tone: "success", title: parts.join(" · ") || "No changes" };
}

/**
 * Dashboard-wide host for the bulk-reject undo window (mounted once in the
 * dashboard layout, so it stays up while the merchant moves between pages).
 * Shows the countdown + Undo while pending, "Rejecting…" without Undo once
 * the request is on the wire, toasts the outcome and refreshes order data.
 */
export function PendingRejectBanner({ store = pendingReject }: { store?: PendingRejectStore }) {
  const utils = trpc.useUtils();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [now, setNow] = useState(() => Date.now());

  // Re-render the countdown while pending.
  useEffect(() => {
    if (state.phase !== "pending") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [state.phase]);

  // Outcome → toast + fresh order data.
  useEffect(
    () =>
      store.onOutcome((o) => {
        const m = rejectOutcomeMessage(o);
        if (m.tone === "error") toast.error(m.title, m.body);
        else toast.success(m.title, m.body);
        if (o.kind !== "undone") void utils.orders.invalidate();
      }),
    [store, utils],
  );

  // Closing the tab is the one thing that can still drop a pending reject —
  // say so instead of silently losing it.
  useEffect(() => {
    if (state.phase === "idle") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.phase]);

  return (
    <BottomDockPortal>
      <PendingRejectBannerView
        state={state}
        secondsLeft={store.secondsLeft(now)}
        onUndo={() => void store.undo()}
      />
    </BottomDockPortal>
  );
}

export function PendingRejectBannerView({
  state,
  secondsLeft,
  onUndo,
}: {
  state: PendingRejectState;
  secondsLeft: number;
  onUndo: () => void;
}) {
  if (state.phase === "idle") return null;
  const n = state.ids.length;
  const orders = `${n} order${n === 1 ? "" : "s"}`;
  return (
    // Positioned by the bottom dock (above the mobile nav, centred in the
    // content column on md+); the view itself is just the card.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-warning-border bg-warning-subtle px-4 py-2 text-warning shadow-md"
    >
      {state.phase === "pending" ? (
        <>
          <p className="text-sm text-warning">
            <span className="font-medium">Rejecting {orders}</span>{" "}
            <span className="opacity-90">in {secondsLeft}s — this continues if you leave the page.</span>
          </p>
          <Button size="sm" variant="outline" onClick={onUndo}>
            <Undo2 className="mr-1 h-3 w-3" aria-hidden /> Undo
          </Button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-warning">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          <span className="font-medium">Rejecting {orders}…</span>
          <span className="opacity-90">Too late to undo.</span>
        </p>
      )}
    </div>
  );
}
