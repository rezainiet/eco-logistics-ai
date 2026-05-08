import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  /**
   * `card` (default) — standalone empty surface with its own dashed
   *   outline. Use when the empty state is the only content in a
   *   region.
   * `inset` — no border, no rounded surface, tighter vertical
   *   padding. Use when the empty state already sits inside a
   *   bordered container (Card, Table cell). Avoids the
   *   double-border that earlier callers worked around with
   *   `className="border-0 bg-transparent"`.
   */
  variant?: "card" | "inset";
};

const TONE_CLASS: Record<NonNullable<EmptyStateProps["tone"]>, string> = {
  neutral: "bg-surface-raised/60 text-fg-subtle",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
};

const VARIANT_CLASS: Record<NonNullable<EmptyStateProps["variant"]>, string> = {
  card: "rounded-xl border border-dashed border-stroke/12 px-6 py-12",
  inset: "px-6 py-10",
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  tone = "neutral",
  variant = "card",
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 text-center",
        VARIANT_CLASS[variant],
        className,
      )}
    >
      {Icon ? (
        <div
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full",
            TONE_CLASS[tone],
          )}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-fg">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-xs text-fg-subtle">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
