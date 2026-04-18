"use client";

import { BadgeDollarSign, PackageCheck, PackageX, Package } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { OrdersBarChart } from "@/components/analytics/orders-bar-chart";
import { CallHeatmap } from "@/components/analytics/call-heatmap";

export default function AnalyticsPage() {
  const dashboard = trpc.analytics.getDashboard.useQuery();
  const last7 = trpc.analytics.getOrdersLast7Days.useQuery();
  const bestTime = trpc.analytics.getBestTimeToCall.useQuery();

  const d = dashboard.data;
  const cards = [
    { label: "Total orders", value: d?.totalOrders ?? 0, icon: Package, tone: "default" as const },
    { label: "Delivered", value: d?.delivered ?? 0, icon: PackageCheck, tone: "success" as const },
    { label: "RTO", value: d?.rto ?? 0, icon: PackageX, tone: "destructive" as const },
    {
      label: "Revenue today",
      value: `৳ ${(d?.revenueToday ?? 0).toLocaleString()}`,
      icon: BadgeDollarSign,
      tone: "default" as const,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          RTO rate:{" "}
          <strong>{((d?.rtoRate ?? 0) * 100).toFixed(1)}%</strong>
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label}>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{c.label}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{dashboard.isLoading ? "…" : c.value}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Orders — last 7 days</CardTitle>
          </CardHeader>
          <CardContent>
            {last7.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <OrdersBarChart data={last7.data ?? []} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Best time to call</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {bestTime.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                <CallHeatmap data={bestTime.data?.heatmap ?? []} />
                <div className="flex flex-wrap gap-2">
                  <span className="text-sm text-muted-foreground">Recommended hours:</span>
                  {(bestTime.data?.bestHours ?? []).map((h) => (
                    <Badge key={h} variant="success">
                      {h.toString().padStart(2, "0")}:00
                    </Badge>
                  ))}
                  {(bestTime.data?.bestHours.length ?? 0) === 0 && (
                    <span className="text-sm text-muted-foreground">Not enough call data yet.</span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
