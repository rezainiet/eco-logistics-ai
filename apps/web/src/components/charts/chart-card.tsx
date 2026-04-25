import * as React from "react";
import { cn } from "@/lib/utils";

type ChartCardProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
};

export function ChartCard({
  title,
  description,
  action,
  footer,
  children,
  className,
  bodyClassName,
}: ChartCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-stroke/10 bg-surface shadow-card",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {description ? <p className="text-xs text-fg-subtle">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={cn("flex-1 px-3 pb-4", bodyClassName)}>{children}</div>
      {footer ? (
        <div className="border-t border-stroke/8 px-5 py-3 text-xs text-fg-subtle">{footer}</div>
      ) : null}
    </div>
  );
}
