"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCircle2, ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useVisibilityInterval } from "@/lib/use-visibility-interval";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * "How much of my plan am I using" panel for the billing page.
 *
 * Three jobs:
 *   1. Show current usage vs limit for every metered resource — orders
 *      created, shipments booked, fraud reviews, call minutes — using
 *      data already returned by `billing.getUsage`. The endpoint
 *      already classifies each meter as `warning` (>=80%) or
 *      `blocked` (>=100%); we just render it.
 *   2. Show "integrations active vs cap" using `integrations.getEntitlements`
 *      — the only meter that doesn't reset monthly.
 *   3. Surface a single, prominent upgrade CTA when ANY meter is at or
 *      near its cap. The merchant should never have to assemble that
 *      conclusion themselves from individual progress bars.
 *
 * Pure presentational — no state of its own. Re-renders on tRPC
 * cache invalidation so any inbound webhook bumping the order count
 * is reflected within seconds.
 */

const METRIC_LABELS: Record<string, string> = {
  ordersCreated: "Orders processed",
  shipmentsBooked: "Shipments booked",
  fraudReviewsUsed: "Fraud reviews",
  callsInitiated: "Calls initiated",
  callMinutesUsed: "Call minutes used",
};

export function UsageOverview() {
  const interval = useVisibilityInterval(60_000);
  const usage = trpc.billing.getUsage.useQuery(undefined, {
    refetchInterval: interval,
  });
  const ent = trpc.integrations.getEntitlements.useQuery();

  const meters = (usage.data?.meters ?? []) as Array<{
    metric: string;
    used: number;
    limit: number | null;
    ratio: number;
    warning: boolean;
    blocked: boolean;
  }>;

  const integrationsView = ent.data
    ? {
        used: ent.data.activeIntegrationCount ?? 0,
        cap: ent.data.maxIntegrations ?? 0,
      }
    : null;

  // Worst-case across all meters drives the global banner — if anything
  // is blocked we show a hard block; otherwise if anything is in the
  // warning range we show a soft warning.
  const blocked = meters.some((m) => m.blocked) ||
    (integrationsView !== null && integrationsView.cap > 0 && integrationsView.used >= integrationsView.cap);
  const warning = meters.some((m) => m.warning) ||
    (integrationsView !== null && integrationsView.cap > 0 && integrationsView.used >= integrationsView.cap * 0.8);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Usage this period</CardTitle>
        {blocked ? (
          <Button asChild size="sm" variant="destructive">
            <Link href="/pricing">
              <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
              Upgrade now
            </Link>
          </Button>
        ) : warning ? (
          <Button asChild size="sm" variant="secondary">
            <Link href="/pricing">
              <ArrowUpRight className="mr-1.5 h-3.5 w-3.5" />
              Plan options
            </Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Top banner — only fires when something needs attention, so
            the happy path is calm. The blocked banner takes priority
            over the warning banner because exhausted quotas are a
            harder problem than approaching ones. */}
        {blocked ? (
          <Banner
            tone="danger"
            title="You've hit a plan limit."
            body="New orders or actions on the maxed-out resource will be rejected until you upgrade or the next billing period starts."
          />
        ) : warning ? (
          <Banner
            tone="warning"
            title="You're at 80%+ of one or more limits."
            body="Plan ahead — upgrading now keeps ingestion uninterrupted."
          />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {meters.map((m) => (
            <Meter
              key={m.metric}
              label={METRIC_LABELS[m.metric] ?? m.metric}
              used={m.used}
              limit={m.limit}
              ratio={m.ratio}
              tone={m.blocked ? "danger" : m.warning ? "warning" : "default"}
            />
          ))}
          {integrationsView ? (
            <Meter
              label="Active integrations"
              used={integrationsView.used}
              limit={integrationsView.cap}
              ratio={
                integrationsView.cap > 0
                  ? Math.min(1, integrationsView.used / integrationsView.cap)
                  : 0
              }
              tone={
                integrationsView.cap > 0 &&
                integrationsView.used >= integrationsView.cap
                  ? "danger"
                  : integrationsView.cap > 0 &&
                      integrationsView.used >= integrationsView.cap * 0.8
                    ? "warning"
                    : "default"
              }
            />
          ) : null}
        </div>

        {usage.data?.lastActivityAt ? (
          <p className="text-2xs text-fg-faint">
            Last activity {new Date(usage.data.lastActivityAt).toLocaleString()}.
            Billing period: {usage.data.period}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Meter({
  label,
  used,
  limit,
  ratio,
  tone,
}: {
  label: string;
  used: number;
  limit: number | null;
  ratio: number;
  tone: "default" | "warning" | "danger";
}) {
  const pct = Math.round(Math.min(1, ratio) * 100);
  const remaining = limit === null ? null : Math.max(0, limit - used);
  const barClass =
    tone === "danger"
      ? "bg-danger"
      : tone === "warning"
        ? "bg-warning"
        : "bg-brand";
  const labelTone =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : "text-fg";

  return (
    <div className="space-y-1.5 rounded-md border border-stroke/8 bg-surface-raised/40 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-fg-muted">{label}</span>
        <span className={`text-xs font-medium ${labelTone}`}>
          {limit === null ? (
            <>
              <strong>{used.toLocaleString()}</strong> used · unlimited
            </>
          ) : (
            <>
              <strong>{used.toLocaleString()}</strong> /{" "}
              {limit.toLocaleString()}
            </>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
        <div
          className={`h-1.5 rounded-full transition-all ${barClass}`}
          style={{ width: `${pct}%` }}
          aria-label={`${pct}% used`}
        />
      </div>
      {remaining !== null ? (
        <p className="text-2xs text-fg-faint">
          {remaining > 0 ? (
            <>{remaining.toLocaleString()} remaining</>
          ) : (
            <span className="text-danger">Limit reached — upgrade to continue.</span>
          )}
        </p>
      ) : null}
    </div>
  );
}

function Banner({
  tone,
  title,
  body,
}: {
  tone: "warning" | "danger";
  title: string;
  body: string;
}) {
  const cls =
    tone === "danger"
      ? "border-danger/30 bg-danger-subtle text-danger"
      : "border-warning/30 bg-warning-subtle text-warning";
  const Icon = tone === "danger" ? ShieldAlert : AlertTriangle;
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-xs ${cls}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-fg-muted">{body}</p>
      </div>
    </div>
  );
}

// Standalone success indicator for callers that want to render a
// "you're well within limits" affirmation. Not used inside this
// component (we hide the banner entirely on the happy path), but
// exported so the dashboard summary widget can lean on it.
export function HealthyUsageBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success-subtle px-2.5 py-0.5 text-2xs font-medium text-success">
      <CheckCircle2 className="h-3 w-3" />
      Within limits
    </span>
  );
}
