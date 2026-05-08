"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  PhoneOff,
  ShieldAlert,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { trpc } from "@/lib/trpc";
import { formatRelative } from "@/lib/formatters";
import { cn } from "@/lib/utils";

// Map raw camelCase metric identifiers (`fraudReviewsUsed`, `smsSent`...) to
// human copy. Mirrors the same dictionary in <SubscriptionBanner> so both
// surfaces speak the same language when nagging the merchant about quota.
const METRIC_LABELS: Record<string, string> = {
  fraudReviewsUsed: "fraud reviews this month",
  fraudReviews: "fraud reviews this month",
  smsSent: "SMS messages this month",
  smsUsed: "SMS messages this month",
  ordersIngested: "orders this month",
  ordersUsed: "orders this month",
  ordersCreated: "orders this month",
  shipmentsBooked: "shipments this month",
  callsInitiated: "calls this month",
  callMinutesUsed: "call minutes this month",
  webhookEvents: "webhook events this month",
};
function humanMetric(metric: string): string {
  if (METRIC_LABELS[metric]) return METRIC_LABELS[metric]!;
  return metric.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

type NotificationTone = "danger" | "warning" | "info" | "success";

type NotificationItem = {
  id: string;
  tone: NotificationTone;
  icon: LucideIcon;
  title: string;
  body?: string;
  href?: string;
  timestamp?: Date | string;
};

const TONE_BADGE: Record<NotificationTone, string> = {
  danger: "bg-danger-subtle text-danger",
  warning: "bg-warning-subtle text-warning",
  info: "bg-info-subtle text-info",
  success: "bg-success-subtle text-success",
};

type NotificationsDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unreadCount: number;
};

export function NotificationsDrawer({
  open,
  onOpenChange,
  unreadCount: _unreadCount,
}: NotificationsDrawerProps) {
  const fraudStats = trpc.fraud.getReviewStats.useQuery({ days: 7 });
  const plan = trpc.billing.getPlan.useQuery(undefined, { staleTime: 60_000 });
  const usage = trpc.billing.getUsage.useQuery(undefined, { staleTime: 60_000 });
  const recentCalls = trpc.callCenter.getCallLogs.useQuery({
    limit: 5,
    callType: "all",
    cursor: null,
  });

  const items = React.useMemo<NotificationItem[]>(() => {
    const out: NotificationItem[] = [];

    // Subscription / billing first.
    const sub = plan.data?.subscription;
    if (sub?.status === "past_due") {
      out.push({
        id: "billing:past-due",
        tone: "danger",
        icon: AlertCircle,
        title: "Subscription past due",
        body: "Submit a payment to restore access to your dashboard.",
        href: "/dashboard/billing",
      });
    }
    if (sub?.trialExpired) {
      out.push({
        id: "billing:trial-expired",
        tone: "danger",
        icon: AlertCircle,
        title: "Trial has ended",
        body: "Choose a plan to keep using Cordon.",
        href: "/dashboard/billing",
      });
    }
    if (
      sub?.status === "trial" &&
      typeof sub.trialDaysLeft === "number" &&
      sub.trialDaysLeft <= 3
    ) {
      out.push({
        id: "billing:trial-soon",
        tone: "warning",
        icon: Clock,
        title: `Trial ends in ${sub.trialDaysLeft} day${sub.trialDaysLeft === 1 ? "" : "s"}`,
        body: "Upgrade now to avoid interruption.",
        href: "/dashboard/billing",
      });
    }
    // Same defensive guard as <SubscriptionBanner>: suppress phantom
    // "blocked at zero usage" so a fresh trial doesn't surface an alarming
    // notification before the merchant has done anything. And prettify the
    // raw camelCase metric identifier into something a human can read.
    const blocked = usage.data?.meters.find(
      (m) => m.blocked && (m.used ?? 0) > 0,
    );
    if (blocked) {
      out.push({
        id: `usage:blocked:${blocked.metric}`,
        tone: "danger",
        icon: AlertCircle,
        title: `Quota exceeded: ${humanMetric(blocked.metric)}`,
        body: "Upgrade your plan to keep operating.",
        href: "/dashboard/billing",
      });
    }
    const warning = usage.data?.meters.find(
      (m) => m.warning && !m.blocked && (m.used ?? 0) > 0,
    );
    if (warning) {
      out.push({
        id: `usage:warn:${warning.metric}`,
        tone: "warning",
        icon: TrendingUp,
        title: `${Math.round(warning.ratio * 100)}% of ${humanMetric(warning.metric)} quota used`,
        body: "Consider upgrading before you hit the limit.",
        href: "/dashboard/billing",
      });
    }

    // Fraud queue.
    const queue = fraudStats.data?.queue;
    if (queue && queue.pending > 0) {
      out.push({
        id: "fraud:pending",
        tone: "warning",
        icon: ShieldAlert,
        title: `${queue.pending} order${queue.pending === 1 ? "" : "s"} pending call review`,
        body: "These orders cannot be booked until reviewed.",
        href: "/dashboard/fraud-review",
      });
    }
    if (queue && queue.noAnswer > 0) {
      out.push({
        id: "fraud:noanswer",
        tone: "danger",
        icon: PhoneOff,
        title: `${queue.noAnswer} order${queue.noAnswer === 1 ? "" : "s"} marked no answer`,
        body: "Try calling again or reject if unreachable.",
        href: "/dashboard/fraud-review",
      });
    }

    // Recent calls — surface the latest unanswered ones.
    const calls = recentCalls.data?.calls ?? [];
    for (const call of calls) {
      if (!call.answered) {
        out.push({
          id: `call:${call.id}`,
          tone: "info",
          icon: PhoneOff,
          title: `Missed call: ${call.customerPhone ?? "Unknown"}`,
          body: call.deliveryStatus
            ? `Status: ${call.deliveryStatus}`
            : "Tap to retry from the call center.",
          href: "/dashboard/call-customer",
          timestamp: call.timestamp,
        });
      }
    }

    if (out.length === 0 && fraudStats.data?.today.codSaved && fraudStats.data.today.codSaved > 0) {
      out.push({
        id: "win:cod-saved",
        tone: "success",
        icon: CheckCircle2,
        title: "Nice — fraud queue saved you money today",
        body: "Risk reviews are paying off.",
        href: "/dashboard/fraud-review",
      });
    }

    return out;
  }, [fraudStats.data, plan.data, usage.data, recentCalls.data]);

  const isLoading =
    fraudStats.isLoading || plan.isLoading || usage.isLoading || recentCalls.isLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-sm border-l border-stroke/10 bg-surface-overlay p-0"
      >
        <SheetHeader className="border-b border-stroke/8 px-5 py-4 text-left">
          <SheetTitle className="text-base font-semibold text-fg">
            Notifications
          </SheetTitle>
          <SheetDescription className="text-xs text-fg-subtle">
            What needs your attention right now.
          </SheetDescription>
        </SheetHeader>

        <div className="max-h-[calc(100vh-72px)] overflow-y-auto px-3 py-3">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-16 animate-shimmer rounded-md" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Inbox}
              tone="success"
              title="You're all caught up"
              description="No alerts, no overdue reviews, no quota warnings."
              className="border-0 bg-transparent"
            />
          ) : (
            <ul className="space-y-1.5">
              {items.map((item) => {
                const Icon = item.icon;
                const Wrapper: React.ElementType = item.href ? Link : "div";
                const wrapperProps = item.href
                  ? { href: item.href, onClick: () => onOpenChange(false) }
                  : {};
                return (
                  <li key={item.id}>
                    <Wrapper
                      {...wrapperProps}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border border-stroke/8 bg-surface px-3 py-2.5 transition-colors",
                        item.href && "hover:border-stroke/16 hover:bg-surface-raised/60",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                          TONE_BADGE[item.tone],
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-sm font-medium text-fg">{item.title}</p>
                        {item.body ? (
                          <p className="text-xs text-fg-subtle">{item.body}</p>
                        ) : null}
                        {item.timestamp ? (
                          <p className="text-2xs text-fg-faint">
                            {formatRelative(item.timestamp)}
                          </p>
                        ) : null}
                      </div>
                    </Wrapper>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function useNotificationCount(): number {
  const fraudStats = trpc.fraud.getReviewStats.useQuery({ days: 7 });
  const plan = trpc.billing.getPlan.useQuery(undefined, { staleTime: 60_000 });
  const usage = trpc.billing.getUsage.useQuery(undefined, { staleTime: 60_000 });
  const sub = plan.data?.subscription;
  const queue = fraudStats.data?.queue;
  let count = 0;
  if (sub?.status === "past_due") count++;
  if (sub?.trialExpired) count++;
  if (
    sub?.status === "trial" &&
    typeof sub.trialDaysLeft === "number" &&
    sub.trialDaysLeft <= 3
  ) {
    count++;
  }
  count += usage.data?.meters.filter((m) => m.blocked).length ?? 0;
  count += usage.data?.meters.filter((m) => m.warning && !m.blocked).length ?? 0;
  if (queue && queue.pending > 0) count++;
  if (queue && queue.noAnswer > 0) count++;
  return count;
}
