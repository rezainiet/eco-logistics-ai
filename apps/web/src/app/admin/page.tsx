"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  CreditCard,
  History,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/formatters";

/**
 * Operations dashboard — the landing pane an on-call admin sees first.
 *
 * Layout:
 *   - Identity strip: who you are + which scopes you hold (drives nav).
 *   - 6-up KPI band: queue backlog, queue failures, webhook fails (1h),
 *     fraud queue depth, payment approval rate (7d), suspicious payments.
 *   - Two side-by-side activity feeds: recent admin actions (audit trail)
 *     and recent fired alerts (anomaly engine output).
 *
 * Read-only — every admin sees this; mutations live on the dedicated pages.
 */
export default function AdminHomePage() {
  const me = trpc.adminAccess.whoami.useQuery();
  const sys = trpc.adminObservability.systemHealth.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const fraud = trpc.adminObservability.fraudOverview.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const payments = trpc.adminObservability.paymentOverview.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const recentAdminActivity = trpc.adminAudit.search.useQuery(
    { actorType: "admin", limit: 10 },
    { refetchInterval: 60_000 },
  );
  const recentAlerts = trpc.adminAudit.search.useQuery(
    { action: "alert.fired", limit: 5 },
    { refetchInterval: 60_000 },
  );

  const scopes = me.data?.scopes ?? [];
  const approvalRate7d = payments.data?.approvalRate7d ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Operations dashboard"
        description="Live queue, payment, and fraud signals across the platform."
      />

      {/* Who am I */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-fg-subtle" /> Your access
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-0">
          <div className="text-sm">
            <span className="text-fg-subtle">Signed in as </span>
            <span className="font-medium text-fg">{me.data?.email ?? "—"}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {scopes.length === 0 ? (
              <Badge className="bg-surface-raised text-fg-faint">
                read-only (no scopes)
              </Badge>
            ) : (
              scopes.map((s) => (
                <Badge key={s} className="bg-info-subtle text-info">
                  {s}
                </Badge>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* KPI band */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Queue backlog"
          value={sys.data?.totals.backlog ?? "—"}
          icon={Activity}
          tone="info"
          loading={sys.isLoading}
          footer={`${sys.data?.totals.active ?? 0} active`}
        />
        <StatCard
          label="Failed jobs"
          value={sys.data?.totals.failed ?? "—"}
          icon={AlertTriangle}
          tone={
            (sys.data?.totals.failed ?? 0) > 0 ? "danger" : "success"
          }
          loading={sys.isLoading}
        />
        <StatCard
          label="Webhook fails (1h)"
          value={sys.data?.webhooks.failedLast1h ?? "—"}
          icon={ShieldAlert}
          tone={
            (sys.data?.webhooks.failedLast1h ?? 0) > 0 ? "warning" : "success"
          }
          loading={sys.isLoading}
        />
        <StatCard
          label="Open high-risk"
          value={fraud.data?.openHighRisk ?? "—"}
          icon={ShieldAlert}
          tone="violet"
          loading={fraud.isLoading}
          footer={`${fraud.data?.decisionsLast24h ?? 0} decisions in 24h`}
        />
        <StatCard
          label="Approval rate (7d)"
          value={
            payments.data
              ? `${(approvalRate7d * 100).toFixed(0)}%`
              : "—"
          }
          icon={CheckCircle2}
          tone="success"
          loading={payments.isLoading}
        />
        <StatCard
          label="Suspicious payments"
          value={payments.data?.suspiciousCount ?? "—"}
          icon={CreditCard}
          tone={
            (payments.data?.suspiciousCount ?? 0) > 0 ? "danger" : "success"
          }
          loading={payments.isLoading}
          footer={`${payments.data?.pendingDualApproval ?? 0} pending dual approval`}
        />
      </div>

      {/* Activity feeds */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4 text-fg-subtle" /> Recent admin
              activity
            </CardTitle>
            <Link
              href="/admin/audit?actorType=admin"
              className="text-xs text-brand hover:underline"
            >
              View all →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {recentAdminActivity.isLoading ? (
              <FeedSkeleton rows={5} />
            ) : (recentAdminActivity.data?.rows ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-fg-subtle">
                No admin activity in window.
              </p>
            ) : (
              (recentAdminActivity.data?.rows ?? []).map((r) => (
                <div
                  key={r.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-stroke/8 bg-surface-raised/40 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="text-xs font-medium text-fg">
                        {r.action}
                      </code>
                      {r.actorScope ? (
                        <Badge className="bg-info-subtle text-info text-2xs">
                          {r.actorScope}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-2xs text-fg-subtle">
                      {r.actorEmail ?? "—"} ·{" "}
                      <span className="font-mono">
                        {r.subjectType}:{String(r.subjectId).slice(-8)}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-2xs text-fg-faint">
                    <Clock className="mr-0.5 inline h-2.5 w-2.5" />
                    {formatDateTime(r.at)}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning" /> Recent alerts
            </CardTitle>
            <Link
              href="/admin/alerts"
              className="text-xs text-brand hover:underline"
            >
              View all →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {recentAlerts.isLoading ? (
              <FeedSkeleton rows={3} />
            ) : (recentAlerts.data?.rows ?? []).length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                <ShieldCheck className="h-6 w-6 text-success" />
                <p className="text-sm text-fg-subtle">
                  No alerts firing — all clear.
                </p>
              </div>
            ) : (
              (recentAlerts.data?.rows ?? []).map((r) => {
                const meta = (r.meta ?? {}) as {
                  kind?: string;
                  severity?: string;
                  message?: string;
                  shortCount?: number;
                };
                return (
                  <div
                    key={r.id}
                    className="rounded-md border border-warning/20 bg-warning-subtle/30 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          className={
                            meta.severity === "critical"
                              ? "bg-danger-subtle text-danger"
                              : "bg-warning-subtle text-warning"
                          }
                        >
                          {meta.kind ?? "alert"}
                        </Badge>
                        {meta.shortCount !== undefined ? (
                          <span className="font-mono text-xs text-fg">
                            {meta.shortCount}/h
                          </span>
                        ) : null}
                      </div>
                      <span className="text-2xs text-fg-faint">
                        {formatDateTime(r.at)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-fg-muted">
                      {meta.message ?? "(no message)"}
                    </p>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FeedSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex animate-shimmer rounded-md border border-stroke/8 bg-surface-raised/40 px-3 py-2"
        >
          <div className="h-8 w-full" />
        </div>
      ))}
    </>
  );
}
