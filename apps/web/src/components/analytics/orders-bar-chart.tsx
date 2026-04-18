"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function OrdersBarChart({
  data,
}: {
  data: Array<{ date: string; total: number; delivered: number; rto: number }>;
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} fontSize={12} />
          <YAxis allowDecimals={false} fontSize={12} />
          <Tooltip />
          <Legend />
          <Bar dataKey="delivered" stackId="a" fill="#16a34a" name="Delivered" />
          <Bar dataKey="rto" stackId="a" fill="#dc2626" name="RTO" />
          <Bar dataKey="total" fill="#3b82f6" name="Total" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
