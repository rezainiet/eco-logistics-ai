import { describe, expect, it } from "vitest";
import { deriveOnboardingProgress, type OnboardingState } from "./progress";

const blank: OnboardingState = {
  hasStoreConnected: false,
  hasCourier: false,
  hasFirstOrder: false,
  automationOn: false,
  smsTested: false,
};

describe("deriveOnboardingProgress", () => {
  it("returns 0% when nothing is done and surfaces 'connect store' first", () => {
    const r = deriveOnboardingProgress(blank);
    expect(r.percent).toBe(0);
    expect(r.doneCount).toBe(0);
    expect(r.totalCount).toBe(5);
    expect(r.complete).toBe(false);
    expect(r.nextStep?.key).toBe("connect_store");
  });

  it("walks through the steps in the new merchant-led order", () => {
    expect(
      deriveOnboardingProgress({ ...blank, hasStoreConnected: true }).nextStep?.key,
    ).toBe("import_orders");

    expect(
      deriveOnboardingProgress({
        ...blank,
        hasStoreConnected: true,
        hasFirstOrder: true,
      }).nextStep?.key,
    ).toBe("add_courier");

    expect(
      deriveOnboardingProgress({
        ...blank,
        hasStoreConnected: true,
        hasFirstOrder: true,
        hasCourier: true,
      }).nextStep?.key,
    ).toBe("enable_automation");

    expect(
      deriveOnboardingProgress({
        ...blank,
        hasStoreConnected: true,
        hasFirstOrder: true,
        hasCourier: true,
        automationOn: true,
      }).nextStep?.key,
    ).toBe("test_sms");
  });

  it("reports 100% + complete when every step is true", () => {
    const r = deriveOnboardingProgress({
      hasStoreConnected: true,
      hasCourier: true,
      hasFirstOrder: true,
      automationOn: true,
      smsTested: true,
    });
    expect(r.percent).toBe(100);
    expect(r.complete).toBe(true);
    expect(r.nextStep).toBeNull();
  });

  it("step ordering is stable even when a later step gets done early", () => {
    // Merchant flipped automation on without connecting a store yet — UI
    // still flags 'connect store' as the current focus.
    const r = deriveOnboardingProgress({ ...blank, automationOn: true });
    expect(r.nextStep?.key).toBe("connect_store");
    // Automation is the fourth step (index 3) — confirm it shows as done.
    expect(r.steps[3]!.key).toBe("enable_automation");
    expect(r.steps[3]!.done).toBe(true);
  });

  it("each step exposes a CTA href that points inside /dashboard", () => {
    const r = deriveOnboardingProgress(blank);
    for (const s of r.steps) {
      expect(s.ctaHref.startsWith("/dashboard/")).toBe(true);
      expect(s.ctaLabel.length).toBeGreaterThan(2);
    }
  });

  it("import-orders CTA deep-links to integrations once a store is connected", () => {
    // When the store is wired up, "Add an order" becomes "Import orders"
    // and points at the integrations page where the import button lives.
    const linked = deriveOnboardingProgress({ ...blank, hasStoreConnected: true });
    const importStep = linked.steps.find((s) => s.key === "import_orders")!;
    expect(importStep.ctaHref).toBe("/dashboard/integrations");
    expect(importStep.ctaLabel.toLowerCase()).toContain("import");

    // Without a store, fall back to the manual / CSV entry point.
    const manual = deriveOnboardingProgress(blank);
    const manualStep = manual.steps.find((s) => s.key === "import_orders")!;
    expect(manualStep.ctaHref).toBe("/dashboard/orders?new=1");
  });

  it("done steps render with strikethrough-friendly state", () => {
    const r = deriveOnboardingProgress({
      hasStoreConnected: true,
      hasFirstOrder: true,
      hasCourier: false,
      automationOn: false,
      smsTested: false,
    });
    expect(r.steps.filter((s) => s.done)).toHaveLength(2);
    expect(r.steps.filter((s) => !s.done)).toHaveLength(3);
  });
});
