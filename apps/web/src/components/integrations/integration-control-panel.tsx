"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CircleStop,
  PauseCircle,
  PlayCircle,
  Trash2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";

/**
 * Power-user controls for an integration. Distinct from `ActionButtons`
 * (which holds non-destructive recovery actions like Sync / Test /
 * Retry / Reconnect) — this panel hosts the lifecycle actions:
 *
 *   - Pause ingestion          (soft, reversible)
 *   - Resume ingestion         (mirror of pause)
 *   - Disconnect (with safety) (destructive — hides credentials,
 *                              tears down upstream subscription)
 *
 * Each lifecycle change goes through a confirmation dialog so an
 * accidental click can never sever a working connection.
 *
 * The panel renders a "Paused" banner when `pausedAt` is set so the
 * merchant always understands why no events are arriving — silent
 * pauses are the single biggest support-ticket producer.
 */
export function IntegrationControlPanel({
  integrationId,
  status,
  pausedAt,
  pausedReason,
  provider,
  accountKey,
  onPauseChange,
}: {
  integrationId: string;
  /** Lifecycle status from the integrations row (connected/disconnected/etc). */
  status: string;
  /** Truthy when the integration is currently paused. */
  pausedAt?: string | Date | null;
  pausedReason?: string | null;
  provider: string;
  accountKey: string;
  /**
   * Optional callback fired after a pause/resume/disconnect mutation
   * succeeds, so the parent can re-fetch any local data that depends
   * on the integration's lifecycle. Invalidations of tRPC queries are
   * handled internally — `onPauseChange` is for UI signalling only.
   */
  onPauseChange?: () => void;
}) {
  const utils = trpc.useUtils();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const isPaused = !!pausedAt;
  const isConnected = status === "connected";

  const refresh = () => {
    void utils.integrations.list.invalidate();
    void utils.integrations.getHealth.invalidate({ id: integrationId });
    onPauseChange?.();
  };

  const pause = trpc.integrations.pause.useMutation({
    onSuccess: () => {
      toast.success(
        "Ingestion paused",
        "Webhooks and polling are stopped until you resume.",
      );
      setPauseOpen(false);
      setPauseReason("");
      refresh();
    },
    onError: (err) => toast.error("Could not pause", err.message),
  });

  const resume = trpc.integrations.resume.useMutation({
    onSuccess: () => {
      toast.success(
        "Ingestion resumed",
        "New webhooks will land. Click Sync now to backfill missed orders.",
      );
      refresh();
    },
    onError: (err) => toast.error("Could not resume", err.message),
  });

  const disconnect = trpc.integrations.disconnect.useMutation({
    onSuccess: () => {
      toast.success(
        "Integration disconnected",
        "Credentials wiped. Reconnect any time to resume.",
      );
      setDisconnectOpen(false);
      refresh();
    },
    onError: (err) => toast.error("Could not disconnect", err.message),
  });

  return (
    <div className="space-y-2">
      {isPaused ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle p-2.5 text-xs text-warning">
          <PauseCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex-1 space-y-0.5">
            <p className="font-medium">
              Ingestion paused
              {pausedAt ? (
                <span className="ml-1 font-normal text-fg-muted">
                  · since {new Date(pausedAt).toLocaleString()}
                </span>
              ) : null}
            </p>
            {pausedReason ? (
              <p className="text-fg-muted">"{pausedReason}"</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {isPaused ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => resume.mutate({ id: integrationId })}
            disabled={resume.isPending || !isConnected}
          >
            <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
            {resume.isPending ? "Resuming…" : "Resume ingestion"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPauseOpen(true)}
            disabled={!isConnected}
          >
            <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
            Pause ingestion
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDisconnectOpen(true)}
          disabled={status !== "connected" && status !== "error"}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Disconnect safely
        </Button>
      </div>

      {/* === Pause confirmation === */}
      <Dialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PauseCircle className="h-5 w-5 text-warning" />
              Pause ingestion?
            </DialogTitle>
            <DialogDescription className="text-fg-muted">
              While paused, we won't process new webhooks or run the polling
              sweep for {provider} · {accountKey}. The upstream connection
              stays intact — your storefront keeps posting to our endpoint and
              we'll acknowledge with a 202.
              <br />
              <br />
              <strong className="text-fg">Missed orders won't auto-backfill.</strong>{" "}
              When you resume, click Sync now to pull anything you missed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pause-reason">Reason (optional)</Label>
            <Input
              id="pause-reason"
              placeholder="e.g. fraud audit, manual reconciliation"
              value={pauseReason}
              onChange={(e) => setPauseReason(e.target.value)}
              maxLength={200}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setPauseOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                pause.mutate({
                  id: integrationId,
                  reason: pauseReason.trim() || undefined,
                })
              }
              disabled={pause.isPending}
            >
              <CircleStop className="mr-1.5 h-3.5 w-3.5" />
              {pause.isPending ? "Pausing…" : "Yes, pause ingestion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* === Safe disconnect confirmation === */}
      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-danger" />
              Disconnect this integration?
            </DialogTitle>
            <DialogDescription className="text-fg-muted">
              We'll revoke our access on the upstream platform when possible
              ({provider === "shopify"
                ? "Shopify token revoked, app uninstalled"
                : provider === "woocommerce"
                  ? "Woo webhook subscriptions deleted"
                  : "credentials wiped"}
              ), then mark the integration disconnected on our side. Webhook
              history, dead-letter rows, and audit logs are kept — you can
              reconnect any time without losing data.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1.5 rounded-md bg-surface-raised/60 p-3 text-xs text-fg-muted">
            <li>• Encrypted credentials are removed from our database.</li>
            <li>• In-flight webhooks finish processing; new ones are rejected.</li>
            <li>
              • If you only want to <strong className="text-fg">temporarily stop</strong> ingestion,{" "}
              <button
                className="text-brand underline-offset-2 hover:underline"
                onClick={() => {
                  setDisconnectOpen(false);
                  setPauseOpen(true);
                }}
              >
                pause it instead
              </button>
              .
            </li>
          </ul>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDisconnectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnect.mutate({ id: integrationId })}
              disabled={disconnect.isPending}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {disconnect.isPending ? "Disconnecting…" : "Yes, disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
