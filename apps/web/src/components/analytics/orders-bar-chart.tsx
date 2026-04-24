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

const TOOLTIP_STYLE = {
  backgroundColor: "#111318",
  border: "1px solid rgba(209,213,219,0.12)",
  borderRadius: "8px",
  color: "#F3F4F6",
};

export function OrdersBarChart({
  data,
}: {
  data: Array<{ date: string; total: number; delivered: number; rto: number }>;
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(209,213,219,0.08)" />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => v.slice(5)}
            stroke="#9CA3AF"
            fontSize={12}
          />
          <YAxis allowDecimals={false} stroke="#9CA3AF" fontSize={12} />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(0,132,212,0.08)" }} />
          <Legend wrapperStyle={{ color: "#9CA3AF", fontSize: 12 }} />
          <Bar dataKey="delivered" stackId="a" fill="#10B981" name="Delivered" radius={[0, 0, 0, 0]} />
          <Bar dataKey="rto" stackId="a" fill="#EF4444" name="RTO" radius={[6, 6, 0, 0]} />
          <Bar dataKey="total" fill="#0084D4" name="Total" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
