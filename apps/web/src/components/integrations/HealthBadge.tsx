"use client";

import { CheckCircle2, AlertTriangle, AlertOctagon, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Three-state health pill that captures the integration's "is sync working
 * right now" answer in one glance:
 *
 *   ok     — last sync succeeded, no error count, recent activity
 *   error  — last sync failed (auth/transient/schema_drift) — action required
 *   idle   — never synced or no data points yet (freshly connected)
 *
 * Kept separate from `ActionButtons` so the same pill can be reused on
 * the integrations list page, the connections panel, and any future
 * compact rendering (header dropdown, command palette, etc.).
 */
export type HealthStatus = "ok" | "error" | "idle";

export function HealthBadge({
  status,
  className,
}: {
  status: HealthStatus;
  className?: string;
}) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.idle;
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        config.tone,
        className,
      )}
      aria-label={`Health: ${config.label}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {config.label}
    </span>
  );
}

const STATUS_CONFIG: Record<
  HealthStatus,
  {
    label: string;
    icon: typeof CheckCircle2;
    /** Tailwind classes — pulled from the existing palette tokens. */
    tone: string;
  }
> = {
  ok: {
    label: "Healthy",
    icon: CheckCircle2,
    tone: "bg-success-subtle text-success border border-success/20",
  },
  error: {
    label: "Sync issue",
    icon: AlertOctagon,
    tone: "bg-danger-subtle text-danger border border-danger/20",
  },
  idle: {
    label: "Idle",
    icon: CircleDashed,
    tone: "bg-surface-raised text-fg-subtle border border-stroke/12",
  },
};

// Re-export the warning icon so consumers that want to render a warning
// flag (e.g. "needs_attention" rows) can lean on the same icon library
// without adding their own import.
export const HealthWarningIcon = AlertTriangle;
