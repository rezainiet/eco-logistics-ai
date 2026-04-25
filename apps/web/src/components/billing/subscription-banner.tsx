"use client";

import Link from "next/link";
import { AlertCircle, Clock, TrendingUp } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * Cross-dashboard banner. Silent when everything's fine; loud when the merchant
 * needs to renew, pay, or upgrade. Rendered once in the dashboard layout so it
 * stays visible as the merchant navigates.
 */
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
        to keep using Logistics.
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

  const atQuotaLimit = usage.data?.meters.find((m) => m.blocked);
  if (atQuotaLimit) {
    return (
      <Banner tone="error" icon={<AlertCircle className="h-4 w-4" />}>
        You've hit your monthly quota for <strong>{atQuotaLimit.metric}</strong>.{" "}
        <Link href="/dashboard/billing" className="underline">
          Upgrade your plan
        </Link>{" "}
        to continue.
      </Banner>
    );
  }

  const nearLimit = usage.data?.meters.find((m) => m.warning && !m.blocked);
  if (nearLimit) {
    return (
      <Banner tone="warning" icon={<TrendingUp className="h-4 w-4" />}>
        You're at {Math.round(nearLimit.ratio * 100)}% of your monthly{" "}
        <strong>{nearLimit.metric}</strong> quota.{" "}
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
