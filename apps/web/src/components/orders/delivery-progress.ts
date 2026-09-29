/**
 * Delivery-progress model for the order detail drawer. Pure — no React —
 * so the presentation rules are unit-testable.
 *
 * Normal orders walk the five shipping stages. A terminal failure
 * (cancelled / returned / failed delivery) must only show the stages the
 * order actually reached, followed by the terminal step: an order cancelled
 * while still pending never reached "Booked", so it must not render as
 * "5 of 5" with every shipping stage ticked.
 *
 * What "reached" means comes only from evidence already on the order: its
 * persisted status, whether a tracking number was issued (booked), and the
 * courier's normalized tracking events. Nothing here changes order state.
 */

export type ProgressStepKey =
  | "created"
  | "booked"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "terminal";

export type ProgressStepState = "completed" | "active" | "upcoming" | "failed";

export interface ProgressStep {
  key: ProgressStepKey;
  label: string;
  state: ProgressStepState;
}

export type ProgressTerminal = "cancelled" | "returned" | "failed";

export interface DeliveryProgress {
  steps: ProgressStep[];
  terminal: ProgressTerminal | null;
  /** Short header text: "3 of 5" for live orders, the outcome for terminal ones. */
  summary: string;
}

export interface DeliveryProgressInput {
  orderStatus: string;
  /** Latest courier normalized status, if any. */
  normalizedStatus?: string | null;
  trackingNumber?: string | null;
  /** Normalized statuses of every tracking event on the order. */
  eventStatuses?: ReadonlyArray<string | null | undefined>;
}

const STAGES: ReadonlyArray<{ key: Exclude<ProgressStepKey, "terminal">; label: string }> = [
  { key: "created", label: "Created" },
  { key: "booked", label: "Booked" },
  { key: "in_transit", label: "In transit" },
  { key: "out_for_delivery", label: "Out for delivery" },
  { key: "delivered", label: "Delivered" },
];

const LAST = STAGES.length - 1;

/**
 * Stage index for a live (non-terminal) order. Unchanged from the original
 * drawer: persisted status for the early stages, the courier's latest
 * normalized status for the later ones.
 */
function liveStageIndex(orderStatus: string, normalizedStatus: string | null | undefined): number {
  if (normalizedStatus === "delivered" || orderStatus === "delivered") return 4;
  if (normalizedStatus === "out_for_delivery") return 3;
  if (normalizedStatus === "in_transit" || normalizedStatus === "picked_up" || orderStatus === "in_transit") {
    return 2;
  }
  if (orderStatus === "shipped") return 1;
  return 0;
}

/** Furthest stage there is evidence of, from tracking number and the whole event history. */
function evidencedStageIndex(input: DeliveryProgressInput): number {
  const seen = new Set<string>(
    [input.normalizedStatus, ...(input.eventStatuses ?? [])].filter((s): s is string => !!s),
  );
  if (seen.has("delivered")) return 4;
  if (seen.has("out_for_delivery")) return 3;
  if (seen.has("in_transit") || seen.has("picked_up")) return 2;
  if (input.trackingNumber) return 1;
  return 0;
}

function terminalOf(input: DeliveryProgressInput): ProgressTerminal | null {
  if (input.orderStatus === "rto" || input.normalizedStatus === "rto") return "returned";
  if (input.orderStatus === "cancelled") return "cancelled";
  if (input.normalizedStatus === "failed") return "failed";
  return null;
}

const TERMINAL_LABEL: Record<ProgressTerminal, string> = {
  cancelled: "Cancelled",
  returned: "Returned",
  failed: "Failed",
};

/** Header text for a cancellation, by the furthest stage reached. */
const CANCELLED_SUMMARY: Record<number, string> = {
  0: "Cancelled before shipping",
  1: "Cancelled after booking",
  2: "Cancelled in transit",
  3: "Cancelled out for delivery",
};

export function deliveryProgress(input: DeliveryProgressInput): DeliveryProgress {
  const terminal = terminalOf(input);

  if (!terminal) {
    const reached = liveStageIndex(input.orderStatus, input.normalizedStatus);
    return {
      terminal: null,
      summary: `${reached + 1} of ${STAGES.length}`,
      steps: STAGES.map((s, i) => ({
        key: s.key,
        label: s.label,
        state: i < reached ? "completed" : i === reached ? "active" : "upcoming",
      })),
    };
  }

  // A return or failed delivery means the parcel was at least booked with a
  // courier; a cancellation carries no such floor. The terminal step always
  // replaces "Delivered", so at most "Out for delivery" is shown as reached.
  const floor = terminal === "cancelled" ? 0 : 1;
  const reached = Math.min(LAST - 1, Math.max(floor, evidencedStageIndex(input)));
  const steps: ProgressStep[] = STAGES.slice(0, reached + 1).map((s) => ({
    key: s.key,
    label: s.label,
    state: "completed",
  }));
  steps.push({ key: "terminal", label: TERMINAL_LABEL[terminal], state: "failed" });

  let summary: string;
  if (terminal === "cancelled") {
    summary = CANCELLED_SUMMARY[reached] ?? "Cancelled";
  } else if (terminal === "returned") {
    summary = "Returned to sender";
  } else {
    summary = "Delivery failed";
  }
  return { steps, terminal, summary };
}
