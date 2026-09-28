"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  CHART_AXIS_STROKE,
  CHART_COLORS,
  CHART_CURSOR_FILL,
  CHART_GRID_STROKE,
  CHART_LEGEND_STYLE,
  CHART_TOOLTIP_STYLE,
} from "@/components/charts/chart-style";
import { formatBDT } from "@/lib/formatters";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Revenue, expenses and net profit per month of one year. */
export function MonthlyChart({
  data,
}: {
  data: Array<{ month: string; revenue: number; otherIncome: number; expenses: number; netProfit: number }>;
}) {
  const rows = data.map((m) => ({
    name: MONTHS[Number(m.month.slice(5)) - 1],
    Revenue: m.revenue + m.otherIncome,
    Expenses: m.expenses,
    "Net profit": m.netProfit,
  }));
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
          <XAxis dataKey="name" stroke={CHART_AXIS_STROKE} fontSize={11} tickLine={false} axisLine={false} />
          <YAxis
            stroke={CHART_AXIS_STROKE}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
          />
          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: CHART_CURSOR_FILL }} formatter={(v: number) => formatBDT(v)} />
          <Legend wrapperStyle={CHART_LEGEND_STYLE} iconType="circle" iconSize={7} />
          <Bar dataKey="Revenue" fill={CHART_COLORS.success} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Expenses" fill={CHART_COLORS.warning} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Net profit" fill={CHART_COLORS.brand} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
