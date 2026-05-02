import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatRelative } from "@/lib/formatters";

/**
 * Tracker installation status badge. Three plain-language states:
 * "Tracking is working" (healthy), "Check installation" (stale),
 * "No activity yet" (not_installed). Lives on the integrations page.
 *
 * Extracted from integrations/page.tsx so the parent stays under a
 * maintainable line count and so this status renderer can be reused
 * anywhere we want to surface tracker health.
 */
export function TrackerInstallBadge({
  install,
}: {
  install: {
    status: "not_installed" | "stale" | "healthy";
    lastSeenAt: Date | string | null;
    sessionCount: number;
    latestEventType: string | null;
  };
}) {
  if (install.status === "healthy") {
    return (
      <div
        data-testid="tracker-install-badge"
        data-status="healthy"
        className="flex items-start gap-2 rounded-md border border-success-border bg-success-subtle px-3 py-2 text-xs text-success"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="font-semibold">Tracking is working</span> — last event received{" "}
          {install.lastSeenAt ? formatRelative(install.lastSeenAt) : "just now"} ·{" "}
          {install.sessionCount.toLocaleString()} visits captured.
        </span>
      </div>
    );
  }
  if (install.status === "stale") {
    return (
      <div
        data-testid="tracker-install-badge"
        data-status="stale"
        className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="font-semibold">Check installation</span> — no events received in
          over 7 days. The snippet may have been removed from your storefront. Last event
          received {install.lastSeenAt ? formatRelative(install.lastSeenAt) : "—"}.
        </span>
      </div>
    );
  }
  return (
    <div
      data-testid="tracker-install-badge"
      data-status="not_installed"
      className="flex items-start gap-2 rounded-md border border-info-border bg-info-subtle px-3 py-2 text-xs text-info"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <span className="font-semibold">No activity yet</span> — paste the snippet on every
        page of your storefront, then open a product page once. The first event usually shows
        up within a few seconds.
      </span>
    </div>
  );
}
