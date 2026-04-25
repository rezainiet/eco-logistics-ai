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
};

const TONE_CLASS: Record<NonNullable<EmptyStateProps["tone"]>, string> = {
  neutral: "bg-surface-raised/60 text-fg-subtle",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  tone = "neutral",
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-stroke/12 px-6 py-12 text-center",
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
