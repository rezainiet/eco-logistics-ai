"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Circle,
  PackageCheck,
  PartyPopper,
  Plug,
  Plus,
  ShieldCheck,
  Sparkles,
  Truck,
  X,
  type LucideIcon,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Step = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  href: string;
  cta: string;
  done: boolean;
  /** Rough effort hint shown on the card so merchants know what they're committing to. */
  estimate: string;
};

const DISMISS_KEY = "logistics:onboarding-dismissed";

export function OnboardingChecklist() {
  const dashboard = trpc.analytics.getDashboard.useQuery();
  const couriers = trpc.orders.listCouriers.useQuery(undefined, { staleTime: 60_000 });
  const fraudStats = trpc.fraud.getReviewStats.useQuery({ days: 30 });
  // Install verification arrives from the same query the integrations page
  // already uses — re-using it keeps the cache hot across the dashboard.
  const tracking = trpc.tracking.getInstallation.useQuery(undefined, {
    staleTime: 60_000,
  });
  const integrations = trpc.integrations.list.useQuery(undefined, {
    staleTime: 60_000,
  });
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
  const installStatus = tracking.data?.install?.status;
  const trackerInstalled =
    installStatus === "healthy" || installStatus === "stale";
  const liveConnectorCount =
    integrations.data?.filter(
      (i) => i.provider !== "csv" && i.status === "connected",
    ).length ?? 0;

  const steps: Step[] = [
    {
      id: "courier",
      title: "Connect a courier",
      description: "Add your Pathao / Steadfast / RedX credentials to enable booking.",
      icon: Truck,
      href: "/dashboard/settings",
      cta: "Add courier",
      estimate: "2 min",
      done: courierCount > 0,
    },
    {
      id: "integration",
      title: "Connect your store",
      description: "Sync orders from Shopify, WooCommerce, or push from your custom backend.",
      icon: Plug,
      href: "/dashboard/integrations",
      cta: "Open integrations",
      estimate: "5 min",
      done: liveConnectorCount > 0,
    },
    {
      id: "tracker",
      title: "Install the behavior tracker",
      description:
        "Drop one snippet on every page so RTO predictions and abandoned-cart recovery work.",
      icon: Activity,
      href: "/dashboard/integrations",
      cta: trackerInstalled ? "Tracker live" : "Get snippet",
      estimate: "3 min",
      done: trackerInstalled,
    },
    {
      id: "first-order",
      title: "Create your first order",
      description: "Add it manually or upload a CSV — both flow into the same queue.",
      icon: Plus,
      href: "/dashboard/orders",
      cta: "Open orders",
      estimate: "1 min",
      done: totalOrders > 0,
    },
    {
      id: "first-booking",
      title: "Book a courier pickup",
      description: "Select an order and dispatch it through your connected courier.",
      icon: PackageCheck,
      href: "/dashboard/orders",
      cta: "Book a pickup",
      estimate: "1 min",
      done: totalOrders > 0 && totalOrders - pending > 0,
    },
    {
      id: "fraud",
      title: "Review a flagged COD",
      description: "Verify or reject risky customers before they ship and prevent RTOs.",
      icon: ShieldCheck,
      href: "/dashboard/fraud-review",
      cta: "Open queue",
      estimate: "1 min",
      done: reviewedCount > 0,
    },
    {
      id: "analytics",
      title: "Explore your analytics",
      description: "RTO rate, courier mix, and best time to call — all in one view.",
      icon: BarChart3,
      href: "/dashboard/analytics",
      cta: "View analytics",
      estimate: "2 min",
      done: analyticsVisited,
    },
  ];

  // Sort: incomplete first (in original order), then completed. Keeps the
  // next thing to do top-left so the merchant can fly through setup.
  const orderedSteps = [...steps].sort((a, b) => Number(a.done) - Number(b.done));

  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  const percent = Math.round((completed / total) * 100);
  const allDone = completed === total;

  // Celebrate transitions: when a step flips to done, fire a toast once.
  // We track previously-done ids in a ref so we don't re-toast on every
  // re-render — only on the *transition* from pending → done.
  const seenDoneRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    const prev = seenDoneRef.current;
    if (prev === null) {
      // First render — capture the initial set without firing toasts. The
      // merchant could already have steps done from a previous session.
      seenDoneRef.current = new Set(steps.filter((s) => s.done).map((s) => s.id));
      return;
    }
    for (const step of steps) {
      if (step.done && !prev.has(step.id)) {
        prev.add(step.id);
        toast.success(`${step.title} — done!`, "Onboarding progress saved.");
      }
    }
    if (allDone) {
      // Only celebrate the final done once; the dismissed flag below stops
      // future renders so this naturally fires at most once per session.
      toast.success("You're set up! 🎉", "Your workspace is ready to go.");
    }
    // We deliberately depend on `completed` (number) rather than `steps`
    // (object identity changes every render). When `completed` doesn't move,
    // nothing changed worth celebrating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completed, allDone]);

  // Hide once everything is complete OR explicitly dismissed.
  if (dismissed || allDone) return null;

  // Don't render until at least one query has resolved (avoid flicker).
  if (dashboard.isLoading || couriers.isLoading) return null;

  // Use the original order so we recommend earlier steps first when
  // multiple are incomplete (courier before tracker, before first-order…).
  const nextStep = steps.find((s) => !s.done);
  const remainingMins = steps
    .filter((s) => !s.done)
    .reduce((sum, s) => {
      const m = Number.parseInt(s.estimate, 10);
      return sum + (Number.isFinite(m) ? m : 0);
    }, 0);

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
              {completed} of {total} done · {percent}%
              {remainingMins > 0 ? ` · about ${remainingMins} min left` : ""} — finish setup to unlock the full
              workflow.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {nextStep ? (
            <Button
              asChild
              size="sm"
              className="bg-brand text-white shadow-glow hover:bg-brand-hover"
            >
              <Link href={nextStep.href} aria-label={`Next step: ${nextStep.title}`}>
                <span className="hidden sm:inline">Next:&nbsp;</span>
                <span className="font-semibold">{nextStep.cta}</span>
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

      <ul className="grid gap-px bg-stroke/6 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {orderedSteps.map((step) => {
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
                <div className="flex items-center gap-1.5">
                  {!step.done ? (
                    <span className="text-2xs font-medium text-fg-faint">{step.estimate}</span>
                  ) : null}
                  <AnimatePresence mode="wait" initial={false}>
                    {step.done ? (
                      <motion.span
                        key="done"
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 380, damping: 18 }}
                        className="inline-flex"
                      >
                        <CheckCircle2 className="h-4 w-4 text-success" />
                      </motion.span>
                    ) : (
                      <motion.span
                        key="todo"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="inline-flex"
                      >
                        <Circle className="h-4 w-4 text-fg-faint" />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
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
