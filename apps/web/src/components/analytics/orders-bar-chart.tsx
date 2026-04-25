"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CHART_AXIS_STROKE,
  CHART_COLORS,
  CHART_CURSOR_FILL,
  CHART_GRID_STROKE,
  CHART_LEGEND_STYLE,
  CHART_TOOLTIP_STYLE,
} from "@/components/charts/chart-style";

export function OrdersBarChart({
  data,
}: {
  data: Array<{ date: string; total: number; delivered: number; rto: number }>;
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => v.slice(5)}
            stroke={CHART_AXIS_STROKE}
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            allowDecimals={false}
            stroke={CHART_AXIS_STROKE}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={28}
          />
          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: CHART_CURSOR_FILL }} />
          <Legend wrapperStyle={CHART_LEGEND_STYLE} iconType="circle" iconSize={7} />
          <Bar
            dataKey="delivered"
            stackId="a"
            fill={CHART_COLORS.success}
            name="Delivered"
            maxBarSize={42}
          />
          <Bar
            dataKey="rto"
            stackId="a"
            fill={CHART_COLORS.danger}
            name="RTO"
            radius={[6, 6, 0, 0]}
            maxBarSize={42}
          />
          <Bar
            dataKey="total"
            fill={CHART_COLORS.brand}
            name="Total"
            radius={[6, 6, 0, 0]}
            maxBarSize={42}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
