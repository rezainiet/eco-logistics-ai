/**
 * Onboarding-progress derivation. Pure function — converts the four-plus
 * signals the dashboard already reads into a step + percent. Used by the
 * <OnboardingChecklist /> and any banner that wants to nudge the merchant.
 *
 * No backend changes — every flag is derived from existing endpoints:
 *   - hasStoreConnected ← integrations.list().some(i => i.provider !== "csv" && i.status === "connected")
 *   - hasFirstOrder    ← orders.listOrders({limit:1}).length > 0
 *   - hasCourier       ← merchants.getCouriers().length > 0
 *   - automationOn     ← merchants.getAutomationConfig().enabled
 *   - smsTested        ← orders.listOrders({...}).some(o => o.bookedByAutomation || ...)
 *
 * Step ordering matches what real merchants actually want to do first:
 * connect their store, watch orders flow in, then wire couriers and
 * automation on top.
 */

export type OnboardingStepKey =
  | "connect_store"
  | "import_orders"
  | "add_courier"
  | "enable_automation"
  | "test_sms";

export interface OnboardingState {
  hasStoreConnected: boolean;
  hasFirstOrder: boolean;
  hasCourier: boolean;
  automationOn: boolean;
  smsTested: boolean;
}

export interface OnboardingStep {
  key: OnboardingStepKey;
  title: string;
  description: string;
  done: boolean;
  ctaLabel: string;
  ctaHref: string;
}

export interface OnboardingProgress {
  steps: OnboardingStep[];
  doneCount: number;
  totalCount: number;
  percent: number;
  /** First step that is still pending — UI uses this as the "current focus". */
  nextStep: OnboardingStep | null;
  /** True when every step is done — UI hides the checklist + shows a "you're set" badge. */
  complete: boolean;
}

export function deriveOnboardingProgress(state: OnboardingState): OnboardingProgress {
  const steps: OnboardingStep[] = [
    {
      key: "connect_store",
      title: "Connect your store",
      description:
        "Connect Shopify or WooCommerce. New orders will flow in automatically — no copy-paste needed.",
      done: state.hasStoreConnected,
      ctaLabel: "Connect store",
      ctaHref: "/dashboard/settings/integrations",
    },
    {
      key: "import_orders",
      title: "Import your orders",
      // When the store is connected but no orders are in yet, the
      // merchant is almost always inside the on-connect backfill window
      // (a one-shot import runs automatically after Shopify connects).
      // The old copy ("Pull your last 25 orders") read as "nothing
      // happened, you must do this" — the single biggest "this is
      // broken" moment in onboarding. Reassure instead: it's running,
      // it takes a minute, refresh. CTA only as a manual fallback.
      description:
        state.hasStoreConnected && !state.hasFirstOrder
          ? "Connected — we're pulling your recent orders now. This usually takes a minute or two; refresh the dashboard and they'll appear. You don't need to do anything."
          : "Pull your last 25 orders so you can see the dashboard with real data. Future orders sync automatically.",
      done: state.hasFirstOrder,
      ctaLabel: state.hasStoreConnected ? "Check import status" : "Add an order",
      // When a store is connected we deep-link to integrations so the
      // merchant lands on the row that has the "Import recent" button. If
      // they're still on CSV / manual, send them to the orders page.
      ctaHref: state.hasStoreConnected
        ? "/dashboard/settings/integrations"
        : "/dashboard/orders?new=1",
    },
    {
      key: "add_courier",
      title: "Connect your courier",
      description:
        "Add Steadfast, Pathao, RedX, or another supported BD courier. We will use these to book pickups for you.",
      done: state.hasCourier,
      ctaLabel: "Add courier",
      ctaHref: "/dashboard/settings/couriers",
    },
    {
      key: "enable_automation",
      title: "Turn automation on",
      description:
        "Pick a mode (manual / semi-auto / full auto). Low-risk orders auto-confirm; high-risk orders go to your review queue.",
      done: state.automationOn,
      ctaLabel: "Enable automation",
      ctaHref: "/dashboard/settings/automation",
    },
    {
      key: "test_sms",
      title: "Send a test confirmation SMS",
      description:
        "Confirm at least one order with a customer reply (or the dashboard's test button). Closes the loop end-to-end.",
      done: state.smsTested,
      ctaLabel: "Send test SMS",
      ctaHref: "/dashboard/getting-started",
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const totalCount = steps.length;
  const nextStep = steps.find((s) => !s.done) ?? null;
  return {
    steps,
    doneCount,
    totalCount,
    percent: Math.round((doneCount / totalCount) * 100),
    nextStep,
    complete: doneCount === totalCount,
  };
}
