"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  PlayCircle,
  RefreshCw,
  ShieldX,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useVisibilityInterval } from "@/lib/use-visibility-interval";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import {
  buildSourceFixUrl,
  explainError,
  SmartError,
} from "@/components/integrations/smart-error";

/**
 * Centralised "things that need your attention" view. Rolls up every
 * stuck inbox row across every integration into a single workflow:
 *
 *   1. The merchant sees a count + tab per failure category.
 *   2. Each row carries the smart-error explanation inline so the
 *      "what / why / how" is always visible without clicking through.
 *   3. Three per-row actions: open the source order in their
 *      storefront admin, replay the row through ingestion, or mark it
 *      resolved (for cancelled / test orders that don't need to ingest).
 *   4. Three bulk actions: replay all stuck rows, mark all resolved
 *      (with confirmation), and export the list as CSV for offline
 *      triage.
 *
 * Page-level state intentionally kept in URL-free local state — the
 * issues feed is ephemeral and the merchant typically clears it in
 * one session, so deep-links don't add value.
 */

const REASON_LABELS: Record<string, string> = {
  missing_phone: "Customer phone missing",
  missing_external_id: "Order ID missing",
  invalid_payload: "Invalid payload shape",
  unknown: "Other / unclassified",
};

type IssueRow = {
  id: string;
  integrationId: string | null;
  provider: string;
  providerLabel: string | null;
  providerAccountKey: string | null;
  topic: string;
  externalId: string;
  status: string;
  attempts: number;
  skipReason: string | null;
  lastError: string | null;
  receivedAt: Date | string;
  processedAt: Date | string | null;
};

export default function IssuesPage() {
  const [activeReason, setActiveReason] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState<
    | null
    | { kind: "replay-all"; count: number }
    | { kind: "resolve-all"; count: number }
  >(null);

  const utils = trpc.useUtils();
  // 90s while visible, paused while hidden — see useVisibilityInterval.
  const issuesInterval = useVisibilityInterval(90_000);
  const issues = trpc.integrations.listIssues.useQuery(
    { reason: activeReason ?? undefined, limit: 200 },
    {
      // Refresh on focus + every 90s — stuck rows mostly come from
      // upstream events, so a moderate poll keeps the page honest
      // without hammering the inbox query.
      refetchInterval: issuesInterval,
      refetchOnWindowFocus: true,
    },
  );

  const replayOne = trpc.integrations.replayWebhook.useMutation();
  const bulkReplay = trpc.integrations.bulkReplayIssues.useMutation();
  const resolve = trpc.integrations.resolveIssues.useMutation();

  // Helper invalidation — every action affects both the issue list and
  // the integration cards' health snapshots, so refresh both together.
  const invalidateAfterMutation = () => {
    void utils.integrations.listIssues.invalidate();
    void utils.integrations.list.invalidate();
    void utils.integrations.getHealth.invalidate();
    void utils.integrations.recentWebhooks.invalidate();
  };

  const rows = (issues.data?.rows ?? []) as IssueRow[];
  const reasonsCount = (issues.data?.reasonsCount ?? {}) as Record<string, number>;
  const totalStuck = useMemo(
    () => Object.values(reasonsCount).reduce((s, n) => s + n, 0),
    [reasonsCount],
  );

  // Selection helpers
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.id)));
    }
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // === Per-row action handlers ===
  const handleReplay = async (row: IssueRow) => {
    try {
      const r = await replayOne.mutateAsync({ id: row.id });
      if (r.status === "succeeded") {
        toast.success("Replayed", `Order ${row.externalId} ingested.`);
      } else if (r.status === "needs_attention") {
        toast.error(
          "Still needs attention",
          "The same issue happened again — fix the order in your store first.",
        );
      } else {
        toast.info("Replay queued", `Status: ${r.status}.`);
      }
      invalidateAfterMutation();
    } catch (err) {
      toast.error("Replay failed", (err as Error).message);
    }
  };

  const handleResolve = async (ids: string[], silent = false) => {
    try {
      const r = await resolve.mutateAsync({ ids });
      if (!silent) {
        toast.success(
          "Marked resolved",
          `${r.resolved} row${r.resolved === 1 ? "" : "s"} cleared.`,
        );
      }
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      invalidateAfterMutation();
    } catch (err) {
      toast.error("Could not mark resolved", (err as Error).message);
    }
  };

  // === Bulk action handlers ===
  const handleBulkReplay = async () => {
    setConfirmOpen(null);
    try {
      const ids = selected.size > 0 ? Array.from(selected) : undefined;
      const r = await bulkReplay.mutateAsync(ids ? { ids } : {});
      const parts: string[] = [];
      if (r.succeeded > 0) parts.push(`${r.succeeded} fixed`);
      if (r.stillStuck > 0) parts.push(`${r.stillStuck} still stuck`);
      if (r.deadLettered > 0) parts.push(`${r.deadLettered} dead-lettered`);
      const summary = parts.join(", ") || `${r.attempted} processed`;
      if (r.succeeded > 0) toast.success("Bulk replay complete", summary);
      else toast.info("Bulk replay finished", summary);
      setSelected(new Set());
      invalidateAfterMutation();
    } catch (err) {
      toast.error("Bulk replay failed", (err as Error).message);
    }
  };

  const handleBulkResolve = async () => {
    setConfirmOpen(null);
    const ids = selected.size > 0 ? Array.from(selected) : rows.map((r) => r.id);
    if (ids.length === 0) return;
    await handleResolve(ids);
  };

  const handleExport = () => {
    if (rows.length === 0) {
      toast.info("Nothing to export", "Your issues list is empty.");
      return;
    }
    const csv = exportRowsAsCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `integration-issues-${date}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("Export ready", `${rows.length} rows downloaded.`);
  };

  // === Render ===
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-fg">
            <ShieldX className="h-6 w-6 text-warning" />
            Issues
            {totalStuck > 0 ? (
              <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning">
                {totalStuck}
              </span>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-fg-subtle">
            Orders that didn't ingest cleanly. Fix the cause in your storefront,
            then replay — or mark resolved if they don't need to ingest.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExport}
            disabled={rows.length === 0}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setConfirmOpen({ kind: "replay-all", count: selected.size || rows.length })
            }
            disabled={rows.length === 0 || bulkReplay.isPending}
          >
            {bulkReplay.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
            )}
            {selected.size > 0 ? `Replay ${selected.size} selected` : "Replay all"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setConfirmOpen({ kind: "resolve-all", count: selected.size || rows.length })
            }
            disabled={rows.length === 0 || resolve.isPending}
          >
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            {selected.size > 0 ? `Mark ${selected.size} resolved` : "Mark all resolved"}
          </Button>
        </div>
      </header>

      <ReasonTabs
        reasonsCount={reasonsCount}
        active={activeReason}
        onChange={(r) => {
          setActiveReason(r);
          setSelected(new Set());
        }}
        total={totalStuck}
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">
            {activeReason
              ? `${REASON_LABELS[activeReason] ?? activeReason} (${rows.length})`
              : `All issues (${rows.length})`}
          </CardTitle>
          {rows.length > 0 ? (
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="Select all rows"
              />
              <span>{allSelected ? "Deselect all" : "Select all"}</span>
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {issues.isLoading ? (
            <div className="flex items-center justify-center py-12 text-fg-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <IssueRowCard
                  key={row.id}
                  row={row}
                  selected={selected.has(row.id)}
                  onToggle={() => toggleOne(row.id)}
                  onReplay={() => handleReplay(row)}
                  onResolve={() => handleResolve([row.id])}
                  isMutating={
                    (replayOne.isPending && replayOne.variables?.id === row.id) ||
                    (resolve.isPending && (resolve.variables?.ids ?? []).includes(row.id))
                  }
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen !== null}
        onOpenChange={(v) => (!v ? setConfirmOpen(null) : null)}
        confirmOpen={confirmOpen}
        onConfirmReplay={handleBulkReplay}
        onConfirmResolve={handleBulkResolve}
      />
    </div>
  );
}

/** Tab strip across the top of the page — one per skipReason + "All". */
function ReasonTabs({
  reasonsCount,
  active,
  onChange,
  total,
}: {
  reasonsCount: Record<string, number>;
  active: string | null;
  onChange: (reason: string | null) => void;
  total: number;
}) {
  const reasons = Object.keys(reasonsCount).sort();
  return (
    <div className="flex flex-wrap gap-2">
      <ReasonTab
        active={active === null}
        label="All"
        count={total}
        onClick={() => onChange(null)}
      />
      {reasons.map((r) => (
        <ReasonTab
          key={r}
          active={active === r}
          label={REASON_LABELS[r] ?? r}
          count={reasonsCount[r] ?? 0}
          onClick={() => onChange(r)}
        />
      ))}
    </div>
  );
}

function ReasonTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-brand bg-brand-subtle text-brand"
          : "border-stroke/12 bg-surface text-fg-muted hover:bg-surface-raised"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 py-0 text-2xs ${active ? "bg-brand/20" : "bg-surface-raised"}`}
      >
        {count}
      </span>
    </button>
  );
}

/** One row in the list. Carries inline error explanation + actions. */
function IssueRowCard({
  row,
  selected,
  onToggle,
  onReplay,
  onResolve,
  isMutating,
}: {
  row: IssueRow;
  selected: boolean;
  onToggle: () => void;
  onReplay: () => void;
  onResolve: () => void;
  isMutating: boolean;
}) {
  const explanation = explainError({
    skipReason: row.skipReason,
    lastError: row.lastError,
  });
  const fixUrl = buildSourceFixUrl({
    provider: row.provider,
    accountKey: row.providerAccountKey,
    externalId: row.externalId,
  });

  return (
    <li className="rounded-md border border-stroke/10 bg-surface p-3">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1"
          aria-label={`Select issue ${row.externalId}`}
        />
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs text-fg">
                {row.providerLabel ?? row.provider}
              </span>
              <span className="text-2xs uppercase tracking-wide text-fg-muted">
                {row.topic}
              </span>
              <span className="text-2xs text-fg-subtle">id: {row.externalId}</span>
            </div>
            <time
              className="text-2xs text-fg-faint"
              dateTime={String(row.receivedAt)}
              title={new Date(row.receivedAt).toLocaleString()}
            >
              {formatRelativeTime(row.receivedAt)}
            </time>
          </div>

          <SmartError explanation={explanation} fixUrl={fixUrl} compact />

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {fixUrl ? (
              <a
                href={fixUrl.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-stroke/12 bg-surface px-2.5 py-1 text-2xs font-medium text-fg hover:bg-surface-raised"
              >
                <ExternalLink className="h-3 w-3" />
                {fixUrl.label}
              </a>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              onClick={onReplay}
              disabled={isMutating}
            >
              {isMutating ? (
                <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <PlayCircle className="mr-1 h-3 w-3" />
              )}
              Replay
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onResolve}
              disabled={isMutating}
            >
              <X className="mr-1 h-3 w-3" />
              Ignore
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Bulk-action confirmation. Different copy for replay vs resolve. */
function ConfirmDialog({
  open,
  onOpenChange,
  confirmOpen,
  onConfirmReplay,
  onConfirmResolve,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  confirmOpen:
    | null
    | { kind: "replay-all"; count: number }
    | { kind: "resolve-all"; count: number };
  onConfirmReplay: () => void;
  onConfirmResolve: () => void;
}) {
  const isReplay = confirmOpen?.kind === "replay-all";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            {isReplay
              ? `Replay ${confirmOpen?.count ?? 0} order${confirmOpen?.count === 1 ? "" : "s"}?`
              : `Mark ${confirmOpen?.count ?? 0} resolved?`}
          </DialogTitle>
          <DialogDescription className="text-fg-muted">
            {isReplay
              ? "Each row will be re-run through ingestion. Rows that haven't been fixed in your storefront will land back in this list with the same reason."
              : "These rows won't ingest. Use this for cancelled or test orders that don't need to become real orders. The action is reversible — resolved rows still appear in the audit log."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {isReplay ? (
            <Button onClick={onConfirmReplay}>
              <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
              Yes, replay
            </Button>
          ) : (
            <Button variant="destructive" onClick={onConfirmResolve}>
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              Yes, mark resolved
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <CheckCircle2 className="h-10 w-10 text-success" />
      <p className="text-sm font-medium text-fg">All caught up</p>
      <p className="max-w-sm text-xs text-fg-muted">
        Every order is ingesting cleanly. New issues will appear here when an
        order can't be processed automatically.
      </p>
    </div>
  );
}

/** Pure CSV builder. Quotes every field defensively to handle commas in errors. */
function exportRowsAsCsv(rows: IssueRow[]): string {
  const header = [
    "row_id",
    "provider",
    "integration_label",
    "topic",
    "external_id",
    "status",
    "skip_reason",
    "last_error",
    "attempts",
    "received_at",
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.provider,
        r.providerLabel ?? r.providerAccountKey ?? "",
        r.topic,
        r.externalId,
        r.status,
        r.skipReason ?? "",
        r.lastError ?? "",
        r.attempts,
        new Date(r.receivedAt).toISOString(),
      ]
        .map(escape)
        .join(","),
    );
  }
  return lines.join("\n");
}

/** Dependency-free relative-time helper — keeps this page self-contained. */
function formatRelativeTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
