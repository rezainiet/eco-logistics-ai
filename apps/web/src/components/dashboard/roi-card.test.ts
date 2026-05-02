import { describe, expect, it } from "vitest";
import { buildRoiSnapshot } from "./roi-card";

describe("buildRoiSnapshot", () => {
  it("multiplies prevented RTOs by default ৳200/order", () => {
    const r = buildRoiSnapshot({
      ordersAutomated: 50,
      rtoLikelyPrevented: 7,
      smsConfirmationsSent: 30,
      periodLabel: "this week",
    });
    expect(r.estimatedSavedBdt).toBe(1400);
    expect(r.periodLabel).toBe("this week");
  });

  it("clamps negative inputs to zero", () => {
    const r = buildRoiSnapshot({
      ordersAutomated: -5,
      rtoLikelyPrevented: -3,
      smsConfirmationsSent: -1,
      periodLabel: "today",
    });
    expect(r.ordersAutomated).toBe(0);
    expect(r.rtoLikelyPrevented).toBe(0);
    expect(r.estimatedSavedBdt).toBe(0);
  });

  it("respects the costPerRtoBdt override", () => {
    const r = buildRoiSnapshot({
      ordersAutomated: 0, rtoLikelyPrevented: 10, smsConfirmationsSent: 0, periodLabel: "test",
      costPerRtoBdt: 350,
    });
    expect(r.estimatedSavedBdt).toBe(3500);
  });
});
