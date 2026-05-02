/**
 * Customer-facing status presentation.
 *
 * Intentionally separate from the merchant dashboard's `status-badges.ts`
 * — this page renders to anonymous customers, so it uses neutral
 * Tailwind colors (no design-system CSS variables) and adds the
 * familiar status emoji that BD shoppers recognise from their messages.
 *
 * Pure functions only — same module is import-safe from server and client
 * components.
 */

export type CustomerStatus =
  | "pending"
  | "confirmed"
  | "packed"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "rto";

export interface StatusPresentation {
  label: string;
  emoji: string;
  /** Tailwind classes for the hero pill (text + background). */
  pillClass: string;
  /** Step rank — drives the progress bar (0..4). */
  step: number;
  /** Short human description shown under the hero. */
  hint: string;
  /** Tone: "info" | "progress" | "good" | "warn" — for icon coloring. */
  tone: "info" | "progress" | "good" | "warn";
}

const PRESENTATION: Record<CustomerStatus, StatusPresentation> = {
  pending: {
    label: "Processing",
    emoji: "🟡",
    pillClass: "bg-amber-100 text-amber-900",
    step: 0,
    hint: "Your order is being prepared.",
    tone: "info",
  },
  confirmed: {
    label: "Confirmed",
    emoji: "🟡",
    pillClass: "bg-amber-100 text-amber-900",
    step: 1,
    hint: "Your order is confirmed and packing has started.",
    tone: "info",
  },
  packed: {
    label: "Packed",
    emoji: "🟡",
    pillClass: "bg-amber-100 text-amber-900",
    step: 1,
    hint: "Packed and ready to be picked up by the courier.",
    tone: "info",
  },
  shipped: {
    label: "Shipped",
    emoji: "🔵",
    pillClass: "bg-blue-100 text-blue-900",
    step: 2,
    hint: "Picked up by the courier and on its way.",
    tone: "progress",
  },
  in_transit: {
    label: "In transit",
    emoji: "🔵",
    pillClass: "bg-blue-100 text-blue-900",
    step: 2,
    hint: "Your parcel is moving through the courier network.",
    tone: "progress",
  },
  out_for_delivery: {
    label: "Out for delivery",
    emoji: "🟠",
    pillClass: "bg-orange-100 text-orange-900",
    step: 3,
    hint: "The rider is heading to your address today.",
    tone: "progress",
  },
  delivered: {
    label: "Delivered",
    emoji: "🟢",
    pillClass: "bg-emerald-100 text-emerald-900",
    step: 4,
    hint: "Delivered. Thank you for shopping with us!",
    tone: "good",
  },
  cancelled: {
    label: "Cancelled",
    emoji: "⚪",
    pillClass: "bg-gray-100 text-gray-900",
    step: 0,
    hint: "This order has been cancelled.",
    tone: "warn",
  },
  rto: {
    label: "Returned",
    emoji: "🔴",
    pillClass: "bg-red-100 text-red-900",
    step: 0,
    hint: "The parcel was returned to the sender.",
    tone: "warn",
  },
};

const FALLBACK: StatusPresentation = {
  label: "Unknown",
  emoji: "⚪",
  pillClass: "bg-gray-100 text-gray-900",
  step: 0,
  hint: "We do not have an update yet.",
  tone: "info",
};

export function statusPresentation(status: string | undefined): StatusPresentation {
  if (!status) return FALLBACK;
  // Tracking event status strings vary by courier ("out-for-delivery", "Out for Delivery").
  // Normalize before looking up.
  const key = status.toLowerCase().replace(/[\s-]+/g, "_");
  const map: Record<string, CustomerStatus> = {
    out_for_delivery: "out_for_delivery",
    pending: "pending",
    confirmed: "confirmed",
    packed: "packed",
    shipped: "shipped",
    in_transit: "in_transit",
    delivered: "delivered",
    cancelled: "cancelled",
    canceled: "cancelled",
    rto: "rto",
    returned: "rto",
  };
  const matched = map[key];
  return matched ? PRESENTATION[matched] : FALLBACK;
}

const STEP_LABELS = ["Processing", "Packed", "Shipped", "Out for delivery", "Delivered"] as const;
export const TRACKING_STEPS: ReadonlyArray<string> = STEP_LABELS;

/**
 * Sanitize a hex color to `#rrggbb` lowercase. Returns null if the input
 * is not a 7-character hex — caller should fall back to its own default.
 */
export function safeHexColor(value: string | undefined | null): string | null {
  if (!value) return null;
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

export function safeHttpsUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  return /^https?:\/\/[^\s<>"]+$/i.test(value) ? value : null;
}

export function formatBdt(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-BD", {
    style: "currency",
    currency: "BDT",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
