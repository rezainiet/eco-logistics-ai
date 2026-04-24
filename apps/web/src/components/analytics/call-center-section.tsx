"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  PhoneCall,
  PhoneMissed,
  Timer,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function Metric({
  label,
  value,
  icon: Icon,
  sub,
  accent,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  sub?: string;
  accent: string;
}) {
  return (
    <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-[0.4px] text-[#9CA3AF]">
          {label}
        </CardTitle>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${accent}22` }}
        >
          <Icon className="h-4 w-4" style={{ color: accent }} />
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-2xl font-semibold text-[#F3F4F6]">{value}</p>
        {sub ? <p className="text-xs text-[#9CA3AF]">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

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

  const metrics = [
    {
      label: "Calls (30d)",
      value: loading ? "…" : (a?.totalCalls ?? 0).toLocaleString(),
      icon: PhoneCall,
      sub: a ? `${a.answeredCalls} answered` : undefined,
      accent: "#0084D4",
    },
    {
      label: "Answer rate",
      value: loading ? "…" : `${a?.answerRate ?? 0}%`,
      icon: CheckCircle2,
      sub: a && a.successRate > 0 ? `${a.successRate}% conversion` : undefined,
      accent: "#10B981",
    },
    {
      label: "Avg duration",
      value: loading ? "…" : formatDuration(a?.avgDurationSeconds ?? 0),
      icon: Timer,
      sub:
        a && a.totalDurationSeconds > 0
          ? `${Math.round(a.totalDurationSeconds / 60)}m total`
          : undefined,
      accent: "#8B5CF6",
    },
  ];

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[#F3F4F6]">Call Center</h2>
          <p className="mt-0.5 text-sm text-[#9CA3AF]">Last 30 days</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {metrics.map((m) => (
          <Metric
            key={m.label}
            label={m.label}
            value={m.value}
            icon={m.icon}
            sub={m.sub}
            accent={m.accent}
          />
        ))}
      </div>

      <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-lg font-semibold">Recent calls</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              Last {calls.length || 0} entries
            </CardDescription>
          </div>
          {logs.isLoading ? null : (
            <span className="text-xs text-[#9CA3AF]">
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
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <PhoneCall className="h-5 w-5 text-[#6B7280]" />
              <p className="text-sm text-[#9CA3AF]">No calls logged yet.</p>
              <p className="text-xs text-[#6B7280]">
                Log calls via the call center tool to see analytics here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[rgba(209,213,219,0.08)]">
              {calls.map((call) => {
                const direction =
                  call.callType === "outgoing" ? (
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  ) : call.callType === "incoming" ? (
                    <ArrowDownLeft className="h-3.5 w-3.5" />
                  ) : null;
                const MissedIcon = call.answered ? PhoneCall : PhoneMissed;
                return (
                  <li key={call.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                    <span
                      className={
                        call.answered
                          ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[rgba(16,185,129,0.1)] text-[#86EFAC]"
                          : "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[rgba(239,68,68,0.1)] text-[#FCA5A5]"
                      }
                    >
                      <MissedIcon className="h-4 w-4" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm text-[#F3F4F6]">
                          {call.customerPhone ?? "Unknown"}
                        </span>
                        {direction ? (
                          <span className="flex items-center gap-0.5 text-[10px] uppercase tracking-[0.4px] text-[#9CA3AF]">
                            {direction}
                            {call.callType}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-[#9CA3AF]">
                        <span>{formatRelative(call.timestamp)}</span>
                        <span className="text-[#4B5563]">·</span>
                        <span>{formatDuration(call.duration)}</span>
                        {call.deliveryStatus ? (
                          <>
                            <span className="text-[#4B5563]">·</span>
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
                            ? "border-transparent bg-[rgba(245,158,11,0.15)] text-[#FBBF24]"
                            : "border-transparent bg-[rgba(16,185,129,0.15)] text-[#34D399]"
                          : "border-transparent bg-[rgba(239,68,68,0.15)] text-[#F87171]"
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
