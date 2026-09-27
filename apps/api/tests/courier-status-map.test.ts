import { describe, expect, it } from "vitest";
import { knownStatusKeys, normalizeCourierStatus, statusKey } from "../src/lib/couriers/status-map.js";

/**
 * Exact provider-status tables. Each row is a status string the courier
 * sends (webhook `order_status` / `status` / `delivery_status`, or the
 * polling equivalent) and the normalized status it must produce.
 */
const PATHAO: Array<[string, string]> = [
  ["Order Placed", "pending"],
  ["Pickup_Requested", "pending"],
  ["Pickup Requested", "pending"],
  ["Assigned_for_Pickup", "pending"],
  ["Pickup_Failed", "pending"], // was "picked_up" via includes("pickup")
  ["Pickup_Cancelled", "pending"], // was "picked_up"
  ["Picked", "picked_up"],
  ["At_the_Sorting_HUB", "in_transit"],
  ["In_Transit", "in_transit"],
  ["in_transit", "in_transit"],
  ["Received_at_Last_Mile_HUB", "in_transit"],
  ["On_Hold", "in_transit"],
  ["Assigned_for_Delivery", "out_for_delivery"], // was "unknown"
  ["Delivered", "delivered"],
  ["Delivery_Failed", "failed"], // was "failed" → order rto → stock released
  ["Return", "rto"],
  ["Returned to merchant", "rto"],
  ["Paid_Return", "rto"],
  ["Partial_Delivery", "unknown"],
  ["Payment_Invoice", "unknown"],
  ["Exchange", "unknown"],
];

const REDX: Array<[string, string]> = [
  ["pickup-pending", "pending"],
  ["pickup-success", "picked_up"],
  ["picked-up", "picked_up"],
  ["in-hub", "in_transit"],
  ["ready-for-delivery", "in_transit"],
  ["agent-hold", "in_transit"],
  ["out-for-delivery", "out_for_delivery"],
  ["delivery-in-progress", "out_for_delivery"],
  ["delivered", "delivered"],
  ["agent-returning", "failed"], // on its way back — was "rto" via includes("return")
  ["returned", "rto"],
  ["cancelled", "unknown"], // was "failed" → rto
  ["partial_delivered", "unknown"],
];

const STEADFAST: Array<[string, string]> = [
  ["pending", "pending"],
  ["in_review", "pending"],
  ["hold", "in_transit"],
  ["delivered_approval_pending", "out_for_delivery"], // not final until Steadfast approves
  ["partial_delivered_approval_pending", "out_for_delivery"],
  ["delivered", "delivered"],
  ["partial_delivered", "delivered"],
  ["cancelled_approval_pending", "failed"], // not final — stock stays reserved
  ["cancelled", "rto"], // Steadfast's final state; parcel goes back to the merchant
  ["Returned", "rto"],
  ["unknown", "unknown"],
  ["unknown_approval_pending", "unknown"],
];

describe("exact courier status tables", () => {
  it.each(PATHAO)("pathao %s → %s", (raw, want) => expect(normalizeCourierStatus("pathao", raw)).toBe(want));
  it.each(REDX)("redx %s → %s", (raw, want) => expect(normalizeCourierStatus("redx", raw)).toBe(want));
  it.each(STEADFAST)("steadfast %s → %s", (raw, want) => expect(normalizeCourierStatus("steadfast", raw)).toBe(want));
});

describe("no accidental matches", () => {
  const traps = [
    "Undelivered", "not delivered", "delivery attempt failed and pickup", "picked_up_failed",
    "returned-to-hub?", "pickup", "xyz", "", "   ",
  ];
  for (const provider of ["pathao", "redx", "steadfast"] as const) {
    it(`${provider}: unlisted statuses are "unknown", never delivered / picked_up / rto`, () => {
      for (const raw of traps) {
        const known = knownStatusKeys(provider).includes(statusKey(raw));
        if (!known) expect(normalizeCourierStatus(provider, raw)).toBe("unknown");
      }
      expect(normalizeCourierStatus(provider, null)).toBe("unknown");
      expect(normalizeCourierStatus(provider, undefined)).toBe("unknown");
    });
  }

  it("canonicalises case and separators only", () => {
    expect(statusKey("  Pickup-Failed ")).toBe("pickup_failed");
    expect(statusKey("At the  Sorting_HUB")).toBe("at_the_sorting_hub");
    expect(normalizeCourierStatus("pathao", "DELIVERED")).toBe("delivered");
    expect(normalizeCourierStatus("pathao", "Undelivered")).toBe("unknown");
  });
});
