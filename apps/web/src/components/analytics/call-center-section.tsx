"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  PhoneCall,
  PhoneMissed,
  Timer,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { Heading } from "@/components/ui/heading";
import { formatDuration, formatRelative } from "@/lib/formatters";

export function CallCenterSection() {
  const analytics = trpc.callCenter.getCallAnalytics.useQuery({ days: 30 });
  const logs = trpc.callCenter.getCallLogs.useQuery({
    limit: 10,
    callType: "all",
    cursor: null,
  });

  const a = analytics.data;
  const calls = logs.data?.calls ?? [];
  const loading = analytics.isLoading;

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between">
        <div className="space-y-0.5">
          <Heading level="section">Call center</Heading>
          <p className="text-xs text-fg-subtle">Last 30 days</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Calls (30d)"
          value={loading ? "—" : (a?.totalCalls ?? 0).toLocaleString()}
          icon={PhoneCall}
          tone="brand"
          footer={a ? `${a.answeredCalls} answered` : undefined}
          loading={loading}
        />
        <StatCard
          label="Answer rate"
          value={loading ? "—" : `${a?.answerRate ?? 0}%`}
          icon={CheckCircle2}
          tone="success"
          footer={a && a.successRate > 0 ? `${a.successRate}% conversion` : undefined}
          loading={loading}
        />
        <StatCard
          label="Avg duration"
          value={loading ? "—" : formatDuration(a?.avgDurationSeconds ?? 0)}
          icon={Timer}
          tone="violet"
          footer={
            a && a.totalDurationSeconds > 0
              ? `${Math.round(a.totalDurationSeconds / 60)}m total`
              : undefined
          }
          loading={loading}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base font-semibold">Recent calls</CardTitle>
            <CardDescription>Last {calls.length || 0} entries</CardDescription>
          </div>
          {logs.isLoading ? null : (
            <span className="text-xs text-fg-subtle">
              {calls.length === 0 ? "No calls yet" : `Showing ${calls.length}`}
            </span>
          )}
        </CardHeader>
        <CardContent>
          {logs.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-14 animate-shimmer rounded-md" />
              ))}
            </div>
          ) : calls.length === 0 ? (
            <EmptyState
              icon={PhoneCall}
              title="No calls logged yet"
              description="Log calls via the call center tool to populate this list."
              className="border-0 bg-transparent"
            />
          ) : (
            <ul className="divide-y divide-stroke/8">
              {calls.map((call) => {
                const direction =
                  call.callType === "outgoing" ? (
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  ) : call.callType === "incoming" ? (
                    <ArrowDownLeft className="h-3.5 w-3.5" />
                  ) : null;
                const MissedIcon = call.answered ? PhoneCall : PhoneMissed;
                return (
                  <li
                    key={call.id}
                    className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <span
                      className={
                        call.answered
                          ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-success-subtle text-success"
                          : "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-danger-subtle text-danger"
                      }
                    >
                      <MissedIcon className="h-4 w-4" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm text-fg">
                          {call.customerPhone ?? "Unknown"}
                        </span>
                        {direction ? (
                          <span className="inline-flex items-center gap-0.5 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                            {direction}
                            {call.callType}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-subtle">
                        <span>{formatRelative(call.timestamp)}</span>
                        <span className="text-fg-faint">·</span>
                        <span>{formatDuration(call.duration)}</span>
                        {call.deliveryStatus ? (
                          <>
                            <span className="text-fg-faint">·</span>
                            <span className="capitalize">{call.deliveryStatus}</span>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <Badge
                      variant="outline"
                      className={
                        call.answered
                          ? call.successful === false
                            ? "border-transparent bg-warning-subtle text-warning"
                            : "border-transparent bg-success-subtle text-success"
                          : "border-transparent bg-danger-subtle text-danger"
                      }
                    >
                      {call.answered
                        ? call.successful === false
                          ? "Unresolved"
                          : "Answered"
                        : "Missed"}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
