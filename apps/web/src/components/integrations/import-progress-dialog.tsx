"use client";

import { useMemo, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  PlayCircle,
  RefreshCw,
} from "lucide-react";
import type { RouterOutputs } from "@ecom/types";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

/**
 * Modal showing the progress of an order-import job from Shopify /
 * WooCommerce. Polled by the parent via the `progress` prop.
 *
 * UX upgrade: when an import has failed rows, the merchant gets:
 *  1. A clear "Failed reasons" panel grouping the rejected rows by
 *     normalised cause ("Customer phone missing", "Address pending",
 *     transient connection errors, etc.) so they can spot a
 *     storefront-config bug at a glance instead of scrolling stack
 *     traces.
 *  2. A "View failed orders" link that deep-links to the
 *     /dashboard/integrations health card with a query param the page
 *     uses to scroll-to + open the inspect panel for that integration.
 *  3. A "Retry" button that re-uses the existing `retryFailed` mutation,
 *     replaying the inbox rows the import couldn't normalise on first
 *     pass — the same backend path the per-integration health card
 *     uses, so behaviour stays consistent.
 *
 * Pure-presentational for happy paths; the failure UX above intentionally
 * owns its own mutations so the parent doesn't grow more state.
 */
export function ImportProgressDialog({
  jobId,
  progress,
  onClose,
}: {
  jobId: string | null;
  progress: RouterOutputs["integrations"]["getImportJob"] | undefined;
  onClose: () => void;
}) {
  const open = jobId !== null;
  const finished =
    progress?.status === "succeeded" ||
    progress?.status === "failed" ||
    progress?.status === "cancelled";
  const hasFailures = (progress?.failedRows ?? 0) > 0;

  // Group/categorise the lastError string into a plain-English reason
  // category. Imports often produce a single representative `lastError`
  // — we surface the category prominently and the raw string in a
  // collapsible "Show technical detail" so non-technical merchants
  // aren't scared by stack traces but ops can still copy the original.
  const failureReason = useMemo(
    () => classifyImportFailure(progress?.lastError ?? null),
    [progress?.lastError],
  );

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {progress?.status === "running"
              ? "Importing orders…"
              : progress?.status === "succeeded"
                ? "Import complete"
                : progress?.status === "failed"
                  ? "Import failed"
                  : "Import queued"}
          </DialogTitle>
          {progress?.status === "running" ? (
            <DialogDescription className="text-fg-muted">
              Pulling the most recent batch from {progress.provider}. Safe to
              close this dialog — the job continues in the background and
              you'll see the new orders on the dashboard.
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {!progress ? (
          <div className="flex items-center justify-center py-6 text-fg-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-fg-subtle">Provider</span>
              <span className="font-mono text-fg">{progress.provider}</span>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-fg-subtle">Progress</span>
                <span className="text-fg">
                  {progress.processedRows} / {progress.totalRows || "?"}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
                <div
                  className={`h-2 rounded-full transition-all ${
                    progress.status === "failed" ? "bg-danger" : "bg-brand"
                  }`}
                  style={{ width: `${progress.progressPct}%` }}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Counter
                label="Imported"
                value={progress.importedRows}
                tone="success"
                Icon={CheckCircle2}
              />
              <Counter
                label="Duplicates"
                value={progress.duplicateRows}
                tone="muted"
                Icon={Clock}
              />
              <Counter
                label="Failed"
                value={progress.failedRows}
                tone="danger"
                Icon={AlertOctagon}
              />
            </div>

            {hasFailures || progress.lastError ? (
              <FailedReasonsPanel
                reason={failureReason}
                rawError={progress.lastError}
                failedCount={progress.failedRows}
              />
            ) : null}

            {finished ? (
              <FinishedActions
                integrationId={progress.integrationId}
                hasFailures={hasFailures}
                onClose={onClose}
              />
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Compact stat tile — keeps the modal header readable. */
function Counter({
  label,
  value,
  tone,
  Icon,
}: {
  label: string;
  value: number;
  tone: "success" | "danger" | "muted";
  Icon: typeof CheckCircle2;
}) {
  const valueClass =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-danger"
        : "text-fg";
  return (
    <div className="rounded-md border border-stroke/8 px-2 py-2">
      <div className="text-fg-faint text-2xs flex items-center justify-center gap-1 uppercase">
        <Icon className="h-3 w-3" aria-hidden />
        {label}
      </div>
      <div className={`text-base font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

/** Categorises an import-job error string into a merchant-readable bucket. */
type FailureCategory = {
  /** Short label rendered as the header. */
  label: string;
  /** What the merchant should do, in one line. */
  guidance: string;
  /** Tone for the panel border and icon. */
  tone: "warning" | "danger";
};

function classifyImportFailure(raw: string | null): FailureCategory | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // Hand-crafted heuristics — keep order specific → general so the
  // first match wins for ambiguous strings.
  if (lower.includes("missing customer phone") || lower.includes("missing_phone")) {
    return {
      label: "Customer phone missing on some orders",
      guidance:
        "Update your storefront's checkout to require a phone number. Orders without one cannot be delivered.",
      tone: "warning",
    };
  }
  if (lower.includes("missing_external_id")) {
    return {
      label: "Upstream payload didn't include an order id",
      guidance:
        "This usually points at a storefront plugin sending malformed data. Reach out to support if it persists.",
      tone: "danger",
    };
  }
  if (
    lower.includes("connection error") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("timeout") ||
    lower.includes("network error")
  ) {
    return {
      label: "Could not reach your store",
      guidance:
        "Check that the URL is correct and the server is accepting traffic, then click Test connection on the integration card.",
      tone: "danger",
    };
  }
  if (lower.includes("401") || lower.includes("invalid api key") || lower.includes("invalid access token")) {
    return {
      label: "Credentials were rejected",
      guidance:
        "Your store no longer accepts our token. Click Reconnect on the integration card to re-authenticate.",
      tone: "danger",
    };
  }
  if (lower.includes("403") || lower.includes("scope")) {
    return {
      label: "Missing API scopes",
      guidance:
        "Your store granted fewer permissions than we requested. Reconnect and approve the full scope set.",
      tone: "warning",
    };
  }
  // Fall through — surface the raw string but still wrap it as a
  // category so the panel renders consistently.
  return {
    label: "Some rows didn't import",
    guidance: "Review the technical detail below and click Retry to try again.",
    tone: "warning",
  };
}

/**
 * The actionable failure panel. Always shown when an import has
 * `failedRows > 0` OR a `lastError` (the latter covers cases where the
 * job aborted before it could even count rows — adapter throw, auth
 * failure on the very first call).
 */
function FailedReasonsPanel({
  reason,
  rawError,
  failedCount,
}: {
  reason: FailureCategory | null;
  rawError: string | null;
  failedCount: number;
}) {
  const [showRaw, setShowRaw] = useState(false);
  if (!reason) return null;

  const toneClass =
    reason.tone === "danger"
      ? "border-danger/30 bg-danger-subtle"
      : "border-warning/30 bg-warning-subtle";
  const titleClass =
    reason.tone === "danger" ? "text-danger" : "text-warning";
  const Icon = reason.tone === "danger" ? AlertOctagon : AlertTriangle;

  return (
    <div className={`space-y-2 rounded-md border p-3 ${toneClass}`}>
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${titleClass}`} />
        <div className="space-y-1">
          <p className={`text-sm font-medium ${titleClass}`}>
            {reason.label}
            {failedCount > 0 ? (
              <span className="ml-1 text-xs text-fg-muted">
                ({failedCount} order{failedCount === 1 ? "" : "s"})
              </span>
            ) : null}
          </p>
          <p className="text-xs text-fg-muted">{reason.guidance}</p>
        </div>
      </div>
      {rawError ? (
        <div className="ml-6">
          <button
            type="button"
            className="text-2xs uppercase tracking-wide text-fg-subtle hover:text-fg"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Hide" : "Show"} technical detail
          </button>
          {showRaw ? (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md border border-stroke/8 bg-bg p-2 text-2xs text-fg-muted">
              {rawError}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Footer when the import has finished. Surfaces three actions:
 *   - Close            (always)
 *   - View failed      (only when there are failures — deep-links to
 *                       the integration card with the inspect panel
 *                       open via `?focusInbox=failed`)
 *   - Retry            (only when there are failures — runs the
 *                       per-integration retryFailed mutation directly)
 */
function FinishedActions({
  integrationId,
  hasFailures,
  onClose,
}: {
  integrationId: string;
  hasFailures: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const retry = trpc.integrations.retryFailed.useMutation({
    onSuccess: (data) => {
      if (data.attempted === 0) {
        toast.info(
          "Nothing to retry",
          "All recent webhooks succeeded. Failed rows from the import are surfaced in the integration's inbox after the next sync.",
        );
      } else {
        const parts: string[] = [];
        if (data.succeeded > 0) parts.push(`${data.succeeded} succeeded`);
        if (data.failedAgain > 0) parts.push(`${data.failedAgain} failed again`);
        if (data.deadLettered > 0)
          parts.push(`${data.deadLettered} dead-lettered`);
        const description =
          parts.join(", ") ||
          `Replayed ${data.attempted} delivery${data.attempted === 1 ? "" : "s"}.`;
        if (data.succeeded === 0 && data.failedAgain + data.deadLettered > 0) {
          toast.error("Retry finished", description);
        } else {
          toast.success("Retry complete", description);
        }
      }
      // Refresh both the import job (so the failure panel reflects the
      // result) and the integration's recent webhooks list. Note the
      // shape difference: getHealth expects `id`, recentWebhooks
      // expects `integrationId` — they're separate procedures.
      void utils.integrations.recentWebhooks.invalidate({ integrationId });
      void utils.integrations.getHealth.invalidate({ id: integrationId });
      void utils.integrations.list.invalidate();
    },
    onError: (err) => {
      toast.error(
        "Retry failed",
        err.message || "Could not replay failed deliveries.",
      );
    },
  });

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
      {hasFailures ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            asChild
            // The page parses `focusInbox=failed` and opens the
            // inspect panel filtered to failed deliveries on mount.
          >
            <a
              href={`/dashboard/integrations?id=${integrationId}&focusInbox=failed`}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              View failed orders
            </a>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => retry.mutate({ id: integrationId })}
            disabled={retry.isPending}
          >
            {retry.isPending ? (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
            )}
            {retry.isPending ? "Retrying…" : "Retry"}
          </Button>
        </>
      ) : null}
      <Button size="sm" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
