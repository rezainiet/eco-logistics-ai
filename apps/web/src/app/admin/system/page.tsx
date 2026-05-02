"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Server,
  Webhook,
  Zap,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/formatters";

/**
 * System health — queue counters + recent webhook failures. Auto-refreshes
 * every 15s so a regression appears within one tick. Each queue gets a
 * health verdict computed client-side from the counters: failed > 0 is
 * always at least "degraded"; waiting > active * 10 is "backed_up".
 */

type QueueHealth = "healthy" | "degraded" | "backed_up" | "errored";

function classifyQueue(q: {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  error: string | null;
}): { state: QueueHealth; reason: string } {
  if (q.error) return { state: "errored", reason: q.error };
  if (q.failed > 0) {
    return {
      state: "degraded",
      reason: `${q.failed} failed in retention window`,
    };
  }
  if (q.waiting > Math.max(20, q.active * 10)) {
    return { state: "backed_up", reason: `${q.waiting} waiting` };
  }
  return { state: "healthy", reason: "ok" };
}

const HEALTH_BADGE: Record<QueueHealth, { label: string; className: string }> = {
  healthy: {
    label: "healthy",
    className: "bg-success-subtle text-success",
  },
  degraded: {
    label: "degraded",
    className: "bg-warning-subtle text-warning",
  },
  backed_up: {
    label: "backed up",
    className: "bg-warning-subtle text-warning",
  },
  errored: {
    label: "errored",
    className: "bg-danger-subtle text-danger",
  },
};

export default function AdminSystemPage() {
  const sys = trpc.adminObservability.systemHealth.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const failures = trpc.adminObservability.recentWebhookFailures.useQuery(
    { limit: 50 },
    { refetchInterval: 30_000 },
  );

  const queues = sys.data?.queues ?? [];
  const queueHealthCounts = queues.reduce(
    (acc, q) => {
      const verdict = classifyQueue(q);
      acc[verdict.state]++;
      return acc;
    },
    { healthy: 0, degraded: 0, backed_up: 0, errored: 0 } as Record<
      QueueHealth,
      number
    >,
  );
  const overallTone =
    queueHealthCounts.errored > 0
      ? "danger"
      : queueHealthCounts.degraded > 0 || queueHealthCounts.backed_up > 0
        ? "warning"
        : "success";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin · Operations"
        title="System health"
        description="BullMQ queue depth, failed jobs, and recent webhook delivery health."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              sys.refetch();
              failures.refetch();
            }}
            disabled={sys.isFetching || failures.isFetching}
          >
            <RefreshCw
              className={`mr-1 h-3 w-3 ${
                sys.isFetching ? "animate-spin" : ""
              }`}
            />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total backlog"
          value={sys.data?.totals.backlog ?? "—"}
          icon={Activity}
          tone={overallTone === "success" ? "info" : overallTone}
          loading={sys.isLoading}
          footer={`${queues.length} queues`}
        />
        <StatCard
          label="Active jobs"
          value={sys.data?.totals.active ?? "—"}
          icon={Zap}
          tone="brand"
          loading={sys.isLoading}
        />
        <StatCard
          label="Failed jobs"
          value={sys.data?.totals.failed ?? "—"}
          icon={AlertTriangle}
          tone={(sys.data?.totals.failed ?? 0) > 0 ? "danger" : "success"}
          loading={sys.isLoading}
          footer="across retention window"
        />
        <StatCard
          label="Webhook fails (1h)"
          value={sys.data?.webhooks.failedLast1h ?? "—"}
          icon={Webhook}
          tone={
            (sys.data?.webhooks.failedLast1h ?? 0) > 0 ? "warning" : "success"
          }
          loading={sys.isLoading}
          footer={`${sys.data?.webhooks.failedLast24h ?? 0} in 24h`}
        />
      </div>

      {/* Health summary band */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 py-3 text-sm">
          <Server className="h-4 w-4 text-fg-subtle" />
          <span className="font-medium text-fg">Queue health summary</span>
          <span className="flex items-center gap-1.5 text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span className="font-mono">{queueHealthCounts.healthy}</span>{" "}
            healthy
          </span>
          {queueHealthCounts.backed_up > 0 ? (
            <span className="flex items-center gap-1.5 text-warning">
              <Clock className="h-3.5 w-3.5" />
              <span className="font-mono">{queueHealthCounts.backed_up}</span>{" "}
              backed up
            </span>
          ) : null}
          {queueHealthCounts.degraded > 0 ? (
            <span className="flex items-center gap-1.5 text-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="font-mono">{queueHealthCounts.degraded}</span>{" "}
              degraded
            </span>
          ) : null}
          {queueHealthCounts.errored > 0 ? (
            <span className="flex items-center gap-1.5 text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span className="font-mono">{queueHealthCounts.errored}</span>{" "}
              errored
            </span>
          ) : null}
          <span className="ml-auto text-xs text-fg-subtle">
            Auto-refresh: 15s
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Queues</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="-mx-5 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-stroke/8 bg-surface-raised/40">
                  <TableHead>Queue</TableHead>
                  <TableHead className="text-right">Waiting</TableHead>
                  <TableHead className="text-right">Active</TableHead>
                  <TableHead className="text-right">Delayed</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sys.isLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={6}>
                        <div className="h-4 animate-shimmer rounded" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : queues.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-8 text-center text-fg-subtle"
                    >
                      No queue data — Redis may be offline.
                    </TableCell>
                  </TableRow>
                ) : (
                  queues.map((q) => {
                    const verdict = classifyQueue(q);
                    const badge = HEALTH_BADGE[verdict.state];
                    return (
                      <TableRow key={q.name} className="border-stroke/6">
                        <TableCell className="font-mono text-xs">
                          {q.name}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {q.waiting}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {q.active}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {q.delayed}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono ${
                            q.failed > 0 ? "text-danger" : ""
                          }`}
                        >
                          {q.failed}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Badge className={badge.className}>
                              {badge.label}
                            </Badge>
                            {verdict.state !== "healthy" ? (
                              <span
                                className="text-2xs text-fg-faint"
                                title={verdict.reason}
                              >
                                {verdict.reason}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent webhook failures</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="-mx-5 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-stroke/8 bg-surface-raised/40">
                  <TableHead>When</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>External ID</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failures.isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}>
                        <div className="h-4 animate-shimmer rounded" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : (failures.data ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-fg-subtle"
                    >
                      <CheckCircle2 className="mx-auto mb-2 h-5 w-5 text-success" />
                      No failures in window.
                    </TableCell>
                  </TableRow>
                ) : (
                  (failures.data ?? []).map((f) => (
                    <TableRow key={f.id} className="border-stroke/6">
                      <TableCell className="text-xs text-fg-subtle">
                        {formatDateTime(f.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-info-subtle text-info">
                          {f.provider}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className="font-mono text-2xs"
                        title={f.externalId}
                      >
                        {f.externalId.length > 24
                          ? `${f.externalId.slice(0, 24)}…`
                          : f.externalId}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono ${
                          f.attempts >= 3 ? "text-danger" : ""
                        }`}
                      >
                        {f.attempts}
                      </TableCell>
                      <TableCell
                        className="max-w-md truncate text-xs text-danger"
                        title={f.lastError ?? ""}
                      >
                        {f.lastError ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
