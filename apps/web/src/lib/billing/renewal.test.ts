import { describe, expect, it } from "vitest";
import { renewalNotice, type RenewalSubscriptionLike } from "./renewal";

/**
 * The dashboard banner for a manually paid plan: informational a week out,
 * stronger at 3 days, urgent on the last day, a clear "ended" state after
 * (access already stops there — unchanged), and quiet for Stripe
 * subscriptions or while a renewal payment awaits approval.
 */

const DAY = 86_400_000;
const END = new Date("2026-11-20T06:00:00.000Z"); // 12:00 on 20 Nov in Dhaka
const at = (daysBefore: number) => new Date(END.getTime() - daysBefore * DAY);
const manual = (over: Partial<RenewalSubscriptionLike> = {}): RenewalSubscriptionLike => ({
  status: "active",
  billingProvider: "manual",
  currentPeriodEnd: END.toISOString(),
  pendingPaymentId: null,
  ...over,
});

describe("renewal banner", () => {
  it("quiet more than a week out", () => {
    expect(renewalNotice(manual(), "Growth", at(10))).toBeNull();
  });

  it("7 days → informational, 3 days → warning, last day → urgent", () => {
    expect(renewalNotice(manual(), "Growth", at(6.5))).toEqual({
      tone: "info",
      message: "Your Growth plan ends in 7 days (20 Nov 2026) and does not renew automatically.",
      action: "Renew now",
    });
    expect(renewalNotice(manual(), "Growth", at(2.5))).toMatchObject({ tone: "warning", message: expect.stringContaining("ends in 3 days") });
    expect(renewalNotice(manual(), "Growth", new Date("2026-11-19T10:00:00.000Z"))).toEqual({
      tone: "error",
      message: "Your Growth plan ends tomorrow (20 Nov 2026) and does not renew automatically.",
      action: "Renew now to keep access",
    });
    expect(renewalNotice(manual(), "Growth", new Date("2026-11-20T01:00:00.000Z"))?.message).toContain("ends today");
  });

  it("after the end: a clear ended state with the renew path", () => {
    expect(renewalNotice(manual(), "Growth", new Date(END.getTime() + 1000))).toEqual({
      tone: "error",
      message: "Your Growth plan ended on 20 Nov 2026, so orders, verification and booking are paused.",
      action: "Renew to restore access",
    });
  });

  it("a renewal payment awaiting approval replaces the 'renew' prompt", () => {
    const pending = manual({ pendingPaymentId: "6a0000000000000000000001" });
    expect(renewalNotice(pending, "Growth", at(2.5))).toEqual({
      tone: "info",
      message: "Renewal payment received — awaiting confirmation. Your Growth plan is paid until 20 Nov 2026.",
      action: null,
    });
    expect(renewalNotice(pending, "Growth", new Date(END.getTime() + 1000))).toMatchObject({ tone: "warning", action: null });
  });

  it("nothing for recurring Stripe subscriptions, or for trial / past_due (they keep their own banners)", () => {
    expect(renewalNotice(manual({ billingProvider: "stripe_subscription" }), "Growth", at(1))).toBeNull();
    expect(renewalNotice(manual({ status: "trial" }), "Growth", at(1))).toBeNull();
    expect(renewalNotice(manual({ status: "past_due" }), "Growth", at(1))).toBeNull();
    expect(renewalNotice(manual({ currentPeriodEnd: null }), "Growth", at(1))).toBeNull();
  });
});
