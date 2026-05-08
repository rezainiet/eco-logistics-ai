/**
 * operational-hints — pure-function classifier that turns an order's
 * existing state (status, tracking events, address quality, automation
 * confirmation flow) into a merchant-readable operational hint.
 *
 * **Visibility only.** This module:
 *   - never writes to the database
 *   - never enqueues a job
 *   - never modifies fraud / risk / automation state
 *   - never feeds `computeRisk`
 *
 * The hint is a label the merchant sees on the order detail drawer — it
 * tells them "this order needs your attention because X" without the
 * platform taking any unilateral action. NDR engagement automation is
 * out of scope for this milestone (per the polish-phase brief).
 *
 * Every hint carries a `severity` (`info` / `warning` / `critical`) so
 * the UI can colour-code consistently with the rest of the dashboard,
 * and a `suggestedAction` string the operator can read.
 *
 * Rules are intentionally conservative — when nothing matches, the
 * function returns `null`. The order detail UI hides the panel when no
 * hint fires, so a healthy order shows nothing extra.
 */

/** Stable hint codes — UI maps these to localized copy / styling. */
export const OPERATIONAL_HINT_CODES = [
  "address_clarification_needed",
  "customer_unreachable_pending_call",
  "delivery_failed_attempt",
  "delivery_attempt_in_progress",
  "stuck_in_transit",
  "stuck_pending_pickup",
  "awaiting_customer_confirmation",
  "confirmation_sms_undelivered",
] as const;
export type OperationalHintCode = (typeof OPERATIONAL_HINT_CODES)[number];

export type OperationalHintSeverity = "info" | "warning" | "critical";

export interface OperationalHint {
  code: OperationalHintCode;
  severity: OperationalHintSeverity;
  /** Operator-readable headline — surfaced verbatim. */
  label: string;
  /** Short next-step copy. Always actionable, never generic. */
  suggestedAction: string;
  /** When did the underlying signal become true? Used for UI age display. */
  observedAt?: Date | null;
}

/* -------------------------------------------------------------------------- */
/* Input shape — structural so the function stays test-friendly without       */
/* importing the Mongoose model.                                              */
/* -------------------------------------------------------------------------- */

export interface OrderHintInput {
  /** From `Order.order.status`. */
  status?: string;
  /** From `Order.address.quality.completeness`. */
  addressCompleteness?: "complete" | "partial" | "incomplete";
  /** From `Order.fraud.reviewStatus`. */
  fraudReviewStatus?: string;
  /** From `Order.automation.state`. */
  automationState?: string;
  /** From `Order.automation.confirmationDeliveryStatus`. */
  confirmationDeliveryStatus?:
    | "pending"
    | "delivered"
    | "failed"
    | "unknown"
    | null;
  /** From `Order.automation.confirmationSentAt`. */
  confirmationSentAt?: Date | null;
  /** From `Order.logistics.shippedAt`. */
  shippedAt?: Date | null;
  /** From `Order.logistics.lastWebhookAt` ?? `lastPolledAt`. */
  lastTrackingActivityAt?: Date | null;
  /** From `Order.logistics.trackingEvents[]`, oldest first. */
  trackingEvents?: ReadonlyArray<{
    at: Date;
    normalizedStatus?: string;
    description?: string | null;
  }>;
  /** Reference time — defaults to `new Date()`; injectable for tests. */
  now?: Date;
}

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                 */
/* -------------------------------------------------------------------------- */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "Stuck pending pickup" fires when status=confirmed/packed older than this. */
const STUCK_PENDING_PICKUP_MS = 36 * HOUR_MS;

/** "Stuck in transit" fires when last tracking activity older than this. */
const STUCK_IN_TRANSIT_MS = 4 * DAY_MS;

/** "Out for delivery without resolution" — courier marked OFD but no
 *  delivered/failed event since. */
const STALE_OUT_FOR_DELIVERY_MS = 24 * HOUR_MS;

/** Confirmation SMS DLR-failed but order still in pending_confirmation. */
const CONFIRMATION_SMS_FAILED_GRACE_MS = 30 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Classifier                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Classify an order's current operational state into a single hint, or
 * return `null` when the order looks healthy.
 *
 * Rules are evaluated in priority order — the first one that matches
 * wins. Priority is roughly: address > confirmation > delivery-failure >
 * staleness. Deliberately conservative; adding new rules requires a new
 * stable code and a corresponding UI translation.
 */
export function classifyOperationalHint(
  o: OrderHintInput,
): OperationalHint | null {
  const now = o.now ?? new Date();
  const events = o.trackingEvents ?? [];
  const latestEvent = events.length > 0 ? events[events.length - 1]! : null;

  /* ---- 1. Address clarification ---- */
  // Pre-dispatch only — once shipped, address can't be fixed by the
  // merchant cheaply and we'd just be noise.
  if (
    o.addressCompleteness === "incomplete" &&
    isPreDispatch(o.status)
  ) {
    return {
      code: "address_clarification_needed",
      severity: "warning",
      label: "Address looks incomplete",
      suggestedAction:
        "Reach out to the buyer for a landmark or road number before shipping.",
      observedAt: null,
    };
  }

  /* ---- 2. Confirmation SMS undelivered (still in pending_confirmation) ---- */
  if (
    o.automationState === "pending_confirmation" &&
    o.confirmationDeliveryStatus === "failed" &&
    o.confirmationSentAt &&
    now.getTime() - o.confirmationSentAt.getTime() > CONFIRMATION_SMS_FAILED_GRACE_MS
  ) {
    return {
      code: "confirmation_sms_undelivered",
      severity: "warning",
      label: "Confirmation SMS didn't reach the buyer",
      suggestedAction:
        "Try a manual call or WhatsApp follow-up to confirm the order.",
      observedAt: o.confirmationSentAt ?? null,
    };
  }

  /* ---- 3. Customer unreachable / awaiting confirmation ---- */
  if (o.fraudReviewStatus === "no_answer") {
    return {
      code: "customer_unreachable_pending_call",
      severity: "warning",
      label: "Customer didn't answer call attempts",
      suggestedAction:
        "Try a different time of day, or send a follow-up via SMS / WhatsApp.",
      observedAt: null,
    };
  }
  if (o.automationState === "pending_confirmation") {
    return {
      code: "awaiting_customer_confirmation",
      severity: "info",
      label: "Awaiting customer confirmation",
      suggestedAction:
        "The buyer was sent an SMS prompt. They'll either reply or auto-expire on the merchant cadence.",
      observedAt: o.confirmationSentAt ?? null,
    };
  }

  /* ---- 4. Delivery failed on most recent attempt (recoverable) ---- */
  // A `failed` event has landed AND it's the latest event. If there's a
  // later `delivered` we wouldn't be here. This is the NDR-detection
  // shape — surfaced as a label only; engagement is a separate milestone.
  if (latestEvent?.normalizedStatus === "failed" && o.status !== "delivered") {
    return {
      code: "delivery_failed_attempt",
      severity: "critical",
      label: "Delivery failed on most recent attempt",
      suggestedAction:
        "Contact the buyer to reschedule, or check with the courier on next-attempt timing.",
      observedAt: latestEvent.at,
    };
  }

  /* ---- 5. Out-for-delivery in progress vs stale ---- */
  if (latestEvent?.normalizedStatus === "out_for_delivery") {
    const ageMs = now.getTime() - new Date(latestEvent.at).getTime();
    if (ageMs <= STALE_OUT_FOR_DELIVERY_MS) {
      return {
        code: "delivery_attempt_in_progress",
        severity: "info",
        label: "Out for delivery — attempt in progress",
        suggestedAction:
          "The courier is on the route. No action needed unless the buyer reports an issue.",
        observedAt: latestEvent.at,
      };
    }
    // OFD that didn't transition within 24h → stuck.
    return {
      code: "stuck_in_transit",
      severity: "warning",
      label: "Marked out-for-delivery but no update for 24h+",
      suggestedAction:
        "Ping the courier. The driver may not have rescanned the parcel.",
      observedAt: latestEvent.at,
    };
  }

  /* ---- 6. Stuck-in-transit ---- */
  // Order is in_transit / shipped but tracking hasn't moved in
  // STUCK_IN_TRANSIT_MS. Uses lastTrackingActivityAt (webhook OR poll
  // timestamp) for the cutoff.
  if (
    (o.status === "in_transit" || o.status === "shipped") &&
    o.lastTrackingActivityAt &&
    now.getTime() - o.lastTrackingActivityAt.getTime() > STUCK_IN_TRANSIT_MS
  ) {
    return {
      code: "stuck_in_transit",
      severity: "warning",
      label: "No tracking updates for 4 days",
      suggestedAction:
        "The courier may have lost scan visibility on this parcel. Open a courier support ticket.",
      observedAt: o.lastTrackingActivityAt,
    };
  }

  /* ---- 7. Stuck-pending-pickup ---- */
  // Confirmed/packed, shipped flag never set, age > 36h. Either
  // automation didn't fire OR the courier hasn't collected.
  if (
    (o.status === "confirmed" || o.status === "packed") &&
    !o.shippedAt &&
    o.confirmationSentAt &&
    now.getTime() - o.confirmationSentAt.getTime() > STUCK_PENDING_PICKUP_MS
  ) {
    return {
      code: "stuck_pending_pickup",
      severity: "warning",
      label: "Confirmed but not shipped after 36h",
      suggestedAction:
        "Either the courier hasn't picked up, or auto-booking is blocked. Check the integration health card.",
      observedAt: o.confirmationSentAt,
    };
  }

  return null;
}

function isPreDispatch(status?: string): boolean {
  return (
    status === "pending" ||
    status === "confirmed" ||
    status === "packed"
  );
}

/* -------------------------------------------------------------------------- */
/* Test surface — exposes the threshold constants so test files can           */
/* exercise edge boundaries without re-deriving them.                         */
/* -------------------------------------------------------------------------- */
export const __TEST = {
  STUCK_PENDING_PICKUP_MS,
  STUCK_IN_TRANSIT_MS,
  STALE_OUT_FOR_DELIVERY_MS,
  CONFIRMATION_SMS_FAILED_GRACE_MS,
};
