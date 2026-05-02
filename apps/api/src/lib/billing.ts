/**
 * Subscription / billing helpers.
 *
 * The two router-side summarisers (`billingView` in routers/merchants.ts and
 * `summarizeSubscription` in routers/billing.ts) intentionally produce
 * different shapes — the former for the merchant profile surface, the latter
 * for the billing dashboard which also exposes grace-period + pending-payment
 * detail. They share the trial-days math, which lives here so a change to the
 * day-rounding rule only needs to be made once.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Whole days remaining until `target`, never negative. Returns `null` if
 * `target` is null/undefined so callers can pass through `sub.trialEndsAt`
 * without a manual guard.
 */
export function daysLeftUntil(target: Date | null | undefined): number | null {
  if (!target) return null;
  return Math.max(0, Math.ceil((target.getTime() - Date.now()) / MS_PER_DAY));
}

/**
 * Has the date already passed? Used to decide things like "trial expired".
 */
export function hasElapsed(target: Date | null | undefined): boolean {
  if (!target) return false;
  return target.getTime() <= Date.now();
}

/**
 * Trial-state derivation shared by every billing summariser. Centralises the
 * rule that `trialDaysLeft` only matters while status === "trial" — once the
 * subscription is active/past-due/etc. the field is null even if the trial
 * end date is still in the future.
 */
export function computeTrialState(
  status: string | undefined,
  trialEndsAt: Date | null | undefined,
): { trialDaysLeft: number | null; trialExpired: boolean } {
  if (status !== "trial") {
    return { trialDaysLeft: null, trialExpired: false };
  }
  return {
    trialDaysLeft: daysLeftUntil(trialEndsAt),
    trialExpired: hasElapsed(trialEndsAt),
  };
}
