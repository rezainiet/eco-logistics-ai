/**
 * Order-verification reason codes and history labels — the wording a
 * merchant sees. Codes mirror apps/api/src/lib/verification.ts (the API
 * validates them per action; the web never invents its own).
 */

export const REJECT_REASONS = [
  { code: "fake_order", label: "Fake / prank order" },
  { code: "customer_cancelled", label: "Customer cancelled" },
  { code: "unreachable", label: "Customer unreachable" },
  { code: "duplicate_order", label: "Duplicate order" },
  { code: "wrong_address", label: "Wrong or incomplete address" },
  { code: "blocklisted", label: "Blocked customer" },
  { code: "other", label: "Other" },
] as const;

export const REQUEST_REASONS = [
  { code: "high_value", label: "High order value" },
  { code: "new_customer", label: "New customer" },
  { code: "suspicious_details", label: "Suspicious details" },
  { code: "customer_request", label: "Customer asked to confirm" },
  { code: "other", label: "Other" },
] as const;

export const VERIFY_REASONS = [
  { code: "confirmed_by_call", label: "Confirmed by call" },
  { code: "confirmed_by_sms", label: "Confirmed by SMS" },
  { code: "known_customer", label: "Known customer" },
  { code: "other", label: "Other" },
] as const;

export const NO_ANSWER_REASONS = [
  { code: "no_pickup", label: "Didn't pick up" },
  { code: "phone_off", label: "Phone switched off" },
  { code: "wrong_number", label: "Wrong number" },
  { code: "other", label: "Other" },
] as const;

const ALL_REASONS: Record<string, string> = Object.fromEntries(
  [...REJECT_REASONS, ...REQUEST_REASONS, ...VERIFY_REASONS, ...NO_ANSWER_REASONS].map((r) => [r.code, r.label]),
);

/** Label for a stored reason code ("Other" codes and unknown codes stay readable). */
export function reasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return ALL_REASONS[code] ?? code.replace(/_/g, " ");
}

const HISTORY_LABEL: Record<string, string> = {
  "risk.recomputed": "Risk re-scored",
  "review.requested": "Sent to verification",
  "review.verified": "Verified",
  "review.rejected": "Rejected",
  "review.no_answer": "Called — no answer",
  "review.reopened": "Back in verification",
  "automation.confirmed": "Order confirmed",
  "automation.rejected": "Order rejected",
  "automation.sms_confirm": "Customer confirmed by SMS",
  "automation.auto_expired": "Confirmation expired",
  "automation.escalated_no_reply": "No SMS reply — sent to call",
  "automation.auto_booked": "Courier booked automatically",
  "order.cancelled": "Order cancelled",
  "order.restored": "Order restored",
};

export type HistoryTone = "success" | "danger" | "warning" | "neutral";

export function historyEntry(action: string): { label: string; tone: HistoryTone } {
  const label = HISTORY_LABEL[action] ?? action.replace(/[._]/g, " ");
  const tone: HistoryTone =
    action === "review.verified" || action === "automation.confirmed" || action === "automation.sms_confirm" || action === "automation.auto_booked"
      ? "success"
      : action === "review.rejected" || action === "automation.rejected" || action === "order.cancelled" || action === "automation.auto_expired"
        ? "danger"
        : action === "review.requested" || action === "review.no_answer" || action === "automation.escalated_no_reply" || action === "review.reopened"
          ? "warning"
          : "neutral";
  return { label, tone };
}

const ACTOR_LABEL: Record<string, string> = {
  merchant: "You",
  agent: "Your team",
  admin: "Support",
  system: "ConfirmX",
};

export function actorLabel(actor: string | null | undefined): string {
  return ACTOR_LABEL[actor ?? "system"] ?? "ConfirmX";
}
