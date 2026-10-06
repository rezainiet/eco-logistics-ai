import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Merchant, Notification } from "@ecom/db";
import { renewalReminderWindow, renewalWhen } from "@ecom/types";
import { sweepRenewalReminders } from "../src/lib/renewal-reminders.js";
import { subscriptionAccessDenial } from "../src/lib/entitlements.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Manually paid plans don't renew by themselves and access stops at
 * currentPeriodEnd — so the merchant is reminded 7 / 3 / 1 day(s) before,
 * once per window per billing period, and never told to renew when they
 * pay through a recurring Stripe subscription or have a payment pending.
 */

beforeAll(ensureDb);
afterAll(disconnectDb);
beforeEach(resetDb);

const DAY = 86_400_000;
// The period ends at a fixed instant; the sweep is run "as of" different moments before it.
const END = new Date("2026-11-20T06:00:00.000Z");
const before = (days: number) => new Date(END.getTime() - days * DAY);

async function manualMerchant(overrides: { billingProvider?: "manual" | "stripe_subscription"; status?: "active" | "trial" | "past_due"; end?: Date } = {}) {
  const m = await createMerchant({ status: overrides.status ?? "active", currentPeriodEnd: overrides.end ?? END });
  if (overrides.billingProvider) {
    await Merchant.updateOne({ _id: m._id }, { $set: { "subscription.billingProvider": overrides.billingProvider } });
  }
  return { mid: m._id as Types.ObjectId, caller: callerFor(authUserFor(m)) };
}
const reminders = (mid: Types.ObjectId) =>
  Notification.find({ merchantId: mid, kind: "subscription.renewal_due" }).sort({ createdAt: 1 }).lean();

describe("reminder windows", () => {
  it("7 / 3 / 1 day(s) before, the smallest window that applies; nothing outside 7 days or after the end", () => {
    expect(renewalReminderWindow(END, before(8))).toBeNull();
    expect(renewalReminderWindow(END, before(7))).toBe(7);
    expect(renewalReminderWindow(END, before(4))).toBe(7);
    expect(renewalReminderWindow(END, before(3))).toBe(3);
    expect(renewalReminderWindow(END, before(1.5))).toBe(3);
    expect(renewalReminderWindow(END, before(1))).toBe(1);
    expect(renewalReminderWindow(END, before(0.1))).toBe(1);
    expect(renewalReminderWindow(END, END)).toBeNull();
    expect(renewalReminderWindow(null, before(1))).toBeNull();
  });

  it("'today' / 'tomorrow' follow the Bangladesh calendar day", () => {
    // END is 12:00 in Dhaka on 20 Nov.
    expect(renewalWhen(END, new Date("2026-11-20T01:00:00.000Z"))).toBe("today");
    expect(renewalWhen(END, new Date("2026-11-19T18:30:00.000Z"))).toBe("today"); // 00:30 on 20 Nov in Dhaka (still 19 Nov in UTC)
    expect(renewalWhen(END, new Date("2026-11-19T17:30:00.000Z"))).toBe("tomorrow"); // 23:30 on 19 Nov in Dhaka
    expect(renewalWhen(END, new Date("2026-11-19T10:00:00.000Z"))).toBe("tomorrow");
    expect(renewalWhen(END, before(6.5))).toBe("in 7 days");
  });
});

describe("renewal reminders for manual payers", () => {
  it("7 days out: one informational reminder in-app (plan, date, amount, Billing link) and by email", async () => {
    const { mid, caller } = await manualMerchant();
    const r = await sweepRenewalReminders(before(6.5));
    expect(r).toMatchObject({ scanned: 1, notified: 1, emailed: 1 });
    const [n] = await reminders(mid);
    expect(n).toMatchObject({
      severity: "info",
      title: "Your Pro plan ends in 7 days",
      link: "/dashboard/settings/billing",
      subjectType: "merchant",
      meta: { window: 7, tier: "scale" },
    });
    expect(n!.body).toContain("is paid until 20 Nov 2026 and does not renew automatically");
    expect(n!.body).toContain("৳5,999/month");
    expect(n!.body).toContain("bKash, Nagad or bank transfer");
    const [item] = (await caller.notifications.inbox()).items;
    expect(item).toMatchObject({ kind: "subscription.renewal_due", category: "account", href: "/dashboard/settings/billing" });
  });

  it("3 days out: a stronger reminder; 1 day out: an urgent one (no SMS)", async () => {
    const { mid } = await manualMerchant();
    await sweepRenewalReminders(before(2.5));
    await sweepRenewalReminders(before(0.4));
    const [three, one] = await reminders(mid);
    expect(three).toMatchObject({ severity: "warning", meta: { window: 3 }, title: "Your Pro plan ends in 3 days" });
    expect(one).toMatchObject({ severity: "critical", meta: { window: 1 } });
    expect(one!.title).toMatch(/^Your Pro plan ends (today|tomorrow)$/);
  });

  it("re-running the check never duplicates a window; each window fires once as the end approaches", async () => {
    const { mid } = await manualMerchant();
    for (let i = 0; i < 4; i++) await sweepRenewalReminders(before(6.5));
    expect(await reminders(mid)).toHaveLength(1);
    const again = await sweepRenewalReminders(before(6));
    expect(again).toMatchObject({ notified: 0, alreadySent: 1, emailed: 0 });
    await sweepRenewalReminders(before(2.9));
    await sweepRenewalReminders(before(2.1));
    await sweepRenewalReminders(before(0.9));
    await sweepRenewalReminders(before(0.2));
    expect((await reminders(mid)).map((n) => n.meta?.window)).toEqual([7, 3, 1]);
  });

  it("a late first check sends only the window that still applies — no stale 7-day reminder", async () => {
    const { mid } = await manualMerchant();
    await sweepRenewalReminders(before(0.5));
    expect((await reminders(mid)).map((n) => n.meta?.window)).toEqual([1]);
  });

  it("already renewed (period moved on): no stale reminder for the old period, fresh windows for the new one", async () => {
    const { mid } = await manualMerchant();
    await sweepRenewalReminders(before(6.5));
    const newEnd = new Date(END.getTime() + 30 * DAY);
    await Merchant.updateOne({ _id: mid }, { $set: { "subscription.currentPeriodEnd": newEnd } });
    expect(await sweepRenewalReminders(before(2.5))).toMatchObject({ scanned: 0, notified: 0 });
    expect(await reminders(mid)).toHaveLength(1);
    await sweepRenewalReminders(new Date(newEnd.getTime() - 6 * DAY));
    const all = await reminders(mid);
    expect(all).toHaveLength(2);
    expect(new Date(all[1]!.meta!.periodEnd as Date).getTime()).toBe(newEnd.getTime());
  });

  it("recurring Stripe subscriptions renew on their own — no manual renewal reminder", async () => {
    const { mid } = await manualMerchant({ billingProvider: "stripe_subscription" });
    expect(await sweepRenewalReminders(before(2))).toMatchObject({ scanned: 0, notified: 0 });
    expect(await reminders(mid)).toHaveLength(0);
  });

  it("expired, trial and past_due subscriptions get no renewal reminder windows", async () => {
    const expired = await manualMerchant({ end: new Date(Date.now() - DAY) });
    const trial = await manualMerchant({ status: "trial" });
    const pastDue = await manualMerchant({ status: "past_due" });
    await sweepRenewalReminders(before(2));
    await sweepRenewalReminders();
    for (const m of [expired, trial, pastDue]) expect(await reminders(m.mid)).toHaveLength(0);
  });

  it("a renewal payment awaiting approval suppresses the reminder", async () => {
    const { mid } = await manualMerchant();
    await Merchant.updateOne({ _id: mid }, { $set: { "subscription.pendingPaymentId": new Types.ObjectId() } });
    expect(await sweepRenewalReminders(before(2.5))).toMatchObject({ scanned: 1, notified: 0, pendingPayment: 1 });
    expect(await reminders(mid)).toHaveLength(0);
  });

  it("tenant isolation: only the merchant whose plan is ending is reminded", async () => {
    const due = await manualMerchant();
    const later = await manualMerchant({ end: new Date(END.getTime() + 20 * DAY) });
    await sweepRenewalReminders(before(2.5));
    expect(await reminders(due.mid)).toHaveLength(1);
    expect(await reminders(later.mid)).toHaveLength(0);
    expect((await later.caller.notifications.inbox()).items.filter((i) => i.kind === "subscription.renewal_due")).toHaveLength(0);
  });
});

describe("access at currentPeriodEnd is unchanged (no grace added)", () => {
  it("a manual plan is billable until the period end and blocked from that moment", async () => {
    const sub = { status: "active", tier: "scale", currentPeriodEnd: END };
    expect(subscriptionAccessDenial(sub, END.getTime() - 1)).toBeNull();
    expect(subscriptionAccessDenial(sub, END.getTime())).toBe("subscription_past_due");
    expect(subscriptionAccessDenial(sub, END.getTime() + DAY)).toBe("subscription_past_due");

    const ended = await manualMerchant({ end: new Date(Date.now() - 60_000) });
    await expect(ended.caller.orders.bookShipment({ orderId: new Types.ObjectId().toHexString(), courier: "pathao" })).rejects.toThrow(
      "subscription_past_due",
    );
    const running = await manualMerchant({ end: new Date(Date.now() + 2 * DAY) });
    await expect(running.caller.orders.bookShipment({ orderId: new Types.ObjectId().toHexString(), courier: "pathao" })).rejects.toThrow(
      /order not found/,
    );
  });
});
