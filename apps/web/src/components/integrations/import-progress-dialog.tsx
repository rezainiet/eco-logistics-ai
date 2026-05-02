"use client";

import { Loader2 } from "lucide-react";
import type { RouterOutputs } from "@ecom/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Modal showing the progress of an order-import job from Shopify /
 * WooCommerce. Polled by the parent via the `progress` prop.
 *
 * Pure-presentational — owns no fetching state. Extracted from
 * integrations/page.tsx so the parent stays maintainable.
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
  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent>
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
              <div className="rounded-md border border-stroke/8 px-2 py-2">
                <div className="text-fg-faint text-2xs uppercase">Imported</div>
                <div className="text-base font-semibold text-success">
                  {progress.importedRows}
                </div>
              </div>
              <div className="rounded-md border border-stroke/8 px-2 py-2">
                <div className="text-fg-faint text-2xs uppercase">Duplicates</div>
                <div className="text-base font-semibold text-fg">
                  {progress.duplicateRows}
                </div>
              </div>
              <div className="rounded-md border border-stroke/8 px-2 py-2">
                <div className="text-fg-faint text-2xs uppercase">Failed</div>
                <div className="text-base font-semibold text-danger">
                  {progress.failedRows}
                </div>
              </div>
            </div>
            {progress.lastError ? (
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-danger-border bg-danger-subtle p-2 text-2xs text-danger">
                {progress.lastError}
              </pre>
            ) : null}
            {finished ? (
              <div className="flex justify-end">
                <Button size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
