"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Hover/focus tooltip backed by `relative` + an absolute-positioned card.
 *
 * Avoids pulling in `@radix-ui/react-tooltip` for a single feature — we
 * mostly need it for "Upgrade to X" hints on locked features. It is a
 * controlled component (visible on hover OR focus, hides on blur) so
 * keyboard users can still see the tooltip.
 */

interface TooltipProps {
  content: React.ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  children: React.ReactNode;
}

export function Tooltip({
  content,
  side = "top",
  align = "center",
  className,
  children,
}: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      <span
        role="tooltip"
        aria-hidden={!open}
        className={cn(
          "pointer-events-none absolute z-50 w-max max-w-xs rounded-md border border-stroke/14 bg-surface-overlay px-2.5 py-1.5 text-xs text-fg shadow-elevated transition-opacity",
          open ? "opacity-100" : "opacity-0",
          side === "top" ? "bottom-full mb-2" : "top-full mt-2",
          align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
        )}
      >
        {content}
      </span>
    </span>
  );
}
