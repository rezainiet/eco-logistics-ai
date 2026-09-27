import type { NormalizedTrackingStatus } from "./types.js";

/**
 * Exact provider-status → normalized-status tables.
 *
 * Replaces the substring heuristics the adapters used to share
 * (`s.includes("pickup")`, `s.includes("fail")`, …), which misread statuses
 * such as Pathao "Pickup_Failed" (contains "pickup" → picked_up) and turned
 * every failed delivery attempt into a return. Lookups are exact on a
 * canonical key — lower-case, with runs of spaces / "_" / "-" collapsed to
 * "_" — so "Pickup Failed", "pickup_failed" and "pickup-failed" are the same
 * key, but nothing matches by accident. Anything not listed is "unknown",
 * which never changes the order (see tracking.ts `courierOrderTransition`).
 *
 * Normalized meanings:
 *   pending           accepted by the courier, not picked up yet (includes a
 *                     failed or cancelled pickup — the parcel never left)
 *   picked_up         collected from the merchant
 *   in_transit        moving between / held at courier hubs
 *   out_for_delivery  with the rider, or delivery awaiting courier approval
 *   delivered         final delivery (full or partial, as the courier states)
 *   failed            delivery attempt failed / return in progress — the
 *                     parcel is STILL WITH THE COURIER, stock stays reserved
 *   rto               parcel returned to the merchant (final)
 *   unknown           anything else — recorded on the timeline only
 */
export type CourierStatusProvider = "pathao" | "redx" | "steadfast";

type Table = Readonly<Record<string, NormalizedTrackingStatus>>;

function table(groups: Partial<Record<NormalizedTrackingStatus, string[]>>): Table {
  const out: Record<string, NormalizedTrackingStatus> = {};
  for (const [status, keys] of Object.entries(groups) as Array<[NormalizedTrackingStatus, string[]]>) {
    for (const k of keys) out[statusKey(k)] = status;
  }
  return Object.freeze(out);
}

/** Canonical lookup key: "Pickup Failed" / "pickup-failed" → "pickup_failed". */
export function statusKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, "_");
}

const PATHAO = table({
  pending: [
    "order_placed", "pending", "pickup_requested", "pickup_request",
    "assigned_for_pickup", "pickup_failed", "pickup_cancelled",
  ],
  picked_up: ["picked", "picked_up", "pickup_success"],
  in_transit: [
    "in_transit", "at_the_sorting_hub", "at_sorting_hub", "in_hub",
    "received_at_last_mile_hub", "on_hold", "hold", "shipped",
  ],
  out_for_delivery: ["assigned_for_delivery", "out_for_delivery"],
  delivered: ["delivered"],
  failed: ["delivery_failed", "failed"],
  rto: ["return", "returned", "returned_to_merchant", "paid_return", "rto"],
  // Deliberately "unknown": needs a merchant decision, never automatic.
  unknown: ["partial_delivery", "partial_delivered", "payment_invoice", "exchange"],
});

const REDX = table({
  pending: ["pickup_pending", "pending", "created", "ready_for_pickup"],
  picked_up: ["picked_up", "pickup_success", "pickup_completed"],
  in_transit: [
    "in_hub", "in_transit", "received", "received_at_hub", "ready_for_delivery",
    "agent_hold", "hold", "agent_area_change", "shipped",
  ],
  out_for_delivery: ["out_for_delivery", "delivery_in_progress"],
  delivered: ["delivered"],
  // agent-returning: on its way back, not back yet — stock stays reserved.
  failed: ["failed", "delivery_failed", "agent_returning"],
  rto: ["returned", "returned_to_merchant", "return", "rto"],
  unknown: ["cancelled", "partial_delivered", "partially_delivered"],
});

const STEADFAST = table({
  pending: ["pending", "in_review"],
  picked_up: ["picked_up", "pickup_success"],
  in_transit: ["hold", "in_transit", "in_hub", "shipped"],
  // The rider marked it delivered but Steadfast has not approved it yet.
  out_for_delivery: [
    "out_for_delivery", "delivered_approval_pending", "partial_delivered_approval_pending",
  ],
  // partial_delivered → delivered is the adapter's established behaviour.
  delivered: ["delivered", "partial_delivered"],
  failed: ["cancelled_approval_pending"],
  // Steadfast's API has no separate "returned" status: an approved
  // "cancelled" consignment is the final state and goes back to the merchant.
  rto: ["cancelled", "returned", "returned_to_merchant", "return", "rto"],
  unknown: ["unknown", "unknown_approval_pending"],
});

const TABLES: Record<CourierStatusProvider, Table> = {
  pathao: PATHAO,
  redx: REDX,
  steadfast: STEADFAST,
};

export function normalizeCourierStatus(
  provider: CourierStatusProvider,
  raw: string | null | undefined,
): NormalizedTrackingStatus {
  if (!raw) return "unknown";
  return TABLES[provider][statusKey(raw)] ?? "unknown";
}

/** Test/doc helper: the raw keys each provider maps explicitly. */
export function knownStatusKeys(provider: CourierStatusProvider): string[] {
  return Object.keys(TABLES[provider]);
}
