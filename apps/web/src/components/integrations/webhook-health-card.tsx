"use client";

import { useMemo } from "react";
import Link from "next/link";
import { CheckCircle2, AlertCircle, Webhook, ArrowRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useVisibilityInterval } from "@/lib/use-visibility-interval";

/**
 * Compact 24-hour webhook delivery summary for the merchant.
 *
 * Composes existing tRPC procedures — no new backend:
 *   - `integrations.recentWebhooks({ limit: 50 })`  → rolling 24h window
 *   - `integrations.systemStatus`                   → inbox status counts
 *
 * Output answers a single trust question:
 *   "Are my webhooks actually getting through right now?"
 *
 * Three render states:
 *   - Healthy   ✓ green pulse + "47 received · 100% succeeded"
 *   - Soft warn ⚠ amber + "1 needs attention" (link to issues)
 *   - Cold      · "no webhooks in the last 24h" (with hint)
 *
 * Failure isolation: every read is best-effort; queries erroring make
 * the card render nothing rather than a confusing half-state. Polling
 * inherits the parent SystemStatusPanel cadence (30s).
 */
export function WebhookHealthCard() {
  // Both queries share the same 60s cadence; pausing while hidden cuts
  // background-tab load in half (this card + the SystemStatusPanel were
  // the two heaviest pollers on the integrations page).
  const interval = useVisibilityInterval(60_000);
  const recent = trpc.integrations.recentWebhooks.useQuery(
    { limit: 50 },
    { refetchInterval: interval, staleTime: 30_000 },
  );
  const status = trpc.integrations.systemStatus.useQuery(undefined, {
    refetchInterval: interval,
    staleTime: 30_000,
  });

  const summary = useMemo(() => {
    if (!recent.data) return null;
    const since = Date.now() - 24 * 60 * 60_000;
    const window24h = recent.data.filter(
      (r) => new Date(r.receivedAt).getTime() >= since,
    );
    const succeeded = window24h.filter((r) => r.status === "succeeded").length;
    const needsAttention = window24h.filter(
      (r) => r.status === "needs_attention",
    ).length;
    const failed = window24h.filter((r) => r.status === "failed").length;
    const total = window24h.length;
    return { total, succeeded, needsAttention, failed };
  }, [recent.data]);

  // Hide the card entirely when we don't have enough data to render
  // a coherent state. Beats showing a bouncing "—" placeholder.
  if (recent.isError || !recent.data) return null;
  if (!summary) return null;
  // No integrations at all → don't render. The first-run ConnectFlow
  // handles that surface; this card has nothing useful to say.
  const total = status.data?.integrations?.total ?? 0;
  if (total === 0) return null;

  const successRate = summary.total > 0
    ? Math.round((summary.succeeded / summary.total) * 100)
    : null;
  const hasIssues = summary.needsAttention > 0 || summary.failed > 0;
  const isCold = summary.total === 0;

  const tone = hasIssues ? "warn" : "ok";

  return (
    <div
      className={
        "flex flex-wrap items-center justify-between gap-4 rounded-xl border px-4 py-3.5 " +
        (tone === "warn"
          ? "border-warning-border bg-warning-subtle/60"
          : "border-stroke/30 bg-surface/60")
      }
    >
      <div className="flex items-center gap-3">
        <span
          className={
            "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full " +
            (tone === "warn"
              ? "bg-warning/15 text-warning"
              : "bg-brand/15 text-brand")
          }
        >
          {tone === "warn" ? (
            <AlertCircle className="h-4 w-4" aria-hidden />
          ) : (
            <Webhook className="h-4 w-4" aria-hidden />
          )}
          {tone === "ok" && !isCold ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 inline-block h-2 w-2 rounded-full bg-brand shadow-[0_0_8px_hsl(var(--brand))]"
            />
          ) : null}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
            Webhook delivery · last 24h
            {tone === "ok" && !isCold ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-success-border/60 bg-success-subtle px-1.5 py-0.5 text-2xs font-medium text-success">
                <CheckCircle2 className="h-2.5 w-2.5" aria-hidden /> Healthy
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-fg-muted">
            {isCold ? (
              <>
                No deliveries in the last 24h. If you&apos;re expecting orders,
                check that your storefront is sending webhooks — Cordon
                replays anything that lands within the retry window.
              </>
            ) : (
              <>
                <strong className="font-mono text-fg">{summary.total}</strong>{" "}
                received
                {successRate !== null ? (
                  <>
                    {" · "}
                    <strong className="font-mono text-fg">{successRate}%</strong>{" "}
                    succeeded
                  </>
                ) : null}
                {summary.needsAttention > 0 ? (
                  <>
                    {" · "}
                    <strong className="font-mono text-warning">
                      {summary.needsAttention}
                    </strong>{" "}
                    need attention
                  </>
                ) : null}
                {summary.failed > 0 ? (
                  <>
                    {" · "}
                    <strong className="font-mono text-danger">
                      {summary.failed}
                    </strong>{" "}
                    failed
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
      {hasIssues ? (
        <Link
          href="/dashboard/integrations/issues"
          className="inline-flex items-center gap-1.5 rounded-md border border-warning-border bg-warning text-bg px-3 py-1.5 text-xs font-semibold hover:bg-warning/90"
        >
          Review issues <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      ) : null}
    </div>
  );
}
