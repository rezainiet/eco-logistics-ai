import { describe, expect, it } from "vitest";
import {
  canTransitionAutomation,
  decideAutomationAction,
} from "../src/lib/automation.js";

describe("decideAutomationAction — disabled / manual", () => {
  it("returns no_op when config is missing or disabled", () => {
    expect(decideAutomationAction("low", 5, undefined).action).toBe("no_op");
    expect(decideAutomationAction("low", 5, null).action).toBe("no_op");
    expect(decideAutomationAction("low", 5, { enabled: false, mode: "full_auto" }).action).toBe("no_op");
  });

  it("returns no_op when enabled but mode is manual", () => {
    expect(
      decideAutomationAction("low", 5, { enabled: true, mode: "manual" }).action,
    ).toBe("no_op");
  });

  it("never marks state when disabled (state stays not_evaluated)", () => {
    expect(
      decideAutomationAction("low", 5, { enabled: false, mode: "full_auto" }).state,
    ).toBe("not_evaluated");
  });
});

describe("decideAutomationAction — semi_auto", () => {
  const cfg = { enabled: true, mode: "semi_auto" as const, maxRiskForAutoConfirm: 39 };

  it("auto-confirms low risk", () => {
    const d = decideAutomationAction("low", 10, cfg);
    expect(d.action).toBe("auto_confirm");
    expect(d.state).toBe("auto_confirmed");
    expect(d.shouldAutoBook).toBe(false);
  });

  it("await_confirmation for medium", () => {
    const d = decideAutomationAction("medium", 50, cfg);
    expect(d.action).toBe("await_confirmation");
    expect(d.state).toBe("pending_confirmation");
  });

  it("requires_review for high — even when score is just over threshold", () => {
    const d = decideAutomationAction("high", 71, cfg);
    expect(d.action).toBe("requires_review");
    expect(d.state).toBe("requires_review");
  });

  it("never auto-books in semi_auto", () => {
    expect(
      decideAutomationAction("low", 5, { ...cfg, autoBookEnabled: true }).shouldAutoBook,
    ).toBe(false);
  });
});

describe("decideAutomationAction — full_auto", () => {
  const cfg = {
    enabled: true,
    mode: "full_auto" as const,
    maxRiskForAutoConfirm: 39,
    autoBookEnabled: true,
  };

  it("auto-confirms AND books low risk under ceiling", () => {
    const d = decideAutomationAction("low", 10, cfg);
    expect(d.action).toBe("auto_confirm_and_book");
    expect(d.state).toBe("auto_confirmed");
    expect(d.shouldAutoBook).toBe(true);
  });

  it("only auto-confirms when autoBookEnabled is off", () => {
    const d = decideAutomationAction("low", 10, { ...cfg, autoBookEnabled: false });
    expect(d.action).toBe("auto_confirm");
    expect(d.shouldAutoBook).toBe(false);
  });

  it("respects ceiling — low-level + score 45 with ceiling 39 stays pending", () => {
    const d = decideAutomationAction("low", 45, { ...cfg, maxRiskForAutoConfirm: 39 });
    expect(d.action).toBe("await_confirmation");
    expect(d.shouldAutoBook).toBe(false);
  });

  it("medium always pending, never auto-confirmed regardless of mode", () => {
    expect(decideAutomationAction("medium", 40, cfg).action).toBe("await_confirmation");
    expect(decideAutomationAction("medium", 60, cfg).action).toBe("await_confirmation");
  });

  it("high always requires_review regardless of mode/ceiling", () => {
    expect(decideAutomationAction("high", 80, cfg).action).toBe("requires_review");
    expect(
      decideAutomationAction("high", 80, { ...cfg, maxRiskForAutoConfirm: 100 }).action,
    ).toBe("requires_review");
  });
});

describe("canTransitionAutomation — idempotency + safety", () => {
  it("allows the same-state self-transition (idempotent)", () => {
    expect(canTransitionAutomation("confirmed", "confirmed")).toBe(true);
    expect(canTransitionAutomation("rejected", "rejected")).toBe(true);
  });

  it("allows pending → confirmed and pending → rejected", () => {
    expect(canTransitionAutomation("pending_confirmation", "confirmed")).toBe(true);
    expect(canTransitionAutomation("pending_confirmation", "rejected")).toBe(true);
  });

  it("allows fresh evaluation paths from not_evaluated", () => {
    expect(canTransitionAutomation("not_evaluated", "auto_confirmed")).toBe(true);
    expect(canTransitionAutomation("not_evaluated", "pending_confirmation")).toBe(true);
    expect(canTransitionAutomation("not_evaluated", "requires_review")).toBe(true);
  });

  it("blocks walking back from rejected (terminal)", () => {
    expect(canTransitionAutomation("rejected", "confirmed")).toBe(false);
    expect(canTransitionAutomation("rejected", "auto_confirmed")).toBe(false);
    expect(canTransitionAutomation("rejected", "pending_confirmation")).toBe(false);
  });

  it("allows confirmed → rejected (operator override before shipping)", () => {
    expect(canTransitionAutomation("confirmed", "rejected")).toBe(true);
    expect(canTransitionAutomation("auto_confirmed", "rejected")).toBe(true);
  });

  it("blocks confirmed → pending (no walk-back to await)", () => {
    expect(canTransitionAutomation("confirmed", "pending_confirmation")).toBe(false);
    expect(canTransitionAutomation("auto_confirmed", "pending_confirmation")).toBe(false);
  });

  it("undefined from-state defaults to not_evaluated", () => {
    expect(canTransitionAutomation(undefined, "auto_confirmed")).toBe(true);
    expect(canTransitionAutomation(undefined, "rejected")).toBe(true);
  });
});
