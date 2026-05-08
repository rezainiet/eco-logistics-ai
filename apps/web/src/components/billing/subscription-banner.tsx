"use client";

import Link from "next/link";
import { AlertCircle, Clock, TrendingUp } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * Cross-dashboard banner. Silent when everything's fine; loud when the merchant
 * needs to renew, pay, or upgrade. Rendered once in the dashboard layout so it
 * stays visible as the merchant navigates.
 *
 * Metric names from the API (`fraudReviewsUsed`, `smsSent`, ...) are camelCase
 * identifiers — never show those raw to a merchant. `metricLabel()` maps them
 * to human copy, with a safe last-resort fallback that splits camelCase.
 *
 * Defensive guard: if a meter reports `blocked: true` but the recorded usage
 * is zero, treat it as a stale/init state (a fresh trial cannot have hit a
 * monthly cap) and stay silent rather than alarm the merchant. The real fix
 * lives server-side in the meter init data, but we don't want to leak that
 * footgun into the UI.
 */

const METRIC_LABELS: Record<string, string> = {
  fraudReviewsUsed: "fraud reviews this month",
  fraudReviews: "fraud reviews this month",
  smsSent: "SMS messages this month",
  smsUsed: "SMS messages this month",
  ordersIngested: "orders this month",
  ordersUsed: "orders this month",
  callMinutesUsed: "call minutes this month",
  webhookEvents: "webhook events this month",
};

function metricLabel(metric: string): string {
  if (METRIC_LABELS[metric]) return METRIC_LABELS[metric]!;
  // Fallback: split camelCase into words and lowercase the result.
  // "fraudReviewsUsed" → "fraud reviews used".
  return metric
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}
export function SubscriptionBanner() {
  const plan = trpc.billing.getPlan.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const usage = trpc.billing.getUsage.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const sub = plan.data?.subscription;
  if (!sub) return null;

  // Highest-priority banner wins. Order: past_due > expired trial > trial ending
  // > quota nearly exceeded.

  if (sub.status === "past_due") {
    const days = sub.graceDaysLeft;
    return (
      <Banner tone="error" icon={<AlertCircle className="h-4 w-4" />}>
        Payment failed —{" "}
        <strong>
          {days != null && days > 0
            ? `${days} day${days === 1 ? "" : "s"} of grace remaining`
            : "grace expired, suspension imminent"}
        </strong>
        .{" "}
        <Link href="/dashboard/billing" className="underline">
          Update payment
        </Link>{" "}
        to recover instantly.
      </Banner>
    );
  }
  if (sub.status === "suspended") {
    return (
      <Banner tone="error" icon={<AlertCircle className="h-4 w-4" />}>
        Your account is <strong>suspended</strong>.{" "}
        <Link href="/dashboard/billing" className="underline">
          Reactivate now
        </Link>{" "}
        — your data is intact.
      </Banner>
    );
  }

  if (sub.trialExpired) {
    return (
      <Banner tone="error" icon={<AlertCircle className="h-4 w-4" />}>
        Your 14-day trial has ended.{" "}
        <Link href="/dashboard/billing" className="underline">
          Choose a plan
        </Link>{" "}
        to keep using Cordon.
      </Banner>
    );
  }

  if (sub.status === "trial" && typeof sub.trialDaysLeft === "number" && sub.trialDaysLeft <= 3) {
    return (
      <Banner tone="warning" icon={<Clock className="h-4 w-4" />}>
        Trial ends in <strong>{sub.trialDaysLeft} day{sub.trialDaysLeft === 1 ? "" : "s"}</strong>.{" "}
        <Link href="/dashboard/billing" className="underline">
          Upgrade now
        </Link>{" "}
        to avoid interruption.
      </Banner>
    );
  }

  // Suppress phantom "blocked at zero usage" — a fresh meter cannot have hit
  // its cap. This guards against stale/init meter data leaking an alarming
  // banner into a brand-new merchant's first dashboard view.
  const atQuotaLimit = usage.data?.meters.find(
    (m) => m.blocked && (m.used ?? 0) > 0,
  );
  if (atQuotaLimit) {
    return (
      <Banner tone="error" icon={<AlertCircle className="h-4 w-4" />}>
        You've hit your monthly quota for{" "}
        <strong>{metricLabel(atQuotaLimit.metric)}</strong>.{" "}
        <Link href="/dashboard/billing" className="underline">
          Upgrade your plan
        </Link>{" "}
        to continue.
      </Banner>
    );
  }

  const nearLimit = usage.data?.meters.find(
    (m) => m.warning && !m.blocked && (m.used ?? 0) > 0,
  );
  if (nearLimit) {
    return (
      <Banner tone="warning" icon={<TrendingUp className="h-4 w-4" />}>
        You're at {Math.round(nearLimit.ratio * 100)}% of your monthly{" "}
        <strong>{metricLabel(nearLimit.metric)}</strong> quota.{" "}
        <Link href="/dashboard/billing" className="underline">
          Consider upgrading
        </Link>
        .
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "error" | "info";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles =
    tone === "error"
      ? "border-danger-border bg-danger-subtle text-danger"
      : tone === "warning"
        ? "border-warning-border bg-warning-subtle text-warning"
        : "border-info-border bg-info-subtle text-info";
  return (
    <div className={`mb-5 flex items-start gap-2 rounded-lg border ${styles} px-3.5 py-2.5 text-sm animate-fade-in`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}
