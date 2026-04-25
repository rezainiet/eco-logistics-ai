"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Circle,
  PackageCheck,
  Plus,
  ShieldCheck,
  Sparkles,
  Truck,
  X,
  type LucideIcon,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Step = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  href: string;
  cta: string;
  done: boolean;
};

const DISMISS_KEY = "logistics:onboarding-dismissed";

export function OnboardingChecklist() {
  const dashboard = trpc.analytics.getDashboard.useQuery();
  const couriers = trpc.orders.listCouriers.useQuery(undefined, { staleTime: 60_000 });
  const fraudStats = trpc.fraud.getReviewStats.useQuery({ days: 30 });
  const [dismissed, setDismissed] = React.useState(false);
  const [analyticsVisited, setAnalyticsVisited] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    setAnalyticsVisited(
      window.localStorage.getItem("logistics:analytics-visited") === "1",
    );
  }, []);

  function dismiss() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DISMISS_KEY, "1");
    }
    setDismissed(true);
  }

  const totalOrders = dashboard.data?.totalOrders ?? 0;
  const pending = dashboard.data?.pending ?? 0;
  const courierCount = couriers.data?.length ?? 0;
  const reviewedCount =
    (fraudStats.data?.window.verified ?? 0) + (fraudStats.data?.window.rejected ?? 0);

  const steps: Step[] = [
    {
      id: "courier",
      title: "Connect a courier",
      description: "Add your Pathao / Steadfast / RedX credentials to enable booking.",
      icon: Truck,
      href: "/dashboard/settings",
      cta: "Add courier",
      done: courierCount > 0,
    },
    {
      id: "first-order",
      title: "Create your first order",
      description: "Add it manually or upload a CSV — both flow into the same queue.",
      icon: Plus,
      href: "/dashboard/orders",
      cta: "Open orders",
      done: totalOrders > 0,
    },
    {
      id: "first-booking",
      title: "Book a courier pickup",
      description: "Select an order and dispatch it through your connected courier.",
      icon: PackageCheck,
      href: "/dashboard/orders",
      cta: "Book a pickup",
      done: totalOrders > 0 && totalOrders - pending > 0,
    },
    {
      id: "fraud",
      title: "Review a flagged COD",
      description: "Verify or reject risky customers before they ship and prevent RTOs.",
      icon: ShieldCheck,
      href: "/dashboard/fraud-review",
      cta: "Open queue",
      done: reviewedCount > 0,
    },
    {
      id: "analytics",
      title: "Explore your analytics",
      description: "RTO rate, courier mix, and best time to call — all in one view.",
      icon: BarChart3,
      href: "/dashboard/analytics",
      cta: "View analytics",
      done: analyticsVisited,
    },
  ];

  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  const percent = Math.round((completed / total) * 100);
  const allDone = completed === total;

  // Hide once everything is complete OR explicitly dismissed.
  if (dismissed || allDone) return null;

  // Don't render until at least one query has resolved (avoid flicker).
  if (dashboard.isLoading || couriers.isLoading) return null;

  const nextStep = steps.find((s) => !s.done);

  return (
    <div className="overflow-hidden rounded-xl border border-stroke/10 bg-surface shadow-card">
      <div className="flex items-start justify-between gap-3 border-b border-stroke/8 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/14 text-brand">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-fg">Get set up</p>
            <p className="text-xs text-fg-subtle">
              {completed} of {total} done · {percent}% — finish setup to unlock the full
              workflow.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {nextStep ? (
            <Button asChild size="sm" className="bg-brand text-white hover:bg-brand-hover">
              <Link href={nextStep.href}>
                {nextStep.cta}
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          ) : null}
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss onboarding"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="h-1 w-full bg-surface-raised">
        <div
          className="h-full bg-brand transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      <ul className="grid gap-px bg-stroke/6 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <li
              key={step.id}
              className={cn(
                "flex flex-col gap-2 bg-surface px-4 py-4 transition-colors",
                !step.done && "hover:bg-surface-raised/40",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md",
                    step.done
                      ? "bg-success-subtle text-success"
                      : "bg-surface-raised text-fg-subtle",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                {step.done ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <Circle className="h-4 w-4 text-fg-faint" />
                )}
              </div>
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-fg">{step.title}</p>
                <p className="text-xs text-fg-subtle">{step.description}</p>
              </div>
              {!step.done ? (
                <Link
                  href={step.href}
                  className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-brand transition-colors hover:text-brand-hover"
                >
                  {step.cta}
                  <ArrowRight className="h-3 w-3" />
                </Link>
              ) : (
                <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-success">
                  Done
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
