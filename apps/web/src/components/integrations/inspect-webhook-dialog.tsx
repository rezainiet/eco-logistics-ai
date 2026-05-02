"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatRelative } from "@/lib/formatters";

export function InspectWebhookDialog({
  id,
  onClose,
  onReplay,
  replayPending,
}: {
  id: string | null;
  onClose: () => void;
  onReplay: (id: string) => void;
  replayPending: boolean;
}) {
  const open = id !== null;
  const detail = trpc.integrations.inspectWebhook.useQuery(
    { id: id ?? "" },
    { enabled: open },
  );
  const row = detail.data;

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Automatic update activity</DialogTitle>
        </DialogHeader>
        {detail.isLoading ? (
          <div className="flex items-center justify-center py-8 text-fg-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : row ? (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Provider</Label>
                <p className="font-medium text-fg">{row.provider}</p>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Topic</Label>
                <p className="font-medium text-fg">{row.topic}</p>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">External id</Label>
                <p className="font-mono text-fg">{row.externalId}</p>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Status</Label>
                <Badge
                  variant="outline"
                  className={
                    row.deadLetteredAt
                      ? "bg-danger-subtle text-danger"
                      : row.status === "succeeded"
                        ? "bg-success-subtle text-success"
                        : row.status === "failed"
                          ? "bg-danger-subtle text-danger"
                          : "bg-warning-subtle text-warning"
                  }
                >
                  {row.deadLetteredAt ? "dead-lettered" : row.status}
                </Badge>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Attempts</Label>
                <p className="font-medium text-fg">{row.attempts}</p>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Received</Label>
                <p className="text-fg">{formatRelative(row.receivedAt)}</p>
              </div>
              {row.nextRetryAt ? (
                <div>
                  <Label className="text-2xs uppercase text-fg-faint">Next retry</Label>
                  <p className="text-fg">{formatRelative(row.nextRetryAt)}</p>
                </div>
              ) : null}
              {row.deadLetteredAt ? (
                <div>
                  <Label className="text-2xs uppercase text-fg-faint">Dead-lettered</Label>
                  <p className="text-danger">{formatRelative(row.deadLetteredAt)}</p>
                </div>
              ) : null}
            </div>

            {row.lastError ? (
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Last error</Label>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-danger-border bg-danger-subtle p-2 text-2xs text-danger">
                  {row.lastError}
                </pre>
              </div>
            ) : null}

            <div>
              <Label className="text-2xs uppercase text-fg-faint">
                Payload ({row.payloadBytes} bytes)
              </Label>
              <pre className="max-h-72 overflow-auto rounded-md border border-stroke/12 bg-surface-raised p-2 text-2xs text-fg">
                {row.payload ? JSON.stringify(row.payload, null, 2) : "(empty)"}
              </pre>
            </div>

            <div className="flex justify-end gap-2">
              {row.canReplay ? (
                <Button
                  size="sm"
                  disabled={replayPending}
                  onClick={() => onReplay(row.id)}
                >
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                  {replayPending ? "Replaying…" : "Replay now"}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <p className="py-4 text-xs text-fg-faint">Update not found.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
