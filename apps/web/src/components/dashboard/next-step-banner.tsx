"use client";

import Link from "next/link";
import { ArrowRight, PackagePlus, Plug, Sparkles, Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";

/**
 * State-aware "next step" prompt rendered at the top of the dashboard.
 *
 * Decision tree (first match wins):
 *   1. No store connected    → "Connect your store" (Shopify / WooCommerce)
 *   2. Connected, no orders  → "Import your orders"
 *   3. Has orders, no courier → "Connect your courier"
 *   4. Has courier, no orders → "Add your first order"   [legacy CSV path]
 *   5. Automation off         → "Turn on automation"
 *   6. Otherwise              → render nothing
 *
 * Uses the same cached tRPC queries as <OnboardingChecklist /> and
 * <NewMerchantRedirect />, so this guard adds zero network round-trips.
 */
export function NextStepBanner() {
  const couriers = trpc.merchants.getCouriers.useQuery(undefined, {
    staleTime: 60_000,
  });
  const orders = trpc.orders.listOrders.useQuery(
    { limit: 1 } as never,
    { staleTime: 60_000 },
  );
  const automation = trpc.merchants.getAutomationConfig.useQuery(undefined, {
    staleTime: 60_000,
  });
  const integrations = trpc.integrations.list.useQuery(undefined, {
    staleTime: 60_000,
  });

  if (
    couriers.isLoading ||
    orders.isLoading ||
    automation.isLoading ||
    integrations.isLoading
  )
    return null;
  if (
    couriers.isError ||
    orders.isError ||
    automation.isError ||
    integrations.isError
  )
    return null;

  const courierCount = (couriers.data ?? []).length;
  const orderCount = orders.data?.items?.length ?? 0;
  const automationOn = automation.data?.enabled === true;
  const hasStoreConnected = (integrations.data ?? []).some(
    (i) => i.provider !== "csv" && i.status === "connected",
  );

  let step: {
    icon: typeof Truck;
    title: string;
    body: string;
    cta: string;
    href: string;
    tone: string;
  } | null = null;

  if (!hasStoreConnected) {
    step = {
      icon: Plug,
      title: "Next step: Connect your store",
      body:
        "Connect Shopify or WooCommerce in under 2 minutes — new orders will start syncing automatically.",
      cta: "Connect store",
      href: "/dashboard/integrations",
      tone: "border-brand/30 bg-brand/8",
    };
  } else if (orderCount === 0) {
    step = {
      icon: PackagePlus,
      title: "Next step: Import your orders",
      body:
        "Pull your last 25 orders so the dashboard fills up. New orders flow in automatically from now on.",
      cta: "Import orders",
      href: "/dashboard/integrations",
      tone: "border-brand/30 bg-brand/8",
    };
  } else if (courierCount === 0) {
    step = {
      icon: Truck,
      title: "Next step: Connect your courier",
      body:
        "Add Steadfast, Pathao, RedX, or another supported courier so we can book pickups for you.",
      cta: "Add courier",
      href: "/dashboard/settings?tab=couriers",
      tone: "border-brand/30 bg-brand/8",
    };
  } else if (!automationOn) {
    step = {
      icon: Sparkles,
      title: "Next step: Turn on automation",
      body:
        "Pick a mode (manual, semi-auto, or full auto). Low-risk orders will confirm on their own; risky ones go to your review queue.",
      cta: "Enable automation",
      href: "/dashboard/settings?tab=automation",
      tone: "border-brand/30 bg-brand/8",
    };
  }

  if (!step) return null;
  const Icon = step.icon;
  return (
    <Card className={`mb-4 ${step.tone}`}>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/14 text-brand">
            <Icon className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">{step.title}</p>
            <p className="mt-0.5 text-xs text-fg-muted">{step.body}</p>
          </div>
        </div>
        <Link
          href={step.href}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
        >
          {step.cta}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </CardContent>
    </Card>
  );
}
