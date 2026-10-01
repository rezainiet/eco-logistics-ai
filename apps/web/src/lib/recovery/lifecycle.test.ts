import { describe, expect, it } from "vitest";
import { formatRecoveryRate, recoveryStage } from "./lifecycle";

describe("recovery stage", () => {
  it("the task outcome wins over the email state", () => {
    expect(recoveryStage({ status: "recovered", emailStatus: "sent", clickedAt: new Date() })).toEqual({ label: "Recovered", tone: "success" });
    expect(recoveryStage({ status: "expired", emailStatus: "queued" }).label).toBe("Expired");
    expect(recoveryStage({ status: "dismissed", emailStatus: "cancelled" }).label).toBe("Dismissed");
  });

  it("walks the email lifecycle", () => {
    expect(recoveryStage({ status: "pending", emailStatus: "queued" }).label).toBe("Email scheduled");
    expect(recoveryStage({ status: "contacted", lastChannel: "email", emailStatus: "sent" }).label).toBe("Email sent");
    expect(recoveryStage({ status: "contacted", emailStatus: "sent", clickedAt: "2026-10-01T00:00:00Z" }).label).toBe("Link clicked");
    expect(recoveryStage({ status: "pending", emailStatus: "failed" })).toEqual({ label: "Email failed", tone: "destructive" });
    expect(recoveryStage({ status: "pending", emailStatus: "suppressed" }).label).toMatch(/blocked/);
    expect(recoveryStage({ status: "pending", emailStatus: "cancelled", emailCancelReason: "order_exists" }).label).toBe("Ordered another way");
  });

  it("merchant-assisted rows without an automatic email", () => {
    expect(recoveryStage({ status: "pending" })).toEqual({ label: "Needs outreach", tone: "warning" });
    expect(recoveryStage({ status: "contacted", lastChannel: "call" }).label).toBe("Contacted (call)");
  });
});

describe("recovery rate", () => {
  it("formats a fraction, and shows a dash before there is data", () => {
    expect(formatRecoveryRate(null)).toBe("—");
    expect(formatRecoveryRate(0)).toBe("0%");
    expect(formatRecoveryRate(0.25)).toBe("25%");
    expect(formatRecoveryRate(0.05)).toBe("5.0%");
  });
});
