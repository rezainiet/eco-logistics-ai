"use client";

import { BadgeDollarSign, PackageCheck, PackageX, Package } from "lucide-react";
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
import { OrdersBarChart } from "@/components/analytics/orders-bar-chart";
import { CallHeatmap } from "@/components/analytics/call-heatmap";
import { CallCenterSection } from "@/components/analytics/call-center-section";
import { FraudSection } from "@/components/analytics/fraud-section";

function MetricCard({
  label,
  value,
  icon: Icon,
  sub,
  accent = "#0084D4",
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  sub?: string;
  accent?: string;
}) {
  return (
    <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6] transition-colors hover:border-[rgba(209,213,219,0.2)]">
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

export default function AnalyticsPage() {
  const dashboard = trpc.analytics.getDashboard.useQuery();
  const last7 = trpc.analytics.getOrdersLast7Days.useQuery();
  const bestTime = trpc.analytics.getBestTimeToCall.useQuery();

  const d = dashboard.data;
  const rtoRate = ((d?.rtoRate ?? 0) * 100).toFixed(1);

  const metrics = [
    {
      label: "Total orders",
      value: dashboard.isLoading ? "…" : (d?.totalOrders ?? 0).toLocaleString(),
      icon: Package,
      accent: "#0084D4",
    },
    {
      label: "Delivered",
      value: dashboard.isLoading ? "…" : (d?.delivered ?? 0).toLocaleString(),
      icon: PackageCheck,
      accent: "#10B981",
    },
    {
      label: "RTO",
      value: dashboard.isLoading ? "…" : (d?.rto ?? 0).toLocaleString(),
      icon: PackageX,
      sub: `${rtoRate}% rate`,
      accent: "#EF4444",
    },
    {
      label: "Revenue today",
      value: dashboard.isLoading
        ? "…"
        : `৳ ${(d?.revenueToday ?? 0).toLocaleString()}`,
      icon: BadgeDollarSign,
      accent: "#8B5CF6",
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-[#F3F4F6]">Analytics</h1>
        <p className="mt-1 text-sm text-[#9CA3AF]">
          RTO rate: <span className="font-medium text-[#F3F4F6]">{rtoRate}%</span>
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => (
          <MetricCard
            key={m.label}
            label={m.label}
            value={m.value}
            icon={m.icon}
            sub={m.sub}
            accent={m.accent}
          />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Orders — last 7 days</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              Daily volume, deliveries, and RTOs
            </CardDescription>
          </CardHeader>
          <CardContent>
            {last7.isLoading ? (
              <div className="h-64 animate-shimmer rounded-md" />
            ) : (
              <OrdersBarChart data={last7.data ?? []} />
            )}
          </CardContent>
        </Card>

        <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Best time to call</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              Answer + success score by hour (last 90 days)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {bestTime.isLoading ? (
              <div className="h-64 animate-shimmer rounded-md" />
            ) : (
              <>
                <CallHeatmap data={bestTime.data?.heatmap ?? []} />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] uppercase tracking-[0.4px] text-[#9CA3AF]">
                    Recommended
                  </span>
                  {(bestTime.data?.bestHours ?? []).map((h) => (
                    <Badge
                      key={h}
                      variant="outline"
                      className="border-transparent bg-[rgba(16,185,129,0.15)] text-[#34D399]"
                    >
                      {h.toString().padStart(2, "0")}:00
                    </Badge>
                  ))}
                  {(bestTime.data?.bestHours.length ?? 0) === 0 && (
                    <span className="text-xs text-[#9CA3AF]">
                      Not enough call data yet.
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <FraudSection />

      <CallCenterSection />
    </div>
  );
}
