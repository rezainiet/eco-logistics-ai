import { cn } from "@/lib/utils";

/**
 * Generic shimmer-block. Use for any "we're fetching" placeholder —
 * KPI cards, table rows, dialog bodies — so the merchant always sees
 * a layout-stable preview rather than a blank space.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-shimmer rounded-md bg-surface-raised/60",
        className,
      )}
    />
  );
}

/** Stack of N rectangles for table-style placeholders. */
export function SkeletonRows({
  count = 6,
  rowClassName,
}: {
  count?: number;
  rowClassName?: string;
}) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={cn("h-12 w-full", rowClassName)} />
      ))}
    </div>
  );
}
