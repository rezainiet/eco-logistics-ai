"use client";

import { useMemo } from "react";
import {
  AlertOctagon,
  Check,
  CircleDot,
  Clock,
  Loader2,
  ShieldX,
  Webhook,
} from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * Compact "what's been happening" stream for one integration. Builds
 * on top of `recentWebhooks` (already shipped) — converts each row
 * into one or more timeline entries:
 *
 *   - "Webhook received"   when a row exists
 *   - "Processed → ok"     on succeeded rows
 *   - "Failed: <reason>"   on failed/needs_attention rows
 *   - "Retry scheduled"    when nextRetryAt is in the future
 *
 * Designed to fit inside the integration health card without adding
 * scroll noise: capped at 10 rows by default, dependency-free relative
 * timestamps, no virtualization needed.
 */
export function IntegrationLogs({
  integrationId,
  limit = 10,
}: {
  integrationId: string;
  limit?: number;
}) {
  const q = trpc.integrations.recentWebhooks.useQuery(
    { integrationId, limit },
    {
      // 30s poll matches the ingestion cadence — tighter would just
      // pound the inbox query without the merchant noticing change.
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  );

  const rows = useMemo(
    () => (Array.isArray(q.data) ? q.data : []),
    [q.data],
  );

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-2xs text-fg-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading recent activity…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-stroke/8 bg-surface-raised/40 px-3 py-2 text-2xs text-fg-subtle">
        No webhooks recorded yet. Place a test order or click <strong>Sync now</strong>.
      </p>
    );
  }

  return (
    <ol className="space-y-2 text-2xs">
      {rows.map((r) => (
        <LogEntry key={r.id} row={r} />
      ))}
    </ol>
  );
}

type Row = {
  id: string;
  topic: string;
  externalId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  receivedAt: Date | string;
  processedAt: Date | string | null;
  nextRetryAt: Date | string | null;
};

function LogEntry({ row }: { row: Row }) {
  // Pick a primary visual — ordering matters: a row that's failed
  // should look failed even if it has a nextRetryAt scheduled. We
  // map `status` to icon + accent + summary line here.
  const view = describeRow(row);
  const Icon = view.icon;
  return (
    <li className="flex items-start gap-2">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${view.tone}`} />
      <div className="flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium text-fg">{view.title}</span>
          <time
            className="text-2xs text-fg-faint"
            dateTime={String(row.receivedAt)}
            title={new Date(row.receivedAt).toLocaleString()}
          >
            {formatRelative(row.receivedAt)}
          </time>
        </div>
        <p className="text-fg-muted">
          {row.topic}
          <span className="ml-1 font-mono text-fg-subtle">id: {row.externalId}</span>
          {row.attempts > 1 ? (
            <span className="ml-1 text-fg-faint">· {row.attempts} attempt{row.attempts === 1 ? "" : "s"}</span>
          ) : null}
        </p>
        {view.detail ? <p className="text-fg-subtle">{view.detail}</p> : null}
      </div>
    </li>
  );
}

function describeRow(row: Row): {
  title: string;
  icon: typeof CircleDot;
  tone: string;
  detail: string | null;
} {
  if (row.status === "succeeded") {
    return {
      title: "Webhook processed",
      icon: Check,
      tone: "text-success",
      detail: row.lastError === "duplicate (idempotent)" ? "Duplicate event — no new order created." : null,
    };
  }
  if (row.status === "needs_attention") {
    return {
      title: "Needs attention",
      icon: ShieldX,
      tone: "text-warning",
      detail: row.lastError ?? "Adapter rejected the payload.",
    };
  }
  if (row.status === "failed") {
    return {
      title: row.nextRetryAt ? "Retry scheduled" : "Delivery failed",
      icon: AlertOctagon,
      tone: "text-danger",
      detail:
        row.lastError ??
        (row.nextRetryAt
          ? `Will retry at ${new Date(row.nextRetryAt).toLocaleTimeString()}`
          : null),
    };
  }
  if (row.status === "received") {
    return {
      title: "Webhook received",
      icon: Webhook,
      tone: "text-fg-muted",
      detail: "Awaiting worker pickup.",
    };
  }
  if (row.status === "processing") {
    return {
      title: "Processing",
      icon: Clock,
      tone: "text-fg-muted",
      detail: null,
    };
  }
  return {
    title: row.status,
    icon: CircleDot,
    tone: "text-fg-muted",
    detail: row.lastError ?? null,
  };
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
