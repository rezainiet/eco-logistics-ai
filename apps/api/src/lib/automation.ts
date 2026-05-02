/**
 * Order automation decision engine.
 *
 * Pure function: same inputs → same outputs. Never reads the DB, never
 * mutates state. Holds the entire policy matrix in one place so the
 * router doesn't sprout a tangle of if/else.
 *
 * Inputs:
 *   riskLevel, riskScore  — output of computeRisk
 *   config                — merchant.automationConfig
 *
 * Output:
 *   action  — what the engine wants to do next
 *   state   — the corresponding `order.automation.state` to persist
 *   reason  — short string for the merchant ("Low risk + full auto")
 */

export type AutomationMode = "manual" | "semi_auto" | "full_auto";

export interface AutomationConfigInput {
  enabled?: boolean;
  mode?: AutomationMode;
  maxRiskForAutoConfirm?: number;
  autoBookEnabled?: boolean;
}

export type AutomationAction =
  | "auto_confirm"        // System confirms now; bookable next.
  | "auto_confirm_and_book" // System confirms AND triggers booking.
  | "await_confirmation"  // Merchant clicks Confirm or Reject.
  | "requires_review"     // High-risk — fraud-review queue, no auto-confirm.
  | "no_op";              // Automation disabled or in manual mode.

export type AutomationState =
  | "not_evaluated"
  | "auto_confirmed"
  | "pending_confirmation"
  | "confirmed"
  | "rejected"
  | "requires_review";

export interface AutomationDecision {
  action: AutomationAction;
  state: AutomationState;
  reason: string;
  /** True when the next step (after persisting state) should kick auto-book. */
  shouldAutoBook: boolean;
}

const DEFAULT_THRESHOLD = 39;

export function decideAutomationAction(
  riskLevel: "low" | "medium" | "high",
  riskScore: number,
  config: AutomationConfigInput | null | undefined,
): AutomationDecision {
  // Disabled / unset → leave the order in pending status (existing behaviour).
  // The order.automation.state stays "not_evaluated" so the UI can hide the
  // automation badge for merchants who haven't opted in.
  const enabled = config?.enabled === true;
  const mode = config?.mode ?? "manual";

  if (!enabled || mode === "manual") {
    return {
      action: "no_op",
      state: "not_evaluated",
      reason: enabled ? "manual mode" : "automation disabled",
      shouldAutoBook: false,
    };
  }

  // High-risk ALWAYS requires review, regardless of mode. Safety > speed.
  if (riskLevel === "high") {
    return {
      action: "requires_review",
      state: "requires_review",
      reason: `high risk (score ${riskScore})`,
      shouldAutoBook: false,
    };
  }

  const ceiling = config?.maxRiskForAutoConfirm ?? DEFAULT_THRESHOLD;

  // Above the merchant's hard ceiling — always wait for human confirmation,
  // even if the level is "low" (a merchant who picks ceiling=20 wants 20).
  if (riskScore > ceiling) {
    return {
      action: "await_confirmation",
      state: "pending_confirmation",
      reason: `score ${riskScore} > merchant ceiling ${ceiling}`,
      shouldAutoBook: false,
    };
  }

  // Low risk under the ceiling: auto-confirm.
  // semi_auto stops there; full_auto also kicks off auto-book.
  if (riskLevel === "low") {
    if (mode === "full_auto" && config?.autoBookEnabled === true) {
      return {
        action: "auto_confirm_and_book",
        state: "auto_confirmed",
        reason: `low risk (score ${riskScore}) + full_auto`,
        shouldAutoBook: true,
      };
    }
    return {
      action: "auto_confirm",
      state: "auto_confirmed",
      reason: `low risk (score ${riskScore}) + ${mode}`,
      shouldAutoBook: false,
    };
  }

  // Medium risk: never auto-confirm. Always await human, regardless of mode.
  // (If the merchant wants medium auto-confirmed, they should bring their
  //  ceiling above the medium-band cutoff. Belt-and-suspenders.)
  return {
    action: "await_confirmation",
    state: "pending_confirmation",
    reason: `medium risk (score ${riskScore})`,
    shouldAutoBook: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Manual transition guards (for confirm/reject/override mutations)            */
/* -------------------------------------------------------------------------- */

/**
 * Allowed transitions for `order.automation.state`. Used to make the
 * confirm/reject mutations idempotent and prevent loops.
 *
 * Note that "auto_confirmed" and "confirmed" are terminal-ish — both
 * indicate "merchant said yes" and only differ in WHO said yes. Going
 * backwards from "confirmed" → "rejected" is allowed (operator override)
 * but only when the order has not yet shipped. The router enforces the
 * shipping check separately.
 */
const TRANSITIONS: Record<AutomationState, ReadonlyArray<AutomationState>> = {
  not_evaluated: ["auto_confirmed", "pending_confirmation", "requires_review", "confirmed", "rejected"],
  pending_confirmation: ["confirmed", "rejected", "requires_review"],
  requires_review: ["confirmed", "rejected"],
  auto_confirmed: ["rejected"],
  confirmed: ["rejected"],
  rejected: [], // terminal
};

export function canTransitionAutomation(
  from: AutomationState | undefined,
  to: AutomationState,
): boolean {
  const start = from ?? "not_evaluated";
  if (start === to) return true; // idempotent re-application
  return TRANSITIONS[start]?.includes(to) ?? false;
}

/** Convenience export for tests. */
export const __TEST = { DEFAULT_THRESHOLD, TRANSITIONS };
