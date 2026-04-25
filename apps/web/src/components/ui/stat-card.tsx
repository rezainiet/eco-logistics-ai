"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "@/components/charts/sparkline";

export type StatTone = "brand" | "success" | "warning" | "danger" | "violet" | "info";

const TONE: Record<StatTone, { icon: string; spark: string }> = {
  brand: { icon: "bg-brand/12 text-brand", spark: "hsl(202 100% 55%)" },
  success: { icon: "bg-success-subtle text-success", spark: "hsl(160 84% 45%)" },
  warning: { icon: "bg-warning-subtle text-warning", spark: "hsl(38 92% 55%)" },
  danger: { icon: "bg-danger-subtle text-danger", spark: "hsl(0 84% 66%)" },
  violet: { icon: "bg-[hsl(262_83%_62%/0.12)] text-[hsl(262_83%_72%)]", spark: "hsl(262 83% 68%)" },
  info: { icon: "bg-info-subtle text-info", spark: "hsl(217 91% 66%)" },
};

type StatCardProps = {
  label: string;
  value: React.ReactNode;
  delta?: { value: number; label?: string; direction?: "up" | "down" | "flat" };
  invertDelta?: boolean; // true when "down" is good (e.g., RTO rate)
  icon?: LucideIcon;
  tone?: StatTone;
  sparkData?: number[];
  loading?: boolean;
  footer?: React.ReactNode;
  className?: string;
};

export function StatCard({
  label,
  value,
  delta,
  invertDelta,
  icon: Icon,
  tone = "brand",
  sparkData,
  loading,
  footer,
  className,
}: StatCardProps) {
  const toneCfg = TONE[tone];

  const deltaDirection =
    delta?.direction ??
    (delta ? (delta.value > 0 ? "up" : delta.value < 0 ? "down" : "flat") : undefined);

  const positive = deltaDirection === "up";
  const negative = deltaDirection === "down";
  const isGood = invertDelta ? negative : positive;
  const isBad = invertDelta ? positive : negative;

  const deltaClass = isGood
    ? "text-success"
    : isBad
    ? "text-danger"
    : "text-fg-subtle";

  const DeltaIcon = deltaDirection === "up" ? ArrowUpRight : deltaDirection === "down" ? ArrowDownRight : Minus;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-stroke/10 bg-surface p-4 shadow-card transition-all hover:border-stroke/20 hover:shadow-elevated",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
          {label}
        </p>
        {Icon ? (
          <div
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg",
              toneCfg.icon,
            )}
            aria-hidden
          >
            <Icon className="h-4 w-4" />
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[28px] font-semibold leading-none tracking-tight text-fg">
            {loading ? <span className="inline-block h-7 w-20 animate-shimmer rounded-md align-middle" /> : value}
          </p>
          {delta ? (
            <div className={cn("inline-flex items-center gap-1 text-xs font-medium", deltaClass)}>
              <DeltaIcon className="h-3 w-3" aria-hidden />
              <span>
                {deltaDirection === "flat" ? "No change" : `${Math.abs(delta.value).toFixed(1)}%`}
              </span>
              {delta.label ? <span className="text-fg-faint">{delta.label}</span> : null}
            </div>
          ) : footer ? (
            <div className="text-xs text-fg-subtle">{footer}</div>
          ) : null}
        </div>
        {sparkData && sparkData.length > 1 ? (
          <div className="w-24 shrink-0">
            <Sparkline data={sparkData} color={toneCfg.spark} height={36} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
