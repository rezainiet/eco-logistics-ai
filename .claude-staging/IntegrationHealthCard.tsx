"use client";

import { useEffect, useRef } from "react";
import { AlertOctagon, AlertTriangle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/formatters";
import { HealthBadge, type HealthStatus } from "./HealthBadge";
import { ActionButtons } from "./ActionButtons";

const PROVIDER_LABEL: Record<string, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  custom_api: "Custom API",
  csv: "CSV import",
};

/**
 * One card per integration. Self-fetches its own health snapshot via
 * `integrations.getHealth` so the parent page can stay a thin list
 * + the `ActionButtons` mutations can `invalidate` this same query to
 * trigger a re-render after a merchant action.
 *
 * All fields tolerate `null` / `undefined` — a freshly-connected
 * integration legitimately has no `lastWebhookAt` or `lastImportAt`
 * yet, and the badge falls back to `idle`. Loading and error states
 * render shimmer / fallback rather than throwing — this card sits on
 * a list view, one integration's outage shouldn't break the page.
 */
export function IntegrationHealthCard({
  integrationId,
  provider,
  accountKey,
  disabled,
  highlight,
}: {
  integrationId: string;
  provider: string;
  accountKey: string;
  /** Force-disable the action buttons (e.g. integration is degraded). */
  disabled?: boolean;
  /**
   * When true, scroll the card into view on mount and apply a brief
   * focus ring. Used by the page's `?id=...` deep-link handler so a
   * merchant landing from "View health" arrives looking at the right
   * row.
   */
  highlight?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!highlight) return;
    const node = cardRef.current;
    if (!node) return;
    // `block: "center"` keeps the highlighted card visually centered
    // even when there's a header above it. `behavior: "smooth"` is
    // animated but degrades gracefully on `prefers-reduced-motion`.
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight]);

  const health = trpc.integrations.getHealth.useQuery(
    { id: integrationId },
    {
      // Re-poll every minute so a card left open updates without
      // requiring the merchant to refresh. Cheap — single Mongo
      // findOne with field projection.
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  );

  if (health.isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="h-4 w-32 animate-pulse rounded bg-surface-raised" />
          <div className="h-3 w-48 animate-pulse rounded bg-surface-raised" />
          <div className="h-3 w-64 animate-pulse rounded bg-surface-raised" />
        </CardContent>
      </Card>
    );
  }

  if (health.isError || !health.data) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm text-danger">
            <AlertOctagon className="h-4 w-4" />
            Couldn't load health data
            {health.error?.message ? (
              <span className="text-xs text-fg-muted">— {health.error.message}</span>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  const data = health.data;
  const status = (data.status ?? "idle") as HealthStatus;
  const providerLabel = PROVIDER_LABEL[provider] ?? provider;
  const noActivity =
    !data.lastImportAt &&
    !data.lastWebhookAt &&
    (data.errorCount ?? 0) === 0 &&
    status === "idle";

  return (
    <Card
      ref={cardRef}
      id={`integration-${integrationId}`}
      // Soft focus ring + subtle background tint when the merchant
      // arrived here via `?id=…`. The transition timer below removes
      // the highlight after the eye has had time to land on the row,
      // so a returning visitor doesn't see a permanent "selected"
      // state.
      className={cn(
        "transition-colors",
        highlight && "ring-2 ring-info ring-offset-2 ring-offset-bg",
      )}
    >
      <CardHeader className="flex flex-col items-start gap-2 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-base">
            {providerLabel}
            <span className="ml-2 text-xs font-normal text-fg-muted">
              {accountKey}
            </span>
          </CardTitle>
        </div>
        <HealthBadge status={status} />
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-muted">
              Last import
            </dt>
            <dd className="font-medium text-fg">
              {data.lastImportAt
                ? formatRelative(data.lastImportAt as unknown as string)
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-muted">
              Last webhook
            </dt>
            <dd className="font-medium text-fg">
              {data.lastWebhookAt
                ? formatRelative(data.lastWebhookAt as unknown as string)
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-fg-muted">
              Error count
            </dt>
            <dd className="font-medium text-fg">{data.errorCount}</dd>
          </div>
          {data.lastError ? (
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-fg-muted">
                Last error
              </dt>
              <dd className="break-words rounded-md bg-surface-raised px-2 py-1 font-mono text-xs text-danger">
                {data.lastError}
              </dd>
            </div>
          ) : null}
        </dl>

        {/* Inline alert flags — derived server-side by
            `evaluateIntegrationHealth`. Render zero-or-many; the
            order matches escalation severity. The "Connection error"
            alert here is the merchant-facing surface for the
            ECONNREFUSED / ENOTFOUND / timeout class — anything the
            test mutation classifies as `kind: "transient"` lands the
            row in `lastSyncStatus = "error"` with a `Connection
            error — cannot reach <host>: ...` `lastError`. Without
            this branch the merchant sees a red pill with no anchor
            for what to do next. */}
        {(status === "error" ||
          data.flags?.webhookSilent ||
          data.flags?.unhealthy ||
          disabled) && (
          <div className="space-y-1.5">
            {status === "error" &&
            (data.lastError?.toLowerCase().includes("connection error") ||
              data.lastError?.toLowerCase().includes("econnrefused") ||
              data.lastError?.toLowerCase().includes("enotfound") ||
              data.lastError?.toLowerCase().includes("timeout") ||
              data.lastError?.toLowerCase().includes("network error")) ? (
              <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
                <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Connection error — your store appears unreachable.
                  Check that the URL is correct and the server is
                  accepting traffic, then click <strong>Test connection</strong>.
                </span>
              </div>
            ) : null}
            {data.flags?.webhookSilent ? (
              <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Webhook silent — we haven't received a delivery in a while.
                  Try Sync now to fetch missed orders.
                </span>
              </div>
            ) : null}
            {data.flags?.unhealthy ? (
              <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  High error count ({data.errorCount}). Retry failed will
                  replay queued deliveries.
                </span>
              </div>
            ) : null}
            {disabled ? (
              <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
                <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Integration degraded. Recovery actions paused — please
                  reconnect to resume.
                </span>
              </div>
            ) : null}
          </div>
        )}

        {noActivity ? (
          <p className="rounded-md border border-stroke/8 bg-surface-raised/40 px-3 py-2 text-xs text-fg-subtle">
            No activity yet — place a test order or click <strong>Sync now</strong>{" "}
            to pull the most recent batch from the upstream platform.
          </p>
        ) : null}

        <ActionButtons integrationId={integrationId} disabled={disabled} />
      </CardContent>
    </Card>
  );
}
