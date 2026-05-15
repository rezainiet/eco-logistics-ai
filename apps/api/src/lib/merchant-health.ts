/**
 * Merchant operational-health heuristic.
 *
 * Deliberately NOT a scoring engine. Six plain operational states,
 * first-match-wins by urgency, so a founder reading the daily digest
 * instantly knows who to message and why. Pure + total: same inputs →
 * same output, no I/O, unit-tested. Tune the thresholds from real beta
 * behaviour — they are honest guesses until then.
 */

export type MerchantHealth =
  | "healthy"
  | "onboarding_stuck"
  | "sync_issues"
  | "queue_neglected"
  | "low_confirmation"
  | "inactive";

export interface MerchantHealthInput {
  /** Merchant account age in days. */
  accountAgeDays: number;
  ordersAllTime: number;
  /** Days since the most recent order; null = never had one. */
  lastOrderAgeDays: number | null;
  pending: number;
  /** Age of the oldest pending_confirmation order in hours; null = none. */
  oldestPendingAgeHours: number | null;
  /** Confirmation SMS attempts in the last 7d (code minted). */
  confirmAttempts7d: number;
  /** Reply rate % over those attempts; null = nothing attempted. */
  replyRate7dPct: number | null;
  failedImports: number;
}

export interface MerchantHealthResult {
  status: MerchantHealth;
  /** One-line, founder-language reason for the status. */
  reason: string;
}

export function classifyMerchantHealth(
  i: MerchantHealthInput,
): MerchantHealthResult {
  // 1. Never produced an order despite being onboarded a while — the
  //    install/connect/backfill never delivered. Highest priority: this
  //    merchant has literally never seen value.
  if (i.ordersAllTime === 0 && i.accountAgeDays >= 2) {
    return {
      status: "onboarding_stuck",
      reason: `no orders ${i.accountAgeDays}d after signup — connect/backfill never delivered`,
    };
  }

  // 2. Imports are failing — orders may exist upstream but aren't
  //    flowing in. A data-integrity problem the merchant can't see.
  if (i.failedImports > 0) {
    return {
      status: "sync_issues",
      reason: `${i.failedImports} failed import(s) — orders may not be syncing`,
    };
  }

  // 3. Queue left to rot — confirmations age into RTO. Most direct
  //    money-losing operational state.
  if (i.oldestPendingAgeHours !== null && i.oldestPendingAgeHours >= 24) {
    return {
      status: "queue_neglected",
      reason: `${i.pending} pending, oldest ${Math.floor(
        i.oldestPendingAgeHours,
      )}h — shipping unconfirmed = RTO`,
    };
  }

  // 4. Customers aren't engaging the SMS — the product thesis is failing
  //    for this merchant specifically. Need enough volume to be real.
  if (
    i.confirmAttempts7d >= 5 &&
    i.replyRate7dPct !== null &&
    i.replyRate7dPct < 15
  ) {
    return {
      status: "low_confirmation",
      reason: `${i.replyRate7dPct}% reply on ${i.confirmAttempts7d} attempts — customers not responding`,
    };
  }

  // 5. Had orders, then went quiet — early churn signal.
  if (
    i.ordersAllTime > 0 &&
    (i.lastOrderAgeDays === null || i.lastOrderAgeDays >= 7)
  ) {
    return {
      status: "inactive",
      reason: `no orders in ${
        i.lastOrderAgeDays ?? "?"
      }d — possible silent churn`,
    };
  }

  return { status: "healthy", reason: "ok" };
}
