"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  RefreshCw,
  Wifi,
  PlayCircle,
  Plug,
  CheckCircle2,
  AlertOctagon,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Per-integration action toolbar rendered at the bottom of every
 * `IntegrationHealthCard`. Wires the four primary recovery / diagnostic
 * actions to their existing tRPC mutations:
 *
 *   - Sync now      → integrations.syncNow      (poll the last batch)
 *   - Test          → integrations.test         (live credential check)
 *   - Retry failed  → integrations.retryFailed  (replay needs-retry rows)
 *   - Reconnect     → navigate to the page-level connect dialog with
 *                     ?reconnect=<id> so the parent route can pre-fill
 *                     credentials and run the OAuth flow again
 *
 * Why this lives in its own file instead of inlined: every action
 * mutates a different tRPC query, so consolidating the optimistic
 * `utils.invalidate` calls in one place keeps the card render code
 * focused on layout. Also makes the buttons reusable from the future
 * "all integrations" admin tab.
 *
 * Backwards-compatible with the parent: parent only passes
 * `integrationId` + `disabled`. No callbacks needed — every button
 * either triggers a mutation that the next `getHealth` refetch picks
 * up, or navigates to a query-param the page already understands.
 */
export function ActionButtons({
  integrationId,
  disabled,
}: {
  integrationId: string;
  /**
   * When true (e.g. the integration was system-marked `degraded` or the
   * health card is rendered in a read-only context), every button is
   * disabled but stays visible — better than hiding them, which would
   * leave the merchant wondering whether the actions ever existed.
   */
  disabled?: boolean;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [reconnectOpen, setReconnectOpen] = useState(false);

  // Helper: invalidate everything that depends on integration state so
  // the post-action UI snaps to the latest server truth without a
  // manual refresh. Done as one call rather than per-button so a future
  // 5th action stays a one-line change.
  const invalidateAll = () => {
    void utils.integrations.getHealth.invalidate({ id: integrationId });
    void utils.integrations.list.invalidate();
    // recentWebhooks takes `integrationId`, not `id` — different from
    // the per-integration query shape. Invalidate broadly so the
    // needs_attention banner on the same card refreshes too.
    void utils.integrations.recentWebhooks.invalidate({ integrationId });
  };

  const sync = trpc.integrations.syncNow.useMutation({
    onSuccess: (data) => {
      // The mutation returns counters even on partial success — surface
      // the merchant-relevant ones so the toast says something more
      // useful than "Done." Distinct messaging for "fetched zero" so
      // they don't think the button is broken when the upstream is just
      // empty.
      if ((data.enqueued ?? 0) === 0 && (data.duplicates ?? 0) === 0) {
        toast.success("Sync complete", "No new orders since the last sync.");
      } else {
        toast.success(
          "Sync complete",
          `${data.enqueued ?? 0} new, ${data.duplicates ?? 0} duplicate${data.duplicates === 1 ? "" : "s"}.`,
        );
      }
      invalidateAll();
    },
    onError: (err) => {
      toast.error("Sync failed", humanizeError(err.message));
    },
  });

  const test = trpc.integrations.test.useMutation({
    onSuccess: (data) => {
      // The router returns `{ ok, detail }` — show the detail string so
      // the merchant sees the same provider message they'd see from a
      // direct API hit (e.g. "Connected to Acme Store (Basic)" or
      // "Connection error — cannot reach acme.com: ECONNREFUSED").
      const detail = (data as { detail?: string }).detail ?? "";
      if (data.ok) {
        toast.success("Connection OK", detail || "Credentials are valid.");
      } else {
        toast.error(
          "Connection failed",
          detail || "Test failed — check credentials and try again.",
        );
      }
      invalidateAll();
    },
    onError: (err) => {
      toast.error("Test failed", humanizeError(err.message));
    },
  });

  const retry = trpc.integrations.retryFailed.useMutation({
    onSuccess: (data) => {
      // Three counters back: succeeded / failedAgain / deadLettered.
      // Build a summary that prioritises good news but never hides
      // the bad — merchants need to know if a retry actually moved
      // orders or just spun.
      if (data.attempted === 0) {
        toast.info(
          "Nothing to retry",
          "All recent webhooks succeeded. Failed deliveries appear here when retries hit the backoff cap.",
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
        // Pick variant on the worst-result wins: anything dead-lettered
        // or all-failed → red error. Mixed → green success because at
        // least one order was rescued.
        if (data.succeeded === 0 && data.failedAgain + data.deadLettered > 0) {
          toast.error("Retry finished", description);
        } else {
          toast.success("Retry complete", description);
        }
      }
      invalidateAll();
    },
    onError: (err) => {
      toast.error("Retry failed", humanizeError(err.message));
    },
  });

  const isAnyPending =
    sync.isPending || test.isPending || retry.isPending;
  const allDisabled = disabled || isAnyPending;

  return (
    <>
      <div className="flex flex-wrap gap-2 pt-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => sync.mutate({ id: integrationId })}
          disabled={allDisabled}
          aria-label="Sync now — pull recent orders from the upstream platform"
        >
          {sync.isPending ? (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {sync.isPending ? "Syncing…" : "Sync now"}
        </Button>

        <Button
          size="sm"
          variant="secondary"
          onClick={() => test.mutate({ id: integrationId })}
          disabled={allDisabled}
          aria-label="Test connection — live credential check"
        >
          {test.isPending ? (
            <Wifi className="mr-1.5 h-3.5 w-3.5 animate-pulse" />
          ) : (
            <Wifi className="mr-1.5 h-3.5 w-3.5" />
          )}
          {test.isPending ? "Testing…" : "Test connection"}
        </Button>

        <Button
          size="sm"
          variant="secondary"
          onClick={() => retry.mutate({ id: integrationId })}
          disabled={allDisabled}
          aria-label="Retry failed webhook deliveries"
        >
          {retry.isPending ? (
            <PlayCircle className="mr-1.5 h-3.5 w-3.5 animate-pulse" />
          ) : (
            <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
          )}
          {retry.isPending ? "Retrying…" : "Retry failed"}
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setReconnectOpen(true)}
          disabled={allDisabled}
          aria-label="Reconnect — re-authenticate this integration"
        >
          <Plug className="mr-1.5 h-3.5 w-3.5" />
          Reconnect
        </Button>
      </div>

      <ReconnectConfirmDialog
        open={reconnectOpen}
        onOpenChange={setReconnectOpen}
        onConfirm={() => {
          // The page (`/dashboard/integrations`) listens for the
          // `?reconnect=<id>` query param on mount and opens the
          // appropriate provider connect modal pre-filled. Doing this
          // via URL means the merchant lands on a stateful page they
          // can also bookmark / share with support.
          setReconnectOpen(false);
          router.push(`/dashboard/integrations?reconnect=${integrationId}`);
        }}
      />
    </>
  );
}

/**
 * Humanize tRPC error strings that happen to embed our internal "code:"
 * prefix. Falls back to the raw string for anything that doesn't match
 * the contract — better to show a verbose error than swallow it.
 */
function humanizeError(raw: string | undefined): string {
  if (!raw) return "Unexpected error.";
  // tRPC ZodError surfaces here as a JSON string sometimes — keep the
  // human-readable suffix.
  if (raw.startsWith("[")) return "Invalid request.";
  // Our routers throw `entitlement_blocked:<code>:<detail>` for plan
  // gating — translate the most common hits inline.
  if (raw.startsWith("entitlement_blocked:integration_count_capped")) {
    return "Plan cap reached. Upgrade to add more integrations.";
  }
  if (raw.startsWith("entitlement_blocked:integration_provider_locked")) {
    return "This provider isn't on your current plan. Upgrade to enable it.";
  }
  return raw;
}

/**
 * Reconnect requires user re-authentication (Shopify OAuth, Woo
 * credential paste, custom-API key reveal). The dialog tells the
 * merchant exactly what's about to happen so the click isn't a leap
 * of faith.
 */
function ReconnectConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconnect this integration?</DialogTitle>
          <DialogDescription className="text-fg-muted">
            We'll take you back to the connect dialog so you can re-authenticate
            with the upstream platform. Existing webhook history,
            counters, and dead-letter rows are kept — only the credential
            material is refreshed.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 rounded-md bg-surface-raised/60 p-3 text-xs text-fg-muted">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            Inbox + delivery history is preserved.
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            The same webhook URL stays valid — your storefront keeps posting.
          </li>
          <li className="flex items-start gap-2">
            <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            New OAuth scopes / API keys may be requested.
          </li>
        </ul>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Continue to reconnect</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
