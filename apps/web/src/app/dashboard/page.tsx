"use client";

import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowUpRight,
  BadgeDollarSign,
  Package,
  PackageCheck,
  PackageX,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { ChartCard } from "@/components/charts/chart-card";
import { NewMerchantRedirect } from "@/components/onboarding/new-merchant-redirect";
import { FirstFlagBanner } from "@/components/onboarding/activation-moments";
import { NextStepBanner } from "@/components/dashboard/next-step-banner";
import { OperationalBanner } from "@/components/dashboard/operational-banner";
import {
  CHART_AXIS_STROKE,
  CHART_COLORS,
  CHART_CURSOR_FILL,
  CHART_GRID_STROKE,
  CHART_LEGEND_STYLE,
  CHART_TOOLTIP_STYLE,
} from "@/components/charts/chart-style";
import { formatBDT } from "@/lib/formatters";

function trendDelta(series: number[]): number {
  if (!series.length) return 0;
  const half = Math.max(1, Math.floor(series.length / 2));
  const first = series.slice(0, half);
  const second = series.slice(-half);
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const a = sum(first);
  const b = sum(second);
  if (a === 0) return b > 0 ? 100 : 0;
  return ((b - a) / a) * 100;
}

export default function DashboardPage() {
  const dashboard = trpc.analytics.getDashboard.useQuery();
  const last7 = trpc.analytics.getOrdersLast7Days.useQuery();
  const fraudStats = trpc.fraud.getReviewStats.useQuery({ days: 7 });

  const d = dashboard.data;
  const rtoRate = ((d?.rtoRate ?? 0) * 100);
  const queue = fraudStats.data?.queue ?? { pending: 0, noAnswer: 0 };
  const queueTotal = queue.pending + queue.noAnswer;

  const last = last7.data ?? [];
  const totalSpark = last.map((x) => x.total);
  const deliveredSpark = last.map((x) => x.delivered);
  const rtoRateSpark = last.map((x) => (x.total > 0 ? (x.rto / x.total) * 100 : 0));

  const totalDelta = trendDelta(totalSpark);
  const deliveredDelta = trendDelta(deliveredSpark);
  const rtoDelta = trendDelta(rtoRateSpark);

  const chartData = last.map((x) => ({
    name: x.date.slice(5),
    Orders: x.total,
    Delivered: x.delivered,
    RTO: x.rto,
  }));

  const statusData = d
    ? [
        { name: "Delivered", value: d.delivered, color: CHART_COLORS.success },
        { name: "Pending", value: d.pending, color: CHART_COLORS.warning },
        { name: "Failed", value: d.rto, color: CHART_COLORS.danger },
      ].filter((s) => s.value > 0)
    : [];

  const loading = dashboard.isLoading;

  return (
    <div className="space-y-8">
      <NewMerchantRedirect />
      {/* First-flag celebration — renders only for ~7 days after the
          first risky order Cordon catches. Anchors the activation
          moment on the dashboard so the merchant feels the value on
          every visit, not just when the toast first fired. */}
      <FirstFlagBanner />
      <NextStepBanner />
      <OperationalBanner />
      <PageHeader
        eyebrow="Overview"
        title="Welcome back"
        description="Your logistics operations at a glance — last 7 days trend included on every KPI."
        actions={
          <>
            {queueTotal > 0 ? (
              <Button asChild variant="outline" className="border-danger-border bg-danger-subtle text-danger hover:bg-danger/20 hover:text-danger">
                <Link href="/dashboard/fraud-review">
                  <ShieldAlert className="mr-2 h-4 w-4" />
                  {queueTotal} to review
                </Link>
              </Button>
            ) : null}
            <Button asChild className="bg-brand text-white hover:bg-brand-hover">
              <Link href="/dashboard/orders">
                View orders
                <ArrowUpRight className="ml-1.5 h-4 w-4" />
              </Link>
            </Button>
          </>
        }
      />

      <section aria-label="Key metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total orders"
          value={loading ? "—" : (d?.totalOrders ?? 0).toLocaleString()}
          icon={Package}
          tone="brand"
          sparkData={totalSpark}
          delta={last.length >= 2 ? { value: totalDelta, label: "vs last period" } : undefined}
          loading={loading}
        />
        <StatCard
          label="Delivered"
          value={loading ? "—" : (d?.delivered ?? 0).toLocaleString()}
          icon={PackageCheck}
          tone="success"
          sparkData={deliveredSpark}
          delta={last.length >= 2 ? { value: deliveredDelta, label: "vs last period" } : undefined}
          loading={loading}
        />
        <StatCard
          label="Failed delivery rate"
          value={loading ? "—" : `${rtoRate.toFixed(1)}%`}
          icon={PackageX}
          tone="danger"
          sparkData={rtoRateSpark}
          delta={last.length >= 2 ? { value: rtoDelta, label: "vs last period" } : undefined}
          invertDelta
          loading={loading}
        />
        <StatCard
          label="Revenue today"
          value={loading ? "—" : formatBDT(d?.revenueToday ?? 0)}
          icon={BadgeDollarSign}
          tone="violet"
          footer="Delivered orders · today"
          loading={loading}
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Orders — last 7 days"
          description="Volume, deliveries and returns by day"
          action={
            <div className="inline-flex rounded-md border border-stroke/12 bg-surface-raised p-0.5 text-xs text-fg-subtle">
              <span className="rounded-sm bg-surface px-2 py-1 font-medium text-fg shadow-card">7d</span>
              <span className="cursor-not-allowed px-2 py-1 opacity-60" title="Coming soon">30d</span>
              <span className="cursor-not-allowed px-2 py-1 opacity-60" title="Coming soon">90d</span>
            </div>
          }
        >
          {last7.isLoading ? (
            <div className="h-72 animate-shimmer rounded-md" />
          ) : chartData.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="No activity yet"
              description="Create your first order to see daily trends here."
              className="my-4"
            />
          ) : (
            <ResponsiveContainer width="100%" height={288}>
              <BarChart data={chartData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                <XAxis
                  dataKey="name"
                  stroke={CHART_AXIS_STROKE}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke={CHART_AXIS_STROKE}
                  fontSize={11}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: CHART_CURSOR_FILL }} />
                <Legend wrapperStyle={CHART_LEGEND_STYLE} iconType="circle" iconSize={7} />
                <Bar dataKey="Orders" fill={CHART_COLORS.brand} radius={[6, 6, 0, 0]} maxBarSize={42} />
                <Bar dataKey="Delivered" fill={CHART_COLORS.success} radius={[6, 6, 0, 0]} maxBarSize={42} />
                <Bar dataKey="RTO" name="Failed delivery" fill={CHART_COLORS.danger} radius={[6, 6, 0, 0]} maxBarSize={42} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Order status" description="Lifetime distribution">
          {dashboard.isLoading ? (
            <div className="h-72 animate-shimmer rounded-md" />
          ) : statusData.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No orders yet"
              description="Your fulfilment breakdown appears here once orders flow in."
              className="my-4"
            />
          ) : (
            <ResponsiveContainer width="100%" height={288}>
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={92}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} stroke="hsl(228 30% 11%)" strokeWidth={3} />
                  ))}
                </Pie>
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                <Legend wrapperStyle={CHART_LEGEND_STYLE} iconType="circle" iconSize={7} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </section>
    </div>
  );
}
