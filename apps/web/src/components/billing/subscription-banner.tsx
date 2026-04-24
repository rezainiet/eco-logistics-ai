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
    return (
      <Banner tone="error" icon={<AlertCircle className="h-4 w-4" />}>
        Your subscription is <strong>past due</strong>.{" "}
        <Link href="/dashboard/billing" className="underline">
          Submit a payment
        </Link>{" "}
        to restore access.
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
      ? "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[#F87171]"
      : tone === "warning"
        ? "border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] text-[#FBBF24]"
        : "border-[rgba(59,130,246,0.3)] bg-[rgba(59,130,246,0.08)] text-[#93C5FD]";
  return (
    <div className={`mb-4 flex items-start gap-2 rounded-md border ${styles} px-3 py-2 text-sm`}>
      <span className="mt-0.5">{icon}</span>
      <span>{children}</span>
    </div>
  );
}
