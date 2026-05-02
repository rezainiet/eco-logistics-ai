"use client";

import * as React from "react";
import Link from "next/link";
import {
  BadgeDollarSign,
  BarChart3,
  PackageCheck,
  PackageX,
  Package,
  Truck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { ChartCard } from "@/components/charts/chart-card";
import { OrdersBarChart } from "@/components/analytics/orders-bar-chart";
import { CallHeatmap } from "@/components/analytics/call-heatmap";
import { CallCenterSection } from "@/components/analytics/call-center-section";
import { FraudSection } from "@/components/analytics/fraud-section";
import { formatBDT, formatPercent } from "@/lib/formatters";

export default function AnalyticsPage() {
  const dashboard = trpc.analytics.getDashboard.useQuery();
  const last7 = trpc.analytics.getOrdersLast7Days.useQuery();
  const bestTime = trpc.analytics.getBestTimeToCall.useQuery();

  const d = dashboard.data;
  const rtoRate = (d?.rtoRate ?? 0) * 100;
  const loading = dashboard.isLoading;

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("logistics:analytics-visited", "1");
    }
  }, []);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Insights"
        title="Analytics"
        description={`Lifetime failed-delivery rate: ${formatPercent(rtoRate)} · performance + call center + fraud in one view.`}
        actions={
          <Button
            asChild
            variant="outline"
            className="border-stroke/14 bg-transparent text-fg hover:bg-surface-raised"
          >
            <Link href="/dashboard/analytics/couriers">
              <Truck className="mr-1.5 h-4 w-4" />
              Courier performance
            </Link>
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total orders"
          value={loading ? "—" : (d?.totalOrders ?? 0).toLocaleString()}
          icon={Package}
          tone="brand"
          loading={loading}
        />
        <StatCard
          label="Delivered"
          value={loading ? "—" : (d?.delivered ?? 0).toLocaleString()}
          icon={PackageCheck}
          tone="success"
          loading={loading}
        />
        <StatCard
          label="Failed"
          value={loading ? "—" : (d?.rto ?? 0).toLocaleString()}
          icon={PackageX}
          tone="danger"
          footer={`${formatPercent(rtoRate)} rate`}
          loading={loading}
        />
        <StatCard
          label="Revenue today"
          value={loading ? "—" : formatBDT(d?.revenueToday ?? 0)}
          icon={BadgeDollarSign}
          tone="violet"
          loading={loading}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Orders — last 7 days"
          description="Daily volume, deliveries, and RTOs"
        >
          {last7.isError ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 text-center text-sm text-fg-muted">
              <span>Could not load analytics.</span>
              <Button variant="outline" size="sm" onClick={() => last7.refetch()}>
                Retry
              </Button>
            </div>
          ) : last7.isLoading ? (
            <div className="h-64 animate-shimmer rounded-md" />
          ) : (last7.data ?? []).length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No activity yet"
              description="Create your first order to see daily trends here."
              className="my-4"
            />
          ) : (
            <OrdersBarChart data={last7.data ?? []} />
          )}
        </ChartCard>

        <ChartCard
          title="Best time to call"
          description="Answer + success score by hour (last 90 days)"
        >
          {bestTime.isLoading ? (
            <div className="h-64 animate-shimmer rounded-md" />
          ) : (
            <div className="space-y-4 pt-1">
              <CallHeatmap data={bestTime.data?.heatmap ?? []} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                  Recommended
                </span>
                {(bestTime.data?.bestHours ?? []).map((h) => (
                  <Badge
                    key={h}
                    variant="outline"
                    className="border-transparent bg-success-subtle text-success"
                  >
                    {h.toString().padStart(2, "0")}:00
                  </Badge>
                ))}
                {(bestTime.data?.bestHours.length ?? 0) === 0 && (
                  <span className="text-xs text-fg-subtle">
                    Not enough call data yet.
                  </span>
                )}
              </div>
            </div>
          )}
        </ChartCard>
      </div>

      <FraudSection />

      <CallCenterSection />
    </div>
  );
}
