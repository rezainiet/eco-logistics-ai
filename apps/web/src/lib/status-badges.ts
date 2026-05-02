import {
  AlertCircle,
  CheckCircle2,
  Clock,
  PackageCheck,
  ShieldAlert,
  ShieldCheck,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "packed",
  "shipped",
  "in_transit",
  "delivered",
  "cancelled",
  "rto",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orderStatusClass: Record<OrderStatus, string> = {
  pending: "bg-surface-raised text-fg-muted",
  confirmed: "bg-info-subtle text-info",
  packed: "bg-info-subtle text-info",
  shipped: "bg-info-subtle text-info",
  in_transit: "bg-warning-subtle text-warning",
  delivered: "bg-success-subtle text-success",
  cancelled: "bg-surface-raised text-fg-subtle",
  rto: "bg-danger-subtle text-danger",
};

export function riskBadgeClass(score: number): string {
  if (score >= 70) return "bg-danger-subtle text-danger";
  if (score >= 40) return "bg-warning-subtle text-warning";
  return "bg-surface-raised text-fg-muted";
}

export type TrackingBadge = { label: string; className: string; icon: LucideIcon };

const FALLBACK: TrackingBadge = {
  label: "Unknown",
  className: "bg-surface-raised text-fg-muted",
  icon: Clock,
};

export const trackingBadge: Record<string, TrackingBadge> = {
  pending: { label: "Pending", className: "bg-surface-raised text-fg-muted", icon: Clock },
  picked_up: { label: "Picked up", className: "bg-info-subtle text-info", icon: PackageCheck },
  in_transit: { label: "In transit", className: "bg-warning-subtle text-warning", icon: Truck },
  out_for_delivery: {
    label: "Out for delivery",
    className: "bg-[hsl(262_83%_62%/0.14)] text-[hsl(262_83%_74%)]",
    icon: Truck,
  },
  delivered: { label: "Delivered", className: "bg-success-subtle text-success", icon: CheckCircle2 },
  failed: { label: "Failed", className: "bg-danger-subtle text-danger", icon: AlertCircle },
  rto: { label: "RTO", className: "bg-danger-subtle text-danger", icon: Undo2 },
  unknown: FALLBACK,
};

export function resolveTrackingBadge(normalizedStatus?: string | null): TrackingBadge {
  if (!normalizedStatus) return trackingBadge.pending ?? FALLBACK;
  return trackingBadge[normalizedStatus] ?? FALLBACK;
}

export type ReviewStatus =
  | "not_required"
  | "optional_review"
  | "pending_call"
  | "verified"
  | "rejected"
  | "no_answer";

export const REVIEW_BADGE: Record<
  Exclude<ReviewStatus, "not_required">,
  { label: string; className: string; Icon: LucideIcon }
> = {
  optional_review: {
    label: "Watch",
    className: "bg-warning-subtle text-warning",
    Icon: ShieldAlert,
  },
  pending_call: {
    label: "Pending call",
    className: "bg-warning-subtle text-warning",
    Icon: ShieldAlert,
  },
  no_answer: {
    label: "No answer",
    className: "bg-danger-subtle text-danger",
    Icon: ShieldAlert,
  },
  verified: {
    label: "Verified",
    className: "bg-success-subtle text-success",
    Icon: ShieldCheck,
  },
  rejected: {
    label: "Rejected",
    className: "bg-danger-subtle text-danger",
    Icon: ShieldAlert,
  },
};
