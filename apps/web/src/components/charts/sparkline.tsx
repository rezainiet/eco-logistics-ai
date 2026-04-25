"use client";

import * as React from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

type SparklineProps = {
  data: Array<number>;
  color?: string;
  height?: number;
  className?: string;
};

export function Sparkline({ data, color = "hsl(202 100% 41%)", height = 36, className }: SparklineProps) {
  const series = React.useMemo(
    () => data.map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 })),
    [data],
  );

  if (series.length === 0) {
    return <div style={{ height }} className={className} aria-hidden />;
  }

  const gradientId = React.useId();

  return (
    <div style={{ height }} className={className}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.75}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
