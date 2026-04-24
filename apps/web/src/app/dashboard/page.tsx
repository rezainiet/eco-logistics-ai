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
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const STATUS_COLORS = {
  delivered: "#10B981",
  pending: "#F59E0B",
  rto: "#EF4444",
} as const;

const TOOLTIP_STYLE = {
  backgroundColor: "#111318",
  border: "1px solid rgba(209,213,219,0.12)",
  borderRadius: "8px",
  color: "#F3F4F6",
};

function formatBDT(n: number): string {
  return `৳ ${n.toLocaleString()}`;
}

export default function DashboardPage() {
  const dashboard = trpc.analytics.getDashboard.useQuery();
  const last7 = trpc.analytics.getOrdersLast7Days.useQuery();
  const fraudStats = trpc.fraud.getReviewStats.useQuery({ days: 7 });

  const d = dashboard.data;
  const rtoRate = ((d?.rtoRate ?? 0) * 100).toFixed(1);
  const queue = fraudStats.data?.queue ?? { pending: 0, noAnswer: 0 };
  const queueTotal = queue.pending + queue.noAnswer;

  const stats = [
    {
      title: "Total orders",
      value: dashboard.isLoading ? "…" : (d?.totalOrders ?? 0).toLocaleString(),
      icon: Package,
      color: "#0084D4",
    },
    {
      title: "Delivered",
      value: dashboard.isLoading ? "…" : (d?.delivered ?? 0).toLocaleString(),
      icon: PackageCheck,
      color: "#10B981",
    },
    {
      title: "RTO rate",
      value: dashboard.isLoading ? "…" : `${rtoRate}%`,
      icon: PackageX,
      color: "#EF4444",
    },
    {
      title: "Revenue today",
      value: dashboard.isLoading ? "…" : formatBDT(d?.revenueToday ?? 0),
      icon: BadgeDollarSign,
      color: "#8B5CF6",
    },
  ];

  const chartData = (last7.data ?? []).map((d) => ({
    name: d.date.slice(5),
    Orders: d.total,
    Delivered: d.delivered,
    RTO: d.rto,
  }));

  const statusData = d
    ? [
        { name: "Delivered", value: d.delivered, color: STATUS_COLORS.delivered },
        { name: "Pending", value: d.pending, color: STATUS_COLORS.pending },
        { name: "RTO", value: d.rto, color: STATUS_COLORS.rto },
      ].filter((s) => s.value > 0)
    : [];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-[#F3F4F6]">Welcome back</h1>
          <p className="mt-1 text-sm text-[#9CA3AF]">Your business at a glance.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {queueTotal > 0 && (
            <Button
              asChild
              variant="outline"
              className="border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[#FCA5A5] hover:bg-[rgba(239,68,68,0.15)]"
            >
              <Link href="/dashboard/fraud-review">
                <ShieldAlert className="mr-2 h-4 w-4" />
                {queueTotal} to review
              </Link>
            </Button>
          )}
          <Button asChild className="w-full bg-[#0084D4] text-white hover:bg-[#0072BB] md:w-auto">
            <Link href="/dashboard/orders">
              View orders
              <ArrowUpRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Card
              key={s.title}
              className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6] transition-colors hover:border-[rgba(209,213,219,0.2)]"
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-[0.4px] text-[#9CA3AF]">
                  {s.title}
                </CardTitle>
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${s.color}22` }}
                >
                  <Icon className="h-4 w-4" style={{ color: s.color }} />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-[#F3F4F6]">{s.value}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6] lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Orders — last 7 days</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              Orders, deliveries and RTOs by day
            </CardDescription>
          </CardHeader>
          <CardContent>
            {last7.isLoading ? (
              <div className="h-72 animate-shimmer rounded-md" />
            ) : (
              <ResponsiveContainer width="100%" height={288}>
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(209,213,219,0.08)" />
                  <XAxis dataKey="name" stroke="#9CA3AF" fontSize={12} />
                  <YAxis stroke="#9CA3AF" fontSize={12} allowDecimals={false} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    cursor={{ fill: "rgba(0,132,212,0.08)" }}
                  />
                  <Legend wrapperStyle={{ color: "#9CA3AF", fontSize: 12 }} />
                  <Bar dataKey="Orders" fill="#0084D4" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="Delivered" fill="#10B981" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="RTO" fill="#EF4444" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Order status</CardTitle>
            <CardDescription className="text-[#9CA3AF]">Lifetime distribution</CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.isLoading ? (
              <div className="h-72 animate-shimmer rounded-md" />
            ) : statusData.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-[#9CA3AF]">
                No orders yet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={288}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={56}
                    outerRadius={88}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {statusData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} stroke="#111318" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ color: "#9CA3AF", fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
