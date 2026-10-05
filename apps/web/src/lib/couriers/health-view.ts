/**
 * Wording for the courier connection & sync panel. Every number comes from
 * the API (`merchants.courierHealth`); these only phrase them.
 */

export type AttentionIssue = "sync_error" | "delivery_issue" | "no_update";

export const ISSUE_LABEL: Record<AttentionIssue, string> = {
  delivery_issue: "Delivery problem",
  sync_error: "Tracking sync failing",
  no_update: "No courier update for 5+ days",
};

export type HealthTone = "ok" | "warn" | "bad";

export interface CourierHealthLike {
  enabled: boolean;
  connection: { lastValidatedAt: string | Date | null; validationError: string | null };
  webhook: { secretConfigured: boolean; lastReceivedAt: string | Date | null; failedLast7d: number };
  shipments: { active: number; syncErrors: number; deliveryIssues: number; stale: number };
  bookings: { failedLast7d: number; orphaned: number };
}

/** One overall verdict for the courier badge: bad = act now, warn = look soon. */
export function healthTone(h: CourierHealthLike): HealthTone {
  if (h.connection.validationError || h.bookings.orphaned > 0) return "bad";
  if (
    h.shipments.syncErrors + h.shipments.deliveryIssues + h.shipments.stale > 0 ||
    h.bookings.failedLast7d > 0 ||
    h.webhook.failedLast7d > 0 ||
    !h.webhook.secretConfigured
  ) {
    return "warn";
  }
  return "ok";
}

/** "3 active · 2 need attention" */
export function shipmentsLine(s: CourierHealthLike["shipments"]): string {
  const attention = s.syncErrors + s.deliveryIssues + s.stale;
  const active = `${s.active} active shipment${s.active === 1 ? "" : "s"}`;
  return attention > 0 ? `${active} · ${attention} need${attention === 1 ? "s" : ""} attention` : active;
}

/** How tracking updates reach us, from what has actually been received. */
export function updatesLine(h: CourierHealthLike, relative: (d: string | Date) => string): string {
  if (!h.webhook.secretConfigured) return "Webhook secret not set — updates come from polling only";
  if (h.webhook.lastReceivedAt) return `Last courier update received ${relative(h.webhook.lastReceivedAt)}`;
  return "No webhook update received yet — tracking falls back to polling";
}
