"use client";

import Link from "next/link";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  PhoneOff,
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
 * Fraud overview — three-panel layout:
 *   1. KPI band: open queue depth, 24h decisions, 7d level distribution.
 *   2. 7-day distribution chart so trends are obvious at a glance.
 *   3. Recent decision feed (verified / rejected / no_answer) pulled from
 *      the audit log so the page stays read-only and we get diff history.
 *
 * No mutations — fraud override happens on the merchant-facing fraud
 * review page (with support_admin scope + step-up on the admin path).
 */
export default function AdminFraudOverviewPage() {
  const overview = trpc.adminObservability.fraudOverview.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const recentDecisions = trpc.adminAudit.search.useQuery(
    { action: "review.verified", limit: 25 },
    { refetchInterval: 60_000 },
  );
  const recentRejects = trpc.adminAudit.search.useQuery(
    { action: "review.rejected", limit: 25 },
    { refetchInterval: 60_000 },
  );
  const recentNoAnswer = trpc.adminAudit.search.useQuery(
    { action: "review.no_answer", limit: 25 },
    { refetchInterval: 60_000 },
  );

  const byLevel = overview.data?.last7dByLevel ?? {};
  const chartData = [
    { level: "low", count: byLevel.low ?? 0, fill: "hsl(160 84% 45%)" },
    { level: "medium", count: byLevel.medium ?? 0, fill: "hsl(38 92% 55%)" },
    { level: "high", count: byLevel.high ?? 0, fill: "hsl(0 84% 66%)" },
  ];

  const verified = recentDecisions.data?.rows ?? [];
  const rejected = recentRejects.data?.rows ?? [];
  const noAnswer = recentNoAnswer.data?.rows ?? [];
  const totalDecisions7d =
    (byLevel.low ?? 0) + (byLevel.medium ?? 0) + (byLevel.high ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin · Fraud"
        title="Fraud overview"
        description="High-risk queue, decisioning velocity, and 7-day risk-level mix."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Open high-risk"
          value={overview.data?.openHighRisk ?? "—"}
          icon={ShieldAlert}
          tone="danger"
          loading={overview.isLoading}
          footer="pending_call + no_answer"
        />
        <StatCard
          label="Decisions (24h)"
          value={overview.data?.decisionsLast24h ?? "—"}
          icon={Activity}
          tone="info"
          loading={overview.isLoading}
        />
        <StatCard
          label="Orders flagged (7d)"
          value={byLevel.high ?? "—"}
          icon={AlertTriangle}
          tone="warning"
          loading={overview.isLoading}
          footer={`${totalDecisions7d} total`}
        />
        <StatCard
          label="High-risk share"
          value={
            totalDecisions7d > 0
              ? `${(((byLevel.high ?? 0) / totalDecisions7d) * 100).toFixed(0)}%`
              : "—"
          }
          icon={ShieldCheck}
          tone="violet"
          loading={overview.isLoading}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Risk distribution — last 7 days</CardTitle>
        </CardHeader>
        <CardContent>
          {totalDecisions7d === 0 ? (
            <div className="py-10 text-center text-sm text-fg-subtle">
              No orders scored in this window.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 12, right: 12, bottom: 0, left: 0 }}
                >
                  <XAxis
                    dataKey="level"
                    tick={{ fontSize: 11, fill: "rgb(156 163 175)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "rgb(156 163 175)" }}
                    tickLine={false}
                    axisLine={false}
                    width={32}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.05)" }}
                    contentStyle={{
                      background: "rgb(17 19 24)",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <DecisionFeed
          icon={CheckCircle2}
          tone="success"
          title="Recently verified"
          rows={verified}
          loading={recentDecisions.isLoading}
        />
        <DecisionFeed
          icon={Ban}
          tone="danger"
          title="Recently rejected"
          rows={rejected}
          loading={recentRejects.isLoading}
        />
        <DecisionFeed
          icon={PhoneOff}
          tone="warning"
          title="No answer"
          rows={noAnswer}
          loading={recentNoAnswer.isLoading}
        />
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-fg-subtle">
          <span>
            Decisions are sourced from the immutable audit log. Drill into a
            specific order via{" "}
            <Link
              href="/admin/audit?action=review."
              className="text-brand hover:underline"
            >
              the audit explorer
            </Link>
            .
          </span>
          <span>Auto-refresh: 60s</span>
        </CardContent>
      </Card>
    </div>
  );
}

interface DecisionRow {
  id: string;
  actorEmail: string | null;
  subjectId: string;
  at: Date | string;
  meta?: unknown;
}

function DecisionFeed({
  icon: Icon,
  tone,
  title,
  rows,
  loading,
}: {
  icon: typeof CheckCircle2;
  tone: "success" | "danger" | "warning";
  title: string;
  rows: DecisionRow[];
  loading: boolean;
}) {
  const headerClass =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-danger"
        : "text-warning";
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className={`flex items-center gap-2 text-sm ${headerClass}`}>
          <Icon className="h-4 w-4" />
          {title}
          <span className="ml-auto rounded-md bg-surface-raised px-2 py-0.5 text-2xs font-mono text-fg-subtle">
            {rows.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 pt-0">
        {loading ? (
          <p className="py-6 text-center text-sm text-fg-subtle">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-subtle">
            None in window.
          </p>
        ) : (
          rows.slice(0, 8).map((r) => (
            <div
              key={r.id}
              className="flex items-start justify-between gap-2 rounded-md border border-stroke/8 px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-2xs text-fg-subtle">
                  {r.actorEmail ?? "—"}
                </div>
                <div className="font-mono text-2xs text-fg-faint">
                  order:{String(r.subjectId).slice(-8)}
                </div>
              </div>
              <span className="shrink-0 text-2xs text-fg-faint">
                {formatDateTime(r.at)}
              </span>
            </div>
          ))
        )}
        {rows.length > 8 ? (
          <Link
            href={`/admin/audit?action=${title.toLowerCase().includes("verified") ? "review.verified" : title.toLowerCase().includes("rejected") ? "review.rejected" : "review.no_answer"}`}
            className="block pt-2 text-center text-xs text-brand hover:underline"
          >
            View all {rows.length} →
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

