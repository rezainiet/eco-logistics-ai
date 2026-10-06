/**
 * Renewal reminders for manually paid plans (bKash / Nagad / bank receipt,
 * one-shot card checkout). Such a plan does not renew by itself: access ends
 * at `currentPeriodEnd` unless the merchant pays again. Shared by the API
 * reminder sweep and the dashboard banner so both name the same window.
 * Dependency-free.
 */

/** Days before the period ends at which a manual payer is reminded. */
export const RENEWAL_REMINDER_DAYS = [7, 3, 1] as const;
export type RenewalReminderWindow = (typeof RENEWAL_REMINDER_DAYS)[number];

const MS_PER_DAY = 86_400_000;

/**
 * The reminder window a period end falls in right now — the smallest one
 * that covers the time left (whole days, rounded up), so a late first check
 * sends only the window that still applies. Null more than 7 days out, and
 * once the period has ended.
 */
export function renewalReminderWindow(
  periodEnd: Date | string | null | undefined,
  now: Date = new Date(),
): RenewalReminderWindow | null {
  if (!periodEnd) return null;
  const ms = new Date(periodEnd).getTime() - now.getTime();
  if (!(ms > 0)) return null;
  const days = Math.ceil(ms / MS_PER_DAY);
  for (const w of [...RENEWAL_REMINDER_DAYS].reverse()) if (days <= w) return w;
  return null;
}

// Dates are the app's calendar days — Bangladesh, as accounting uses.
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" });
const SHOWN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" });

/** "13 Oct 2026". */
export function renewalDate(periodEnd: Date | string): string {
  return SHOWN.format(new Date(periodEnd));
}

/** When the period ends, said plainly: "today", "tomorrow" or "in N days". */
export function renewalWhen(periodEnd: Date | string, now: Date = new Date()): string {
  const end = new Date(periodEnd);
  const endDay = DAY.format(end);
  if (endDay === DAY.format(now)) return "today";
  if (endDay === DAY.format(new Date(now.getTime() + MS_PER_DAY))) return "tomorrow";
  return `in ${Math.max(1, Math.ceil((end.getTime() - now.getTime()) / MS_PER_DAY))} days`;
}
