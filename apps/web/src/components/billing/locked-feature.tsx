"use client";

import Link from "next/link";
import { ArrowUpRight, Lock } from "lucide-react";
import { PLANS, type PlanTier } from "@ecom/types";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const TIER_LABEL: Record<PlanTier, string> = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
  enterprise: "Enterprise",
};

interface LockedFeatureProps {
  /** The plan tier required to unlock the feature. Tooltip recommends this tier. */
  requiredTier: PlanTier;
  /** Whether the feature is currently locked (false = render children pristine). */
  locked: boolean;
  /** Human-readable feature name shown in the tooltip ("Behavior analytics"). */
  feature: string;
  /** Optional one-line value pitch ("Spot abandoned-cart sessions before they convert."). */
  hint?: string;
  /** Tooltip alignment. Defaults to bottom-start so wrapped sidebar items don't clip. */
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  children: React.ReactNode;
}

/**
 * Wraps a UI region that's gated by plan tier. When locked we render the
 * children dimmed + non-interactive and overlay a tooltip with a deep link
 * to /pricing on hover/focus. When unlocked we render children pristine
 * (no extra DOM cost).
 *
 * Usage:
 *   <LockedFeature
 *     requiredTier="growth"
 *     locked={!entitlements.behaviorAnalytics}
 *     feature="Behavior analytics"
 *     hint="See abandoned-cart sessions before they convert."
 *   >
 *     <BehaviorAnalyticsTabs />
 *   </LockedFeature>
 */
export function LockedFeature({
  requiredTier,
  locked,
  feature,
  hint,
  side = "top",
  align = "center",
  className,
  children,
}: LockedFeatureProps) {
  if (!locked) return <>{children}</>;
  const plan = PLANS[requiredTier];
  return (
    <Tooltip
      side={side}
      align={align}
      content={
        <span className="flex flex-col gap-1.5 text-left">
          <span className="flex items-center gap-1.5 font-medium text-fg">
            <Lock className="h-3 w-3 text-warning" />
            {feature} requires {TIER_LABEL[requiredTier]}
          </span>
          {hint ? <span className="text-fg-subtle">{hint}</span> : null}
          <Link
            href={`/dashboard/billing?upgrade=${requiredTier}`}
            className="inline-flex items-center gap-1 text-brand underline-offset-4 hover:underline"
          >
            Upgrade for ৳{plan.priceBDT.toLocaleString()} / mo
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </span>
      }
    >
      <span
        aria-disabled
        className={cn(
          "relative inline-flex w-full opacity-60 grayscale-[20%]",
          className,
        )}
      >
        <span className="pointer-events-none w-full select-none" aria-hidden>
          {children}
        </span>
        <Lock className="absolute right-2 top-2 h-3.5 w-3.5 text-warning" />
      </span>
    </Tooltip>
  );
}

/**
 * Inline variant — for short text or a single button. No grayscale, no lock
 * badge overlay, just a tooltip and a dimmed wrapper.
 */
export function InlineLockedFeature({
  requiredTier,
  locked,
  feature,
  hint,
  children,
}: Pick<LockedFeatureProps, "requiredTier" | "locked" | "feature" | "hint" | "children">) {
  if (!locked) return <>{children}</>;
  const plan = PLANS[requiredTier];
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1 text-left">
          <span className="flex items-center gap-1 font-medium text-fg">
            <Lock className="h-3 w-3 text-warning" />
            {feature} · {TIER_LABEL[requiredTier]}
          </span>
          {hint ? <span className="text-fg-subtle">{hint}</span> : null}
          <Link
            href={`/dashboard/billing?upgrade=${requiredTier}`}
            className="text-brand underline-offset-4 hover:underline"
          >
            Upgrade — ৳{plan.priceBDT.toLocaleString()} / mo
          </Link>
        </span>
      }
    >
      <span aria-disabled className="inline-flex cursor-not-allowed items-center gap-1 text-fg-faint">
        <Lock className="h-3 w-3 text-warning" />
        {children}
      </span>
    </Tooltip>
  );
}
