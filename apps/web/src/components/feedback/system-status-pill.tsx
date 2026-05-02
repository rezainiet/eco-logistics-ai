"use client";

import { trpc } from "@/lib/trpc";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

/**
 * Tiny green/yellow/red dot for the dashboard header. Reads the existing
 * health endpoint (already shipped). Refreshes every 60s.
 */
export function SystemStatusPill() {
  const health = trpc.health.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  if (health.isLoading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-xs text-fg-muted">
        <Loader2 className="h-3 w-3 animate-spin" /> checking…
      </span>
    );
  }

  if (health.error || !health.data?.ok) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger-subtle px-2 py-0.5 text-xs font-medium text-danger">
        <AlertCircle className="h-3 w-3" /> system issue
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-xs font-medium text-success">
      <CheckCircle2 className="h-3 w-3" /> systems normal
    </span>
  );
}
