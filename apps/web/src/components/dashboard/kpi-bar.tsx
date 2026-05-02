"use client";

import { useMemo } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  PackageCheck,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "success" | "warning" | "info";
  icon?: React.ComponentType<{ className?: string }>;
  delta?: { value: number; label: string };
}

function KpiCard({ label, value, hint, tone = "default", icon: Icon, delta }: KpiCardProps) {
  const toneClasses = {
    default: "bg-surface",
    success: "bg-success/8",
    warning: "bg-warning/8",
    info: "bg-info/8",
  }[tone];
  const deltaPositive = delta && delta.value > 0;
  const deltaNegative = delta && delta.value < 0;
  return (
    <div className={`rounded-md border border-border ${toneClasses} p-3`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          {label}
        </span>
        {Icon ? <Icon className="h-3.5 w-3.5 text-fg-muted" /> : null}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">
        {value}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-xs text-fg-muted">
        {delta ? (
          <span className={`inline-flex items-center gap-0.5 ${deltaPositive ? "text-success" : deltaNegative ? "text-danger" : ""}`}>
            {deltaPositive ? <ArrowUpRight className="h-3 w-3" /> : null}
            {deltaNegative ? <ArrowDownRight className="h-3 w-3" /> : null}
            {Math.abs(delta.value)}% {delta.label}
          </span>
        ) : null}
        {hint ? <span className="truncate">{hint}</span> : null}
      </div>
    </div>
  );
}

export function DashboardKpiBar() {
  const dash = trpc.analytics.getDashboard.useQuery(undefined, {
    staleTime: 60_000,
  });

  const data = useMemo(() => {
    const d = (dash.data ?? {}) as {
      ordersToday?: number;
      successRate?: number;
      rtoRate?: number;
      automationActions?: number;
      networkCatches?: number;
    };
    return {
      ordersToday: d.ordersToday ?? 0,
      successRate: d.successRate ?? 0,
      rtoRate: d.rtoRate ?? 0,
      automationActions: d.automationActions ?? 0,
      networkCatches: d.networkCatches ?? 0,
    };
  }, [dash.data]);

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Orders today" value={String(data.ordersToday)} icon={PackageCheck} />
        <KpiCard label="Success rate" value={`${Math.round(data.successRate * 100)}%`} tone="success" icon={CheckCircle2} hint="Delivered / shipped" />
        <KpiCard label="Failed delivery rate" value={`${Math.round(data.rtoRate * 100)}%`} tone={data.rtoRate >= 0.2 ? "warning" : "default"} icon={ShieldAlert} />
        <KpiCard label="Automation" value={String(data.automationActions)} tone="info" icon={Bot} hint="Actions today" />
        <KpiCard label="Network catches" value={String(data.networkCatches)} tone="info" icon={ShieldCheck} hint="Cross-merchant flags" />
      </CardContent>
    </Card>
  );
}
