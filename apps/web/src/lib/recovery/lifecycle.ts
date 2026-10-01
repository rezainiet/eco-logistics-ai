/**
 * One recovery row → the stage a merchant needs to see. The task status
 * (pending / contacted / recovered / dismissed / expired) is the source of
 * truth for the outcome; the automatic email adds where the outreach is.
 */

export type StageTone = "success" | "info" | "warning" | "destructive" | "secondary";

export interface RecoveryRowLike {
  status: string;
  lastChannel?: string | null;
  emailStatus?: string | null;
  emailCancelReason?: string | null;
  clickedAt?: string | Date | null;
}

const CANCEL_LABEL: Record<string, string> = {
  order_exists: "Ordered another way",
  merchant_action: "Handled manually",
  page_unavailable: "Page offline",
  cart_unavailable: "Items unavailable",
  not_recoverable: "Not emailed",
};

export function recoveryStage(row: RecoveryRowLike): { label: string; tone: StageTone } {
  if (row.status === "recovered") return { label: "Recovered", tone: "success" };
  if (row.status === "expired") return { label: "Expired", tone: "secondary" };
  if (row.status === "dismissed") return { label: "Dismissed", tone: "secondary" };
  if (row.clickedAt) return { label: "Link clicked", tone: "info" };
  switch (row.emailStatus) {
    case "sent":
      return { label: "Email sent", tone: "info" };
    case "queued":
    case "sending":
      return { label: "Email scheduled", tone: "warning" };
    case "failed":
      return { label: "Email failed", tone: "destructive" };
    case "suppressed":
      return { label: "Email blocked (bounced)", tone: "secondary" };
    case "cancelled":
      return { label: CANCEL_LABEL[row.emailCancelReason ?? ""] ?? "Not emailed", tone: "secondary" };
  }
  if (row.status === "contacted") {
    return { label: row.lastChannel ? `Contacted (${row.lastChannel})` : "Contacted", tone: "info" };
  }
  return { label: "Needs outreach", tone: "warning" };
}

/** Recovered ÷ carts in recovery, as a percentage string ("—" until there is a cart). */
export function formatRecoveryRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(rate >= 0.1 || rate === 0 ? 0 : 1)}%`;
}
