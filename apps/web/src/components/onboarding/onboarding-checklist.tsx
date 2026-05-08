"use client";

import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Loader2,
  Lock,
  Sparkles,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  deriveOnboardingProgress,
  type OnboardingStep,
  type OnboardingStepKey,
} from "@/lib/onboarding/progress";

/**
 * Onboarding checklist. Lives on /dashboard/getting-started below the hero.
 *
 * The list used to render five equal-weight rows; that pattern presents a wall
 * of options to a brand-new merchant who really only needs to do one thing
 * next. This version focuses attention: the current step expands into a
 * full-width "Up next" card with a primary CTA and a time estimate; remaining
 * steps collapse into a compact list with subtle locked styling for steps that
 * are still gated by the current one.
 *
 * Every check is derived from existing tRPC endpoints — no new backend reads.
 * Each query has its own loading state so a slow lookup never blocks the rest.
 * If any query errors we fall back to "not done" rather than silently marking
 * things complete.
 */

const STEP_TIMES: Record<OnboardingStepKey, string> = {
  connect_store: "about 3 minutes",
  import_orders: "about 1 minute",
  add_courier: "about 2 minutes",
  enable_automation: "about 1 minute",
  test_sms: "about 1 minute",
};

// Hints lead with merchant benefit, not a technology list. The
// platform list ("Shopify · Pathao · …") was the original copy and it
// implicitly asked the merchant to learn our taxonomy before knowing
// why the step matters. Benefit-first reads cleaner on first-touch.
const STEP_HINTS: Record<OnboardingStepKey, string> = {
  connect_store:
    "So Cordon sees every order the moment it's placed (Shopify · WooCommerce)",
  import_orders:
    "Pulls your most recent orders so the dashboard isn't empty on day one",
  add_courier:
    "So we can book and track shipments automatically (Pathao · Steadfast · RedX)",
  enable_automation:
    "Picks who to confirm via SMS and who to send straight to the courier",
  test_sms:
    "Confirms your merchant SMS templates actually reach a real handset",
};

export function OnboardingChecklist({
  collapseWhenComplete = true,
}: {
  collapseWhenComplete?: boolean;
}) {
  const couriers = trpc.merchants.getCouriers.useQuery(undefined, { staleTime: 60_000 });
  const orders = trpc.orders.listOrders.useQuery(
    { limit: 5 } as never,
    { staleTime: 60_000 },
  );
  const automation = trpc.merchants.getAutomationConfig.useQuery(undefined, { staleTime: 60_000 });
  const integrations = trpc.integrations.list.useQuery(undefined, { staleTime: 60_000 });

  const loading =
    couriers.isLoading ||
    orders.isLoading ||
    automation.isLoading ||
    integrations.isLoading;
  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your setup…
        </CardContent>
      </Card>
    );
  }

  const hasCourier = (couriers.data ?? []).length > 0;
  const ordersData = orders.data as
    | { items?: Array<{ automationState?: string; bookedByAutomation?: boolean }> }
    | Array<{ automationState?: string; bookedByAutomation?: boolean }>
    | undefined
    | null;
  const ordersList = Array.isArray(ordersData)
    ? ordersData
    : Array.isArray(ordersData?.items)
      ? ordersData.items
      : [];
  const hasFirstOrder = ordersList.length > 0;
  const automationOn = automation.data?.enabled === true;
  const hasStoreConnected = (integrations.data ?? []).some(
    (i) => i.provider !== "csv" && i.status === "connected",
  );
  const smsTested = ordersList.some(
    (o) =>
      Boolean(o.bookedByAutomation) ||
      (typeof o.automationState === "string" &&
        ["auto_confirmed", "confirmed", "needs_call", "auto_cancelled"].includes(o.automationState)),
  );

  const progress = deriveOnboardingProgress({
    hasStoreConnected,
    hasCourier,
    hasFirstOrder,
    automationOn,
    smsTested,
  });

  if (collapseWhenComplete && progress.complete) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4 text-sm">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-success" aria-hidden />
            <span className="font-medium text-fg">You&apos;re fully set up.</span>
            <span className="text-fg-muted">Automation is running on every new order.</span>
          </div>
          <Link
            href="/dashboard/orders"
            className="text-sm font-medium text-info hover:underline"
          >
            View orders →
          </Link>
        </CardContent>
      </Card>
    );
  }

  const next = progress.nextStep;
  const upcoming = next
    ? progress.steps.filter((s) => s.key !== next.key)
    : progress.steps;
  const currentIndex = next
    ? progress.steps.findIndex((s) => s.key === next.key)
    : -1;

  return (
    <div className="space-y-3">
      {next ? <NextStepCard step={next} index={currentIndex} total={progress.totalCount} /> : null}
      <UpcomingSteps steps={upcoming} currentIndex={currentIndex} totalSteps={progress.totalCount} />
    </div>
  );
}

function NextStepCard({
  step,
  index,
  total,
}: {
  step: OnboardingStep;
  index: number;
  total: number;
}) {
  return (
    <Card className="relative overflow-hidden border-info/30 bg-info/5 animate-slide-up">
      <CardContent className="flex flex-col gap-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-info/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-info">
            Up next · step {index + 1} of {total}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
            <Clock3 className="h-3 w-3" aria-hidden />
            {STEP_TIMES[step.key]}
          </span>
        </div>
        <div>
          <h2 className="text-lg font-semibold text-fg">{step.title}</h2>
          <p className="mt-1.5 max-w-2xl text-sm text-fg-muted">{step.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="default">
            <Link href={step.ctaHref}>
              {step.ctaLabel}
              <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
            </Link>
          </Button>
          <Link
            href="/dashboard"
            className="text-xs font-medium text-fg-muted hover:text-fg"
          >
            Skip for now
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function UpcomingSteps({
  steps,
  currentIndex,
  totalSteps,
}: {
  steps: OnboardingStep[];
  currentIndex: number;
  totalSteps: number;
}) {
  if (steps.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <ul role="list" className="divide-y divide-border/60">
          {steps.map((step) => {
            const realIndex = totalSteps - steps.length + steps.indexOf(step);
            // Compute the step's true ordinal number from the master list.
            const ordinal = getOrdinalForKey(step.key);
            const locked = !step.done && ordinal > currentIndex + 1;
            return (
              <li
                key={step.key}
                className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <StepBullet done={step.done} ordinal={ordinal} locked={locked} />
                  <div className="min-w-0">
                    <p
                      className={`truncate text-sm font-medium ${
                        step.done ? "text-fg-muted line-through" : "text-fg"
                      }`}
                    >
                      {step.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-fg-faint">
                      <span className="text-fg-muted">{STEP_TIMES[step.key]}</span>
                      <span aria-hidden className="px-1.5 text-fg-faint/60">·</span>
                      <span>{STEP_HINTS[step.key]}</span>
                    </p>
                  </div>
                </div>
                <div className="shrink-0">
                  {step.done ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                      Done
                    </span>
                  ) : locked ? (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-faint">
                      <Lock className="h-3 w-3" aria-hidden />
                      Locked
                    </span>
                  ) : (
                    <Button asChild size="sm" variant="outline">
                      <Link href={step.ctaHref}>
                        {step.ctaLabel}
                        <ArrowRight className="ml-1 h-3 w-3" aria-hidden />
                      </Link>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function StepBullet({
  done,
  ordinal,
  locked,
}: {
  done: boolean;
  ordinal: number;
  locked: boolean;
}) {
  if (done) {
    return (
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/15"
        aria-hidden
      >
        <CheckCircle2 className="h-4 w-4 text-success" />
      </span>
    );
  }
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums ${
        locked
          ? "border-border bg-surface-raised text-fg-faint"
          : "border-fg-subtle/40 text-fg-muted"
      }`}
      aria-hidden
    >
      {ordinal}
    </span>
  );
}

function getOrdinalForKey(key: OnboardingStepKey): number {
  const order: Record<OnboardingStepKey, number> = {
    connect_store: 1,
    import_orders: 2,
    add_courier: 3,
    enable_automation: 4,
    test_sms: 5,
  };
  return order[key];
}
