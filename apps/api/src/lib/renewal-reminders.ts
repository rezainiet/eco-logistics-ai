import { Merchant } from "@ecom/db";
import { renewalDate, renewalReminderWindow, renewalWhen, RENEWAL_REMINDER_DAYS, type RenewalReminderWindow } from "@ecom/types";
import { buildRenewalReminderEmail, sendEmail, webUrl } from "./email.js";
import { dispatchNotification } from "./notifications.js";
import { getPlan } from "./plans.js";

/**
 * Renewal reminders for manually paid plans.
 *
 * A manual plan (`billingProvider: "manual"` — bKash / Nagad / bank receipt
 * or a one-shot card checkout) is paid until `currentPeriodEnd` and does
 * not renew by itself; access stops then (lib/entitlements.ts,
 * subscriptionAccessDenial — unchanged here: no grace is added). So the
 * merchant is reminded 7, 3 and 1 day(s) before — in-app, plus the email
 * channel billing reminders already use (trial reminder).
 *
 *   - Recurring Stripe subscriptions renew themselves: never reminded here.
 *   - A payment awaiting approval (`pendingPaymentId`): not reminded.
 *   - At most one reminder per window per billing period: the dedupe key
 *     carries the period end and the window, so re-running is a no-op and a
 *     renewal (new period end) starts fresh, with no stale reminders.
 *   - Only the window that applies now is sent (a late first check sends
 *     the 1-day reminder, never a stale 7-day one).
 *
 * Dates are shown in the app's calendar (Bangladesh, as accounting uses).
 */

const SCAN_BATCH = 500;
const MS_PER_DAY = 86_400_000;
const MONEY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export interface RenewalReminderResult {
  scanned: number;
  notified: number;
  emailed: number;
  /** Skipped because a payment is awaiting approval. */
  pendingPayment: number;
  /** Already reminded for this window (re-run). */
  alreadySent: number;
}

export const renewalReminderKey = (periodEnd: Date, window: RenewalReminderWindow) =>
  `renewal:${periodEnd.toISOString()}:${window}d`;

export async function sweepRenewalReminders(now: Date = new Date()): Promise<RenewalReminderResult> {
  const horizon = new Date(now.getTime() + Math.max(...RENEWAL_REMINDER_DAYS) * MS_PER_DAY);
  const due = await Merchant.find({
    "subscription.status": "active",
    "subscription.billingProvider": { $ne: "stripe_subscription" },
    "subscription.currentPeriodEnd": { $gt: now, $lte: horizon },
  })
    .select("email businessName subscription")
    .limit(SCAN_BATCH)
    .lean();

  const result: RenewalReminderResult = { scanned: due.length, notified: 0, emailed: 0, pendingPayment: 0, alreadySent: 0 };
  for (const m of due) {
    const sub = m.subscription!;
    const periodEnd = new Date(sub.currentPeriodEnd!);
    const window = renewalReminderWindow(periodEnd, now);
    if (!window) continue;
    if (sub.pendingPaymentId) {
      result.pendingPayment += 1;
      continue;
    }
    const plan = getPlan(sub.tier);
    // Renewing is charged at the plan's current price (checkout and approval both use it).
    const amount = plan.priceBDT;
    const amountText = `৳${MONEY.format(amount)}`;
    const when = renewalWhen(periodEnd, now);
    const endsOn = renewalDate(periodEnd);
    const { inAppCreated } = await dispatchNotification({
      merchantId: m._id,
      kind: "subscription.renewal_due",
      severity: window === 7 ? "info" : window === 3 ? "warning" : "critical",
      skipSms: true,
      title: `Your ${plan.name} plan ends ${when}`,
      body: `Your ${plan.name} plan (${amountText}/month) is paid until ${endsOn} and does not renew automatically. Renew before then to keep orders, verification and courier booking running — pay by bKash, Nagad or bank transfer and upload the receipt on the Billing page.`,
      link: "/dashboard/settings/billing",
      subjectType: "merchant",
      subjectId: m._id,
      meta: { window, periodEnd, tier: plan.tier, amount },
      dedupeKey: renewalReminderKey(periodEnd, window),
    });
    if (!inAppCreated) {
      result.alreadySent += 1;
      continue;
    }
    result.notified += 1;
    // Same reminder by email, once (only when the in-app row was new).
    const tpl = buildRenewalReminderEmail({
      businessName: m.businessName,
      planName: plan.name,
      when,
      endsOn,
      amount: amountText,
      billingUrl: webUrl("/dashboard/settings/billing"),
    });
    const sent = await sendEmail({ to: m.email, subject: tpl.subject, html: tpl.html, text: tpl.text, tag: "renewal_reminder" }).catch(() => ({ ok: false }));
    if (sent.ok) result.emailed += 1;
  }
  return result;
}
