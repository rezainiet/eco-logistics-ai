import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical KPI grid for operational pages. Replaces three slightly
 * different hand-rolled grids that had drifted across the dashboard:
 *
 *   - dashboard home   grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4
 *   - fraud-review     grid       gap-3 sm:grid-cols-2 xl:grid-cols-4   (no grid-cols-1)
 *   - recovery         grid       gap-3 md:grid-cols-2 xl:grid-cols-4   (md, not sm)
 *
 * Tight `gap-4` (16px) — operational density is intentional. KPI cards
 * are read scanning, not browsing; widening the gutter pushes the
 * fourth column off-screen on common laptop widths.
 */
export function KpiGrid({
  children,
  className,
  ariaLabel = "Key metrics",
}: {
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4",
        className,
      )}
    >
      {children}
    </section>
  );
}
