"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  ShieldX,
  Webhook,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useVisibilityInterval } from "@/lib/use-visibility-interval";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Single-pane overview of "is the integration system healthy right now".
 * Surfaces:
 *   - Last inbound webhook (real-time pulse — if this is hours old
 *     for a merchant who normally gets traffic, something's broken)
 *   - Last successful import (the actually-processed pulse — diverging
 *     from "last webhook" means rows are getting stuck mid-pipeline)
 *   - Queue snapshot (how many in each lifecycle state RIGHT NOW)
 *   - Retry status (how many rows are queued for backoff retry, plus
 *     how many gave up — the merchant should never have to dig
 *     through worker logs to find this)
 *   - Integration roster (connected vs paused vs disconnected)
 *
 * Lives in its own component so the dashboard summary tab AND the
 * integrations index page can share a single source of truth.
 *
 * Backed by `integrations.systemStatus` (one $facet aggregate). Polls
 * every 30s on focus so the merchant can see live activity without
 * thinking about it.
 */
export function SystemStatusPanel() {
  // Pause the 30s timer while the tab is hidden — see
  // `useVisibilityInterval` for why this is a net UX-positive.
  const interval = useVisibilityInterval(30_000);
  const q = trpc.integrations.systemStatus.useQuery(undefined, {
    refetchInterval: interval,
    refetchOnWindowFocus: true,
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading system status…
        </CardContent>
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardContent className="py-4 text-xs text-danger">
          Couldn't load system status. Refresh the page or contact support if it
          persists.
        </CardContent>
      </Card>
    );
  }

  const d = q.data;

  // Health heuristic: zero stuck rows + recent webhook activity = green.
  // Anything stuck or no recent activity = yellow. Hard failure
  // surface (everything dead-lettered, no successful import in 24h)
  // would be red — we don't fire it unless evidence is strong because
  // a healthy merchant simply running quietly shouldn't see scary
  // colour.
  const stuckTotal =
    d.queue.needsAttention + d.retry.scheduled + d.retry.deadLettered;
  const lastWebhookFreshMs = d.lastWebhookReceivedAt
    ? Date.now() - new Date(d.lastWebhookReceivedAt).getTime()
    : Infinity;
  const lookingHealthy = stuckTotal === 0 && lastWebhookFreshMs < 24 * 60 * 60_000;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-fg-muted" />
          System status
          {lookingHealthy ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-success/20 bg-success-subtle px-2 py-0.5 text-2xs font-medium text-success">
              <CheckCircle2 className="h-3 w-3" />
              All clear
            </span>
          ) : stuckTotal > 0 ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-warning/20 bg-warning-subtle px-2 py-0.5 text-2xs font-medium text-warning">
              <AlertTriangle className="h-3 w-3" />
              {stuckTotal} item{stuckTotal === 1 ? "" : "s"} need attention
            </span>
          ) : null}
        </CardTitle>
        {d.queue.needsAttention > 0 || d.retry.deadLettered > 0 ? (
          <Link
            href="/dashboard/integrations/issues"
            className="text-xs text-brand underline-offset-2 hover:underline"
          >
            View issues →
          </Link>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Pulse indicators — the two timestamps that matter most to a
            merchant: are deliveries arriving, and are they being
            processed. Diverging values = mid-pipeline stall. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Pulse
            label="Last webhook received"
            timestamp={d.lastWebhookReceivedAt}
            icon={Webhook}
            staleAfterMs={6 * 60 * 60_000} // 6 hours
            staleHint="No deliveries in over 6h. Check storefront webhook config + Test connection."
          />
          <Pulse
            label="Last successful import"
            timestamp={d.lastSuccessfulImportAt}
            icon={CheckCircle2}
            staleAfterMs={24 * 60 * 60_000}
            staleHint="No orders ingested in over 24h. Could be normal for low-volume stores."
          />
        </div>

        {/* Queue snapshot — every status the merchant might care
            about, with subtle colour cues for the unhappy ones. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Awaiting processing" value={d.queue.received + d.queue.processing} />
          <StatTile
            label="Needs attention"
            value={d.queue.needsAttention}
            tone={d.queue.needsAttention > 0 ? "warning" : "default"}
          />
          <StatTile
            label="Retry scheduled"
            value={d.retry.scheduled}
            tone={d.retry.scheduled > 0 ? "warning" : "default"}
          />
          <StatTile
            label="Dead-lettered"
            value={d.retry.deadLettered}
            tone={d.retry.deadLettered > 0 ? "danger" : "default"}
          />
        </div>

        {/* Integration roster — quick take on what's connected vs
            paused vs gone. */}
        <div className="rounded-md border border-stroke/8 bg-surface-raised/40 p-3 text-xs text-fg-muted">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              <strong className="text-fg">{d.integrations.connected}</strong> connected
            </span>
            {d.integrations.paused > 0 ? (
              <span className="text-warning">
                <strong>{d.integrations.paused}</strong> paused
              </span>
            ) : null}
            {d.integrations.disconnected > 0 ? (
              <span className="text-fg-faint">
                <strong>{d.integrations.disconnected}</strong> disconnected
              </span>
            ) : null}
            <span className="text-fg-faint">
              · {d.integrations.total} total
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Single timestamp tile with a "stale" warning when the value is too old. */
function Pulse({
  label,
  timestamp,
  icon: Icon,
  staleAfterMs,
  staleHint,
}: {
  label: string;
  timestamp: Date | string | null;
  icon: typeof Webhook;
  staleAfterMs: number;
  staleHint: string;
}) {
  const ageMs = timestamp ? Date.now() - new Date(timestamp).getTime() : Infinity;
  const stale = ageMs > staleAfterMs;
  const tone = stale ? "border-warning/30 bg-warning-subtle" : "border-stroke/8 bg-surface-raised/40";

  return (
    <div className={`space-y-1 rounded-md border p-3 text-xs ${tone}`}>
      <div className="flex items-center gap-1.5 text-fg-muted">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="text-sm font-medium text-fg">
        {timestamp ? formatRelative(timestamp) : <span className="text-fg-faint">Never</span>}
      </div>
      {timestamp ? (
        <div className="text-2xs text-fg-faint">
          {new Date(timestamp).toLocaleString()}
        </div>
      ) : null}
      {stale && timestamp ? (
        <p className="mt-1 flex items-start gap-1 text-2xs text-warning">
          <Clock className="mt-0.5 h-3 w-3 shrink-0" />
          {staleHint}
        </p>
      ) : null}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "warning" | "danger";
}) {
  const valueClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : "text-fg";
  const Icon = tone === "danger" ? ShieldX : tone === "warning" ? AlertTriangle : null;
  return (
    <div className="space-y-0.5 rounded-md border border-stroke/8 bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1 text-2xs uppercase tracking-wide text-fg-faint">
        {Icon ? <Icon className="h-3 w-3" /> : null}
        {label}
      </div>
      <div className={`text-lg font-semibold ${valueClass}`}>{value.toLocaleString()}</div>
    </div>
  );
}

function formatRelative(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
