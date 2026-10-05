"use client";

import { History } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatRelative } from "@/lib/formatters";
import { actorLabel, historyEntry, reasonLabel, type HistoryTone } from "@/lib/verification/reasons";

const DOT: Record<HistoryTone, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  neutral: "bg-fg-faint",
};

/**
 * One order's verification history (oldest first): scoring, decisions with
 * their reasons and notes, confirmation events, cancel/restore. Read-only.
 */
export function VerificationHistory({ orderId }: { orderId: string }) {
  const history = trpc.fraud.getVerificationHistory.useQuery({ id: orderId }, { retry: false });
  const rows = history.data ?? [];
  return (
    <details className="rounded-lg border border-stroke/8 bg-surface-base/40 p-3" open={rows.length > 0 && rows.length <= 6}>
      <summary className="flex cursor-pointer items-center gap-2 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
        <History className="h-3.5 w-3.5" aria-hidden />
        Verification history{history.isSuccess ? ` (${rows.length})` : ""}
      </summary>
      {history.isLoading ? (
        <p className="mt-2 text-xs text-fg-subtle">Loading…</p>
      ) : history.isError ? (
        <p className="mt-2 text-xs text-danger">Couldn&apos;t load the history.</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-xs text-fg-subtle">No verification events yet.</p>
      ) : (
        <ol className="mt-3 space-y-2.5" aria-label="Verification history">
          {rows.map((r) => {
            const e = historyEntry(r.action);
            const reason = reasonLabel(r.reasonCode);
            return (
              <li key={r.id} className="flex gap-2.5 text-xs">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[e.tone]}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-fg">{e.label}</span>
                    <span className="text-fg-faint">
                      {actorLabel(r.actor)} · {formatRelative(r.at)}
                    </span>
                  </div>
                  {reason ? <div className="text-fg-muted">Reason: {reason}</div> : null}
                  {r.riskScore !== null && r.action === "risk.recomputed" ? (
                    <div className="text-fg-muted">
                      Score {r.riskScore}
                      {r.level ? ` · ${r.level}` : ""}
                    </div>
                  ) : null}
                  {r.notes ? <div className="break-words text-fg-muted">“{r.notes}”</div> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}
