"use client";

import { useState } from "react";
import { History, Loader2, Pencil, Plus, Receipt, Undo2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBDT } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { EntryDialog, type EditableEntry, type EntryType } from "./entry-dialog";
import type { PeriodValue } from "./period";
import { changeText } from "@/lib/accounting/pnl";

/** One entry's created / edited / voided trail (audit log). */
function EntryHistory({ id }: { id: string }) {
  const q = trpc.finance.entryHistory.useQuery({ id });
  if (q.isLoading) return <p className="text-xs text-fg-subtle">Loading history…</p>;
  if (q.isError) return <p className="text-xs text-danger">Could not load history.</p>;
  return (
    <ol className="space-y-1 text-xs text-fg-subtle">
      {(q.data ?? []).map((h, i) => (
        <li key={i}>
          <span className="tabular-nums text-fg-faint">{new Date(h.at).toLocaleString()}</span> ·{" "}
          {h.action === "created" ? "Created" : h.action === "voided" ? `Voided${h.reason ? ` — ${h.reason}` : ""}` : `Edited: ${changeText(h.changes) || "no visible change"}`}
          {h.by ? <span className="text-fg-faint"> · {h.by}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** Income or expense entries of the period, with add / edit / void. */
export function EntriesTable({ type, period }: { type: EntryType; period: PeriodValue }) {
  const utils = trpc.useUtils();
  const [showVoid, setShowVoid] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EditableEntry | null>(null);
  const [voiding, setVoiding] = useState<EditableEntry | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const list = trpc.finance.list.useQuery({ period, type, includeVoid: showVoid, limit: 200 });
  const voidEntry = trpc.finance.void.useMutation({
    onSuccess: () => {
      toast.success("Entry voided", "It no longer counts in your totals.");
      void utils.finance.invalidate();
      setVoiding(null);
    },
    onError: (e) => toast.error("Could not void", e.message),
  });

  const items = list.data?.items ?? [];
  const total = items.filter((i) => i.status === "active").reduce((s, i) => s + i.amount, 0);
  const noun = type === "income" ? "income" : "expense";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-fg-subtle">
          {items.length > 0 ? (
            <>
              Total <span className="font-semibold text-fg tabular-nums">{formatBDT(total)}</span>
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-fg-subtle">
            <input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> Show voided
          </label>
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" /> Add {noun}
          </Button>
        </div>
      </div>

      {list.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : list.isError ? (
        <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">Could not load entries: {list.error.message}</p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={`No ${noun} in this period`}
          description={
            type === "income"
              ? "Delivered orders are counted as revenue automatically. Add other income here."
              : "Add ad spend, rent, salaries and other costs to see your real profit."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stroke/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Description</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke/8">
              {items.map((e) => {
                const isVoid = e.status === "void";
                return [
                  <tr key={e.id} className={cn(isVoid && "opacity-60")}>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">{e.occurredOn}</td>
                    <td className="px-4 py-3">
                      {e.categoryLabel}
                      {isVoid ? (
                        <Badge variant="outline" className="ml-2">
                          Void
                        </Badge>
                      ) : null}
                    </td>
                    <td className="hidden max-w-xs truncate px-4 py-3 text-fg-subtle md:table-cell">
                      {e.description || "—"}
                      {e.reference ? <span className="ml-1 text-fg-faint">· {e.reference}</span> : null}
                    </td>
                    <td className={cn("whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums", isVoid && "line-through")}>{formatBDT(e.amount)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="History"
                          aria-expanded={historyId === e.id}
                          onClick={() => setHistoryId(historyId === e.id ? null : e.id)}
                        >
                          <History className="h-4 w-4" />
                        </Button>
                      {!isVoid ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Edit"
                            onClick={() => {
                              setEditing({ ...e, type: e.type as EntryType });
                              setFormOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" aria-label="Void" onClick={() => setVoiding({ ...e, type: e.type as EntryType })}>
                            <Undo2 className="h-4 w-4" />
                          </Button>
                        </>
                      ) : null}
                      </div>
                    </td>
                  </tr>,
                  historyId === e.id ? (
                    <tr key={`${e.id}-history`}>
                      <td colSpan={5} className="bg-surface-raised/40 px-4 py-3">
                        <EntryHistory id={e.id} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      <EntryDialog open={formOpen} onOpenChange={setFormOpen} type={type} entry={editing} />
      <ConfirmDialog
        open={!!voiding}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Void this entry?"
        description={voiding ? `${voiding.occurredOn} · ${formatBDT(voiding.amount)}. It stays in your history but no longer counts in totals.` : ""}
        confirmLabel="Void entry"
        destructive
        loading={voidEntry.isPending}
        onConfirm={() => voiding && voidEntry.mutate({ id: voiding.id })}
      />
    </div>
  );
}
