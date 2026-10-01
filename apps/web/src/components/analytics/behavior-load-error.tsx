import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A behavior-analytics section and whether its query failed. */
export interface SectionStatus {
  label: string;
  isError: boolean;
}

/** Labels of the sections whose data failed to load (in display order). */
export function failedSections(sections: SectionStatus[]): string[] {
  return sections.filter((s) => s.isError).map((s) => s.label);
}

/**
 * Shown when one or more behavior queries failed. Without it a failed
 * request rendered exactly like "no data yet" (0 sessions, 0%), which a
 * merchant reads as "my storefront has no traffic".
 */
export function BehaviorLoadError({ failed, onRetry }: { failed: string[]; onRetry: () => void }) {
  if (failed.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-danger-border bg-danger-subtle p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-fg">Couldn&apos;t load some analytics</p>
          <p className="text-xs text-fg-muted">
            {failed.join(", ")} didn&apos;t load. The numbers below for these sections are unavailable, not zero.
          </p>
        </div>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>
        <RotateCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        Retry
      </Button>
    </div>
  );
}
