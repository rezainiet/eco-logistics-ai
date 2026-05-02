import { Bot, CheckCircle2, Clock, ShieldAlert, XCircle } from "lucide-react";

export type AutomationState =
  | "not_evaluated"
  | "auto_confirmed"
  | "pending_confirmation"
  | "confirmed"
  | "rejected"
  | "requires_review";

interface AutomationBadgeProps {
  state: AutomationState | null | undefined;
  bookedByAutomation?: boolean;
}

/**
 * Compact pill for the orders list. Hidden for orders that haven't been
 * evaluated by automation (i.e. merchants in manual mode see no badge,
 * preserving the existing UI).
 */
export function AutomationBadge({ state, bookedByAutomation }: AutomationBadgeProps) {
  if (!state || state === "not_evaluated") return null;

  const meta = META[state];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}
      title={meta.title}
    >
      <meta.icon className="h-3 w-3" aria-hidden />
      {meta.label}
      {bookedByAutomation && (state === "auto_confirmed" || state === "confirmed") ? " · auto" : ""}
    </span>
  );
}

const META: Record<AutomationState, { label: string; title: string; icon: typeof Clock; className: string }> = {
  not_evaluated: { label: "—", title: "Not evaluated", icon: Clock, className: "" },
  auto_confirmed: {
    label: "Auto-confirmed",
    title: "Confirmed by automation engine",
    icon: Bot,
    className: "bg-success-subtle text-success",
  },
  pending_confirmation: {
    label: "Pending",
    title: "Awaiting merchant confirmation",
    icon: Clock,
    className: "bg-warning-subtle text-warning",
  },
  confirmed: {
    label: "Confirmed",
    title: "Confirmed by merchant",
    icon: CheckCircle2,
    className: "bg-success-subtle text-success",
  },
  rejected: {
    label: "Rejected",
    title: "Rejected — order cancelled",
    icon: XCircle,
    className: "bg-danger-subtle text-danger",
  },
  requires_review: {
    label: "Review",
    title: "High risk — fraud-review required",
    icon: ShieldAlert,
    className: "bg-danger-subtle text-danger",
  },
};
