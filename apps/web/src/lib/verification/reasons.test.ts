import { describe, expect, it } from "vitest";
import { REJECT_REASONS, REQUEST_REASONS, actorLabel, historyEntry, reasonLabel } from "./reasons";

describe("verification reason labels", () => {
  it("labels known codes and keeps unknown ones readable", () => {
    expect(reasonLabel("fake_order")).toBe("Fake / prank order");
    expect(reasonLabel("high_value")).toBe("High order value");
    expect(reasonLabel("confirmed_by_call")).toBe("Confirmed by call");
    expect(reasonLabel("some_new_code")).toBe("some new code");
    expect(reasonLabel(null)).toBeNull();
  });

  it("matches the API's reject / request code lists", () => {
    expect(REJECT_REASONS.map((r) => r.code)).toEqual([
      "fake_order",
      "customer_cancelled",
      "unreachable",
      "duplicate_order",
      "wrong_address",
      "blocklisted",
      "other",
    ]);
    expect(REQUEST_REASONS.map((r) => r.code)).toEqual(["high_value", "new_customer", "suspicious_details", "customer_request", "other"]);
  });
});

describe("verification history", () => {
  it("gives each event a label and tone", () => {
    expect(historyEntry("review.requested")).toEqual({ label: "Sent to verification", tone: "warning" });
    expect(historyEntry("review.verified")).toEqual({ label: "Verified", tone: "success" });
    expect(historyEntry("review.rejected")).toEqual({ label: "Rejected", tone: "danger" });
    expect(historyEntry("risk.recomputed").tone).toBe("neutral");
    expect(historyEntry("x.unknown_thing").label).toBe("x unknown thing");
  });

  it("names the actor without exposing internals", () => {
    expect(actorLabel("merchant")).toBe("You");
    expect(actorLabel("system")).toBe("ConfirmX");
    expect(actorLabel(undefined)).toBe("ConfirmX");
  });
});
