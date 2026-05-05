"use client";

import { useEffect, useMemo, useRef } from "react";
import { AlertOctagon, AlertTriangle, CircleHelp, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/formatters";
import { HealthBadge, type HealthStatus } from "./HealthBadge";
import { ActionButtons } from "./ActionButtons";
import { IntegrationControlPanel } from "./integration-control-panel";
import { IntegrationLogs } from "./integration-logs";

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

  // Translate the raw `lastError` into a "what / why / how" trio for
  // the merchant-facing card. Pure derivation — no fetches — so we
  // memoize on the string so re-renders don't churn the regex check.
  const errorBreakdown = useMemo(
    () => classifyHealthError(data.lastError ?? null),
    [data.lastError],
  );

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
          {data.lastError && errorBreakdown ? (
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-fg-muted">
                Last error
              </dt>
              {/* "What / Why / How" — three short lines so the merchant
                  can act without opening a docs tab. The raw error
                  string is collapsible so support can still copy the
                  exact wording. */}
              <dd className="space-y-1.5 rounded-md border border-danger/20 bg-danger-subtle p-2 text-xs text-danger">
                <div className="flex items-start gap-2">
                  <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="space-y-0.5">
                    <p className="font-medium">{errorBreakdown.what}</p>
                    <p className="text-fg-muted">{errorBreakdown.why}</p>
                    <p className="text-fg">
                      <span className="font-medium">Fix: </span>
                      {errorBreakdown.how}
                    </p>
                  </div>
                </div>
                <details className="ml-5 text-fg-muted">
                  <summary className="cursor-pointer text-2xs uppercase tracking-wide">
                    Technical detail
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-fg-subtle">
                    {data.lastError}
                  </pre>
                </details>
              </dd>
            </div>
          ) : null}
        </dl>

        {/* needs_attention summary — surfaces the new inbox bucket
            (orders rejected at normalization for missing required
            fields) directly in the health card. The merchant sees the
            count and can click through to the inspect panel filtered
            to those rows. Lazy-loaded; absent or 0 count = no extra
            UI noise. */}
        <NeedsAttentionSummary integrationId={integrationId} />

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

        {/* Recovery actions — disabled while paused or system-degraded.
            The intent is "resume first, then act" so a merchant can't
            accidentally enqueue a sync against an integration they
            explicitly told us to ignore. The ControlPanel renders the
            paused banner with a Resume button right below this. */}
        <ActionButtons
          integrationId={integrationId}
          disabled={disabled || !!data.pausedAt}
        />

        {/* Lifecycle controls — pause / resume / safe disconnect.
            Lives in its own panel because the visual + safety
            considerations are different (each goes through a
            confirmation dialog). */}
        <IntegrationControlPanel
          integrationId={integrationId}
          status={data.integrationStatus ?? "connected"}
          pausedAt={data.pausedAt as string | Date | null | undefined}
          pausedReason={data.pausedReason ?? null}
          provider={provider}
          accountKey={data.accountKey ?? accountKey}
        />

        {/* Recent activity log — collapsible to keep the card
            footprint reasonable. Default open since this is the
            single biggest debug surface and the merchant landed on
            this card precisely to investigate. */}
        <details className="group" open>
          <summary className="cursor-pointer list-none border-t border-stroke/8 pt-3 text-2xs uppercase tracking-wide text-fg-muted hover:text-fg">
            <span className="inline-flex items-center gap-1">
              Recent activity
              <span className="text-fg-faint group-open:hidden">▸</span>
              <span className="hidden text-fg-faint group-open:inline">▾</span>
            </span>
          </summary>
          <div className="pt-2">
            <IntegrationLogs integrationId={integrationId} />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

/**
 * Translates the integration's raw `lastError` string into a
 * three-part merchant-readable explanation. Each return value answers:
 *   what — happened (one short sentence, plain language)
 *   why  — caused it (root cause, stripped of jargon where possible)
 *   how  — fix it (one concrete next step the merchant can do today)
 *
 * Order: specific patterns first, generic fallback last. Returning a
 * fully-populated object even for the unknown case keeps the calling
 * JSX simple — no null-safety dance per field.
 */
function classifyHealthError(
  raw: string | null,
): { what: string; why: string; how: string } | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (
    lower.includes("connection error") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("timeout") ||
    lower.includes("network error")
  ) {
    return {
      what: "We can't reach your store.",
      why: "The hostname didn't resolve, the port refused the connection, or the request timed out.",
      how: "Confirm the URL is correct and the server is online, then click Test connection.",
    };
  }
  if (
    lower.includes("invalid api key") ||
    lower.includes("invalid access token") ||
    lower.includes("401") ||
    lower.includes("unauthorized")
  ) {
    return {
      what: "Your store rejected our credentials.",
      why: "The access token was revoked, rotated, or never carried the right scopes.",
      how: "Click Reconnect to re-authenticate the integration.",
    };
  }
  if (lower.includes("scope") || lower.includes("403") || lower.includes("forbidden")) {
    return {
      what: "Your store granted fewer permissions than we asked for.",
      why: "Some endpoints need scopes that weren't approved during the OAuth flow.",
      how: "Reconnect and approve the full scope list when prompted.",
    };
  }
  if (lower.includes("missing customer phone") || lower.includes("missing_phone")) {
    return {
      what: "An order arrived without a customer phone number.",
      why: "Our delivery flow requires phone — your storefront's checkout makes the field optional.",
      how: "Update checkout to require phone, then click Retry failed.",
    };
  }
  if (lower.includes("signature mismatch") || lower.includes("hmac")) {
    return {
      what: "A webhook signature didn't validate.",
      why: "The shared secret is out of sync with the upstream platform.",
      how: "Open the integration, click Rotate webhook secret, and re-paste it in your store.",
    };
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return {
      what: "Your store rate-limited us.",
      why: "Too many requests in a short window — usually transient.",
      how: "Wait a minute and click Sync now to retry. Persistent rate-limits may need a higher API tier on your store.",
    };
  }

  return {
    what: "Last sync didn't complete cleanly.",
    why: "We caught an unexpected response from the upstream platform.",
    how: "Click Test connection. If the test passes, the issue was transient — try Retry failed.",
  };
}

/**
 * Lightweight summary banner for `needs_attention` inbox rows.
 *
 * Deliberately silent in the happy path — the most common state for a
 * healthy integration is "0 needs_attention". To keep payload small we
 * lean on the `recentWebhooks` query that the inspect panel already
 * drives, filtered to needs_attention status. Any non-zero count
 * surfaces a yellow banner that deep-links to the integrations page
 * with the inspect dialog pre-opened on this filter.
 *
 * The banner is presentational only — fixing the underlying issue is
 * a per-row action inside the inspect dialog.
 */
function NeedsAttentionSummary({ integrationId }: { integrationId: string }) {
  // The recentWebhooks query supports a status filter; we use it as a
  // count source. Limiting to 1 is enough — we only need to know
  // whether ANY exist; the modal will paginate the full list.
  const q = trpc.integrations.recentWebhooks.useQuery(
    { integrationId, status: "needs_attention", limit: 50 },
    {
      // Refresh every 2 minutes — these are merchant-action-driven, no
      // need for tight polling.
      refetchInterval: 120_000,
      refetchOnWindowFocus: false,
      // The endpoint may not support the status filter on older
      // deployments; treat its absence as "no needs_attention rows".
      retry: false,
    },
  );

  const items = useMemo(
    () => (Array.isArray(q.data) ? q.data : []),
    [q.data],
  );

  if (q.isLoading || q.isError || items.length === 0) return null;

  // Group by skipReason so the merchant sees the categories rather
  // than a wall of identical lines.
  const byReason = items.reduce<Record<string, number>>((acc, row) => {
    const k = row.skipReason ?? "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const lines = Object.entries(byReason).map(([reason, count]) => ({
    reason,
    count,
    label: NEEDS_ATTENTION_LABELS[reason] ?? "Needs review",
  }));

  return (
    <div className="rounded-md border border-warning/30 bg-warning-subtle p-3 text-xs">
      <div className="flex items-start gap-2 text-warning">
        <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1.5">
          <p className="font-medium">
            {items.length} order{items.length === 1 ? "" : "s"} need
            {items.length === 1 ? "s" : ""} your attention
          </p>
          <ul className="space-y-0.5 text-fg-muted">
            {lines.map((l) => (
              <li key={l.reason}>
                • {l.label}
                <span className="ml-1 text-fg-subtle">({l.count})</span>
              </li>
            ))}
          </ul>
          <a
            href={`/dashboard/integrations?id=${integrationId}&focusInbox=needs_attention`}
            className="inline-flex items-center gap-1 text-warning underline-offset-2 hover:underline"
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            Review and replay
          </a>
        </div>
      </div>
    </div>
  );
}

const NEEDS_ATTENTION_LABELS: Record<string, string> = {
  missing_phone: "Customer phone missing — fix at checkout",
  missing_external_id: "Order ID missing in payload",
  invalid_payload: "Payload structure unrecognized",
};

// `AlertTriangle` is exported from this file by reference for downstream
// consumers — keep this import alive even when no JSX above mentions it.
void AlertTriangle;
