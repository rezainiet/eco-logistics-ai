import { renewalDate, renewalReminderWindow, renewalWhen } from "@ecom/types/renewal";

/**
 * The dashboard banner for a manually paid plan nearing (or past) its end.
 * Manual plans don't renew by themselves and access stops at
 * `currentPeriodEnd` — this only tells the merchant in time; it never
 * changes access. Same windows as the API's renewal reminders (7 / 3 / 1
 * days, `@ecom/types/renewal`). Recurring Stripe subscriptions renew on
 * their own and get nothing here; trial / past_due / suspended keep their
 * existing banners.
 */

export interface RenewalSubscriptionLike {
  status: string;
  billingProvider: "manual" | "stripe_subscription";
  currentPeriodEnd: Date | string | null;
  pendingPaymentId: string | null;
}

export interface RenewalNotice {
  tone: "info" | "warning" | "error";
  message: string;
  /** Link text to the Billing page; null when there is nothing to do. */
  action: string | null;
}

export function renewalNotice(sub: RenewalSubscriptionLike, planName: string, now: Date = new Date()): RenewalNotice | null {
  if (sub.status !== "active" || sub.billingProvider === "stripe_subscription" || !sub.currentPeriodEnd) return null;
  const end = new Date(sub.currentPeriodEnd);
  const date = renewalDate(end);
  const pending = !!sub.pendingPaymentId;

  if (end.getTime() <= now.getTime()) {
    return pending
      ? { tone: "warning", message: `Your ${planName} plan ended on ${date}. Your payment is awaiting confirmation — access returns as soon as it's approved.`, action: null }
      : { tone: "error", message: `Your ${planName} plan ended on ${date}, so orders, verification and booking are paused.`, action: "Renew to restore access" };
  }

  const window = renewalReminderWindow(end, now);
  if (!window) return null;
  if (pending) {
    return { tone: "info", message: `Renewal payment received — awaiting confirmation. Your ${planName} plan is paid until ${date}.`, action: null };
  }
  const when = renewalWhen(end, now);
  if (window === 1) {
    return { tone: "error", message: `Your ${planName} plan ends ${when} (${date}) and does not renew automatically.`, action: "Renew now to keep access" };
  }
  return {
    tone: window === 3 ? "warning" : "info",
    message: `Your ${planName} plan ends ${when} (${date}) and does not renew automatically.`,
    action: "Renew now",
  };
}
