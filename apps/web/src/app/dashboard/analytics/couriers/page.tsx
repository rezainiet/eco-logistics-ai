"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownRight,
  ArrowUpRight,
  Package,
  PackageCheck,
  PackageX,
  Truck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ChartCard } from "@/components/charts/chart-card";
import {
  CHART_AXIS_STROKE,
  CHART_COLORS,
  CHART_GRID_STROKE,
  CHART_LEGEND_STYLE,
  CHART_TOOLTIP_STYLE,
} from "@/components/charts/chart-style";
import { cn } from "@/lib/utils";
import { formatBDT, formatPercent } from "@/lib/formatters";

type Row = {
  courier: string;
  shipments: number;
  delivered: number;
  rto: number;
  inTransit: number;
  pending: number;
  deliveryRate: number;
  rtoRate: number;
  avgCod: number;
  revenueDelivered: number;
  avgTransitDays: number | null;
};

function deliveryRateClass(rate: number): string {
  if (rate >= 0.85) return "bg-success-subtle text-success";
  if (rate >= 0.7) return "bg-warning-subtle text-warning";
  return "bg-danger-subtle text-danger";
}

function rtoRateClass(rate: number): string {
  if (rate <= 0.05) return "bg-success-subtle text-success";
  if (rate <= 0.15) return "bg-warning-subtle text-warning";
  return "bg-danger-subtle text-danger";
}

export default function CourierPerformancePage() {
  const query = trpc.analytics.getCourierPerformance.useQuery();
  const rows = (query.data ?? []) as Row[];

  const ranked = [...rows].sort((a, b) => b.shipments - a.shipments);
  const best = ranked
    .filter((r) => r.delivered + r.rto >= 5)
    .sort((a, b) => b.deliveryRate - a.deliveryRate)[0];
  const worst = ranked
    .filter((r) => r.delivered + r.rto >= 5)
    .sort((a, b) => b.rtoRate - a.rtoRate)[0];

  const chartData = ranked.slice(0, 8).map((r) => ({
    name: r.courier,
    Delivered: r.delivered,
    RTO: r.rto,
  }));

  const totalShipments = ranked.reduce((s, r) => s + r.shipments, 0);
  const totalDelivered = ranked.reduce((s, r) => s + r.delivered, 0);
  const totalRto = ranked.reduce((s, r) => s + r.rto, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Insights"
        title="Courier performance"
        description="Per-courier delivery rate, RTO rate, transit time and revenue — last 90 days."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={Truck}
          label="Couriers in use"
          value={ranked.length.toLocaleString()}
        />
        <SummaryCard
          icon={Package}
          label="Shipments (90d)"
          value={totalShipments.toLocaleString()}
        />
        <SummaryCard
          icon={PackageCheck}
          label="Delivered"
          value={totalDelivered.toLocaleString()}
          sub={
            totalShipments > 0
              ? `${formatPercent((totalDelivered / totalShipments) * 100)} of total`
              : undefined
          }
        />
        <SummaryCard
          icon={PackageX}
          label="RTO"
          value={totalRto.toLocaleString()}
          sub={
            totalShipments > 0
              ? `${formatPercent((totalRto / totalShipments) * 100)} of total`
              : undefined
          }
        />
      </div>

      {best || worst ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {best ? (
            <HighlightCard
              tone="success"
              icon={ArrowUpRight}
              title={`${best.courier} is your best performer`}
              body={`${formatPercent(best.deliveryRate * 100)} delivery rate across ${best.shipments.toLocaleString()} shipments. RTO ${formatPercent(best.rtoRate * 100)}.`}
            />
          ) : null}
          {worst && worst.rtoRate > 0.1 ? (
            <HighlightCard
              tone="danger"
              icon={ArrowDownRight}
              title={`${worst.courier} is dragging your RTO up`}
              body={`${formatPercent(worst.rtoRate * 100)} RTO rate across ${worst.shipments.toLocaleString()} shipments. Consider rerouting volume.`}
            />
          ) : null}
        </div>
      ) : null}

      <ChartCard
        title="Shipment outcomes by courier"
        description="Delivered vs RTO across your top couriers"
      >
        {query.isLoading ? (
          <div className="h-72 animate-shimmer rounded-md" />
        ) : chartData.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="No courier data yet"
            description="Book a shipment from the Orders page to start populating performance data."
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
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "transparent" }} />
              <Legend wrapperStyle={CHART_LEGEND_STYLE} iconType="circle" iconSize={7} />
              <Bar dataKey="Delivered" stackId="a" fill={CHART_COLORS.success} maxBarSize={42}>
                {chartData.map((_, i) => (
                  <Cell key={`d-${i}`} fill={CHART_COLORS.success} />
                ))}
              </Bar>
              <Bar
                dataKey="RTO"
                stackId="a"
                fill={CHART_COLORS.danger}
                radius={[6, 6, 0, 0]}
                maxBarSize={42}
              >
                {chartData.map((_, i) => (
                  <Cell key={`r-${i}`} fill={CHART_COLORS.danger} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <div className="overflow-hidden rounded-xl border border-stroke/10 bg-surface shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stroke/8 bg-surface-raised/40 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                <th className="h-11 px-3 text-left font-semibold">Courier</th>
                <th className="h-11 px-3 text-right font-semibold">Shipments</th>
                <th className="h-11 px-3 text-right font-semibold">Delivered</th>
                <th className="h-11 px-3 text-right font-semibold">RTO</th>
                <th className="h-11 px-3 text-right font-semibold">In transit</th>
                <th className="h-11 px-3 text-right font-semibold">Delivery rate</th>
                <th className="h-11 px-3 text-right font-semibold">RTO rate</th>
                <th className="h-11 px-3 text-right font-semibold">Avg COD</th>
                <th className="h-11 px-3 text-right font-semibold">Revenue</th>
                <th className="h-11 px-3 text-right font-semibold">Avg transit</th>
              </tr>
            </thead>
            <tbody>
              {query.isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-stroke/6">
                    <td colSpan={10} className="px-3 py-3">
                      <div className="h-4 w-full animate-shimmer rounded" />
                    </td>
                  </tr>
                ))
              ) : ranked.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-0">
                    <EmptyState
                      icon={Truck}
                      title="No courier shipments in the last 90 days"
                      description="Book pickups from the Orders page to see performance data here."
                      className="m-4 border-0 bg-transparent"
                    />
                  </td>
                </tr>
              ) : (
                ranked.map((r) => (
                  <tr
                    key={r.courier}
                    className="border-b border-stroke/6 last:border-b-0 hover:bg-surface-raised/40"
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand/14 text-brand">
                          <Truck className="h-3.5 w-3.5" />
                        </span>
                        <span className="font-medium text-fg">{r.courier}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-fg-muted">
                      {r.shipments.toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-fg-muted">
                      {r.delivered.toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-fg-muted">
                      {r.rto.toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-fg-muted">
                      {r.inTransit.toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Badge
                        variant="outline"
                        className={cn(
                          "border-transparent font-mono tabular-nums",
                          deliveryRateClass(r.deliveryRate),
                        )}
                      >
                        {formatPercent(r.deliveryRate * 100)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Badge
                        variant="outline"
                        className={cn(
                          "border-transparent font-mono tabular-nums",
                          rtoRateClass(r.rtoRate),
                        )}
                      >
                        {formatPercent(r.rtoRate * 100)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-fg-muted">
                      {formatBDT(Math.round(r.avgCod))}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-fg">
                      {formatBDT(r.revenueDelivered)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-fg-muted">
                      {r.avgTransitDays != null
                        ? `${r.avgTransitDays.toFixed(1)}d`
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Truck;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-stroke/10 bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
          {label}
        </p>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/14 text-brand">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-3 text-[28px] font-semibold leading-none tracking-tight text-fg">
        {value}
      </p>
      {sub ? <p className="mt-1 text-xs text-fg-subtle">{sub}</p> : null}
    </div>
  );
}

function HighlightCard({
  icon: Icon,
  title,
  body,
  tone,
}: {
  icon: typeof Truck;
  title: string;
  body: string;
  tone: "success" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "border-success-border bg-success-subtle text-success"
      : "border-danger-border bg-danger-subtle text-danger";
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border p-4", toneClass)}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
        <Icon className="h-4 w-4" />
      </span>
      <div className="space-y-0.5">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-fg-muted">{body}</p>
      </div>
    </div>
  );
}
