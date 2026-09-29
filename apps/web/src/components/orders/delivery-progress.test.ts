import { describe, expect, it } from "vitest";
import { deliveryProgress, type DeliveryProgress } from "./delivery-progress";

const keys = (p: DeliveryProgress) => p.steps.map((s) => s.key);
const states = (p: DeliveryProgress) => p.steps.map((s) => s.state);

describe("deliveryProgress — cancelled orders", () => {
  it("pending → cancelled: only Created, then Cancelled (regression: was '5 of 5 … FAILED')", () => {
    const p = deliveryProgress({ orderStatus: "cancelled", trackingNumber: null, eventStatuses: [] });
    expect(p.terminal).toBe("cancelled");
    expect(keys(p)).toEqual(["created", "terminal"]);
    expect(states(p)).toEqual(["completed", "failed"]);
    expect(p.steps.at(-1)!.label).toBe("Cancelled");
    expect(p.summary).toBe("Cancelled before shipping");
    expect(p.summary).not.toMatch(/of 5/);
    // No shipping stage may be shown as reached.
    for (const k of ["booked", "in_transit", "out_for_delivery", "delivered"] as const) {
      expect(keys(p)).not.toContain(k);
    }
  });

  it("confirmed/packed → cancelled without a booking looks the same (status history is not needed)", () => {
    const p = deliveryProgress({ orderStatus: "cancelled", normalizedStatus: undefined });
    expect(keys(p)).toEqual(["created", "terminal"]);
    expect(p.summary).toBe("Cancelled before shipping");
  });

  it("booked (tracking number issued) → cancelled shows Booked as reached", () => {
    const p = deliveryProgress({ orderStatus: "cancelled", trackingNumber: "TRK-1", eventStatuses: ["pending"] });
    expect(keys(p)).toEqual(["created", "booked", "terminal"]);
    expect(p.summary).toBe("Cancelled after booking");
  });
});

describe("deliveryProgress — returned / failed", () => {
  it("shipped → RTO with courier events shows the stages the parcel reached, then Returned", () => {
    const p = deliveryProgress({
      orderStatus: "rto",
      normalizedStatus: "rto",
      trackingNumber: "TRK-2",
      eventStatuses: ["picked_up", "in_transit", "rto"],
    });
    expect(p.terminal).toBe("returned");
    expect(keys(p)).toEqual(["created", "booked", "in_transit", "terminal"]);
    expect(p.steps.at(-1)!.label).toBe("Returned");
    expect(p.summary).toBe("Returned to sender");
  });

  it("manual shipped → RTO with no events still shows it was booked (a return implies a booking)", () => {
    const p = deliveryProgress({ orderStatus: "rto", trackingNumber: null, eventStatuses: [] });
    expect(keys(p)).toEqual(["created", "booked", "terminal"]);
  });

  it("RTO after an out-for-delivery attempt shows out for delivery as reached", () => {
    const p = deliveryProgress({
      orderStatus: "rto",
      trackingNumber: "TRK-3",
      eventStatuses: ["in_transit", "out_for_delivery", "rto"],
    });
    expect(keys(p)).toEqual(["created", "booked", "in_transit", "out_for_delivery", "terminal"]);
  });

  it("a delivered→RTO correction never shows Delivered next to Returned", () => {
    const p = deliveryProgress({ orderStatus: "rto", trackingNumber: "T", eventStatuses: ["delivered", "rto"] });
    expect(keys(p)).not.toContain("delivered");
    expect(p.steps.at(-1)!.label).toBe("Returned");
  });

  it("courier 'failed' delivery is terminal with the reached stages", () => {
    const p = deliveryProgress({
      orderStatus: "in_transit",
      normalizedStatus: "failed",
      trackingNumber: "T",
      eventStatuses: ["in_transit", "out_for_delivery", "failed"],
    });
    expect(p.terminal).toBe("failed");
    expect(keys(p)).toEqual(["created", "booked", "in_transit", "out_for_delivery", "terminal"]);
    expect(p.summary).toBe("Delivery failed");
  });
});

describe("deliveryProgress — live orders keep the original 5-stage semantics", () => {
  it.each([
    ["pending", undefined, "1 of 5", 0],
    ["confirmed", undefined, "1 of 5", 0],
    ["packed", undefined, "1 of 5", 0],
    ["shipped", undefined, "2 of 5", 1],
    ["shipped", "picked_up", "3 of 5", 2],
    ["in_transit", "in_transit", "3 of 5", 2],
    ["in_transit", "out_for_delivery", "4 of 5", 3],
  ] as const)("%s / %s → %s", (orderStatus, normalizedStatus, summary, activeIndex) => {
    const p = deliveryProgress({ orderStatus, normalizedStatus });
    expect(p.terminal).toBeNull();
    expect(p.summary).toBe(summary);
    expect(p.steps).toHaveLength(5);
    expect(states(p).indexOf("active")).toBe(activeIndex);
    expect(states(p).slice(0, activeIndex).every((s) => s === "completed")).toBe(true);
    expect(states(p).slice(activeIndex + 1).every((s) => s === "upcoming")).toBe(true);
  });

  it("delivered → 5 of 5 with Delivered active", () => {
    const p = deliveryProgress({ orderStatus: "delivered", normalizedStatus: null });
    expect(p.summary).toBe("5 of 5");
    expect(p.steps.at(-1)).toEqual({ key: "delivered", label: "Delivered", state: "active" });
    expect(p.terminal).toBeNull();
  });
});
