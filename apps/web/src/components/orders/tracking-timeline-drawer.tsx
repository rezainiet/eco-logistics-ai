"use client";

import { useMemo } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  MapPin,
  Package,
  RefreshCw,
  Truck,
  Undo2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";

type TrackingBadge = { label: string; className: string; icon: typeof Package };
const FALLBACK_BADGE: TrackingBadge = {
  label: "Unknown",
  className: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
  icon: Clock,
};
const NORMALIZED_BADGE: Record<string, TrackingBadge> = {
  pending: { label: "Pending", className: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]", icon: Clock },
  picked_up: { label: "Picked up", className: "bg-[rgba(59,130,246,0.15)] text-[#60A5FA]", icon: Package },
  in_transit: { label: "In transit", className: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]", icon: Truck },
  out_for_delivery: {
    label: "Out for delivery",
    className: "bg-[rgba(168,85,247,0.15)] text-[#C084FC]",
    icon: Truck,
  },
  delivered: {
    label: "Delivered",
    className: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
    icon: CheckCircle2,
  },
  failed: { label: "Failed", className: "bg-[rgba(239,68,68,0.15)] text-[#F87171]", icon: AlertCircle },
  rto: { label: "RTO", className: "bg-[rgba(239,68,68,0.15)] text-[#F87171]", icon: Undo2 },
  unknown: { label: "Unknown", className: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]", icon: Clock },
};

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

export function TrackingTimelineDrawer({
  orderId,
  open,
  onOpenChange,
}: {
  orderId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const query = trpc.orders.getOrder.useQuery(
    { id: orderId ?? "" },
    { enabled: open && !!orderId },
  );
  const refresh = trpc.orders.refreshTracking.useMutation({
    onSuccess: async (res) => {
      if (res.ok) {
        const newEvents = res.newEvents ?? 0;
        if (res.statusTransition) {
          toast.success(
            `Status updated: ${res.statusTransition.from} → ${res.statusTransition.to}`,
            newEvents > 0 ? `${newEvents} new tracking event${newEvents === 1 ? "" : "s"}` : undefined,
          );
        } else if (newEvents > 0) {
          toast.success(
            `${newEvents} new event${newEvents === 1 ? "" : "s"}`,
            "Tracking timeline refreshed.",
          );
        } else {
          toast.info("Already up to date", "No new courier events since last sync.");
        }
      } else if ("skipped" in res && res.skipped) {
        toast.info("Cannot refresh", skipReason(res.skipped));
      } else if ("error" in res && res.error) {
        toast.error("Refresh failed", res.error);
      }
      await Promise.all([
        utils.orders.getOrder.invalidate({ id: orderId ?? "" }),
        utils.orders.listOrders.invalidate(),
      ]);
    },
    onError: (err) => {
      toast.error("Refresh failed", err.message);
    },
  });

  const order = query.data;
  const events = useMemo(() => {
    if (!order) return [];
    return [...order.trackingEvents].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
  }, [order]);

  const latestBadge: TrackingBadge | null = order?.normalizedStatus
    ? (NORMALIZED_BADGE[order.normalizedStatus] ?? FALLBACK_BADGE)
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto p-6 sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between gap-3 pr-8">
            <span>{order ? `Order ${order.orderNumber}` : "Tracking timeline"}</span>
            {latestBadge && (
              <Badge variant="outline" className={`border-transparent ${latestBadge.className}`}>
                <latestBadge.icon className="mr-1 h-3 w-3" />
                {latestBadge.label}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {order?.courier
              ? `${order.courier} · ${order.trackingNumber ?? "no tracking number"}`
              : "No courier assigned yet"}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {query.isLoading && !order ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-14 animate-shimmer rounded" />
              ))}
            </div>
          ) : order ? (
            <>
              <div className="grid gap-3 rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#1A1D2E] p-4 text-sm">
                <SummaryRow label="Customer" value={`${order.customer.name} — ${order.customer.phone}`} />
                <SummaryRow label="Destination" value={order.customer.district} />
                <SummaryRow label="COD" value={`৳ ${order.cod.toLocaleString()}`} />
                <SummaryRow label="Order status" value={order.status.replace("_", " ")} />
                <SummaryRow label="Last polled" value={formatDate(order.lastPolledAt)} />
                {order.estimatedDelivery && (
                  <SummaryRow label="Estimated" value={formatDate(order.estimatedDelivery)} />
                )}
                {order.deliveredAt && (
                  <SummaryRow label="Delivered" value={formatDate(order.deliveredAt)} />
                )}
                {order.returnedAt && (
                  <SummaryRow label="Returned" value={formatDate(order.returnedAt)} />
                )}
                {order.pollError && (
                  <div className="rounded border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.08)] p-2 text-xs text-[#F87171]">
                    Last poll error: {order.pollError}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#F3F4F6]">Timeline</h3>
                {order.trackingNumber && order.courier && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-[rgba(209,213,219,0.15)] bg-transparent text-[#F3F4F6] hover:bg-[#111318]"
                    disabled={refresh.isLoading}
                    onClick={() => refresh.mutate({ id: order.id })}
                  >
                    <RefreshCw
                      className={`mr-2 h-3.5 w-3.5 ${refresh.isLoading ? "animate-spin" : ""}`}
                    />
                    Refresh
                  </Button>
                )}
              </div>

              {events.length === 0 ? (
                <p className="rounded-md border border-dashed border-[rgba(209,213,219,0.15)] p-4 text-center text-sm text-[#9CA3AF]">
                  No courier events yet. Events will appear here after the first sync.
                </p>
              ) : (
                <ol className="relative space-y-4 border-l border-[rgba(209,213,219,0.15)] pl-4">
                  {events.map((e, idx) => {
                    const badge: TrackingBadge =
                      NORMALIZED_BADGE[e.normalizedStatus] ?? FALLBACK_BADGE;
                    const Icon = badge.icon;
                    return (
                      <li key={`${e.at}-${idx}`} className="relative">
                        <span
                          className={`absolute -left-[21px] flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-[#111318] ${badge.className}`}
                        >
                          <Icon className="h-2.5 w-2.5" />
                        </span>
                        <div className="text-xs text-[#9CA3AF]">{formatDate(e.at)}</div>
                        <div className="mt-0.5 text-sm text-[#F3F4F6]">
                          {e.description || e.providerStatus}
                        </div>
                        {e.location && (
                          <div className="mt-1 flex items-center gap-1 text-xs text-[#9CA3AF]">
                            <MapPin className="h-3 w-3" />
                            {e.location}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          ) : (
            <p className="text-sm text-[#9CA3AF]">Order not found.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-[#9CA3AF]">{label}</span>
      <span className="text-right text-sm text-[#F3F4F6]">{value}</span>
    </div>
  );
}

function skipReason(code: string): string {
  switch (code) {
    case "no_tracking":
      return "Order has no tracking number yet.";
    case "no_adapter":
      return "This courier adapter is not available yet.";
    case "no_courier_config":
      return "Configure courier credentials in Settings first.";
    default:
      return code;
  }
}
