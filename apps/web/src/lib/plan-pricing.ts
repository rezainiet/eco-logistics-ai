/**
 * Presentation helpers for the subscription catalogue.
 *
 * Every customer-facing price (homepage cards, ROI calculator, JSON-LD,
 * /pricing, billing, upgrade prompts, signup) reads `PLANS` from
 * `@ecom/types/plans` — the same catalogue the API bills from — through
 * these helpers. Never write a plan price as a literal in a component;
 * `plan-pricing.test.tsx` guards the customer-facing files.
 *
 * Imports the dependency-free `plans` subpath (not the package index) so
 * the marketing bundle stays free of tRPC/router types.
 */
import { listPlans, type PlanDefinition, type PlanTier } from "@ecom/types/plans";

// Fixed locale: prices must not change digits or grouping with the
// visitor's browser locale (e.g. bn-BD would render ২,৪৯৯).
const PRICE_NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const QUANTITY = new Intl.NumberFormat("en-US");

/**
 * Customer-facing plan name by tier id, from the catalogue (e.g. `scale` →
 * "Pro"). Use this for any "You're on …" / "Upgrade to …" copy — never a
 * local tier → name map.
 */
export const PLAN_NAME: Readonly<Record<PlanTier, string>> = Object.fromEntries(
  listPlans().map((p) => [p.tier, p.name]),
) as Record<PlanTier, string>;

/** "৳2,499" — the one format for a monthly plan price in BDT. */
export function formatPlanPrice(priceBDT: number): string {
  return `৳${PRICE_NUMBER.format(priceBDT)}`;
}

/** "1,500" — plan quotas (orders / month etc.). */
export function formatPlanQuantity(n: number): string {
  return QUANTITY.format(n);
}

/**
 * The plan the ROI calculator recommends for a monthly order volume: the
 * cheapest plan whose order quota covers it (the top plan above every quota).
 * Uses the real quotas, so the recommendation is a plan that actually fits.
 */
export function planForMonthlyOrders(orders: number, plans: readonly PlanDefinition[] = listPlans()): PlanDefinition {
  const byPrice = [...plans].sort((a, b) => a.priceBDT - b.priceBDT);
  return byPrice.find((p) => orders <= p.features.orderQuota) ?? byPrice[byPrice.length - 1]!;
}

/** schema.org `Offer`s for the homepage JSON-LD, one per plan, in catalogue order. */
export function planOffers(url: string) {
  return listPlans().map((p) => ({
    "@type": "Offer" as const,
    name: p.name,
    price: String(p.priceBDT),
    priceCurrency: "BDT" as const,
    url,
  }));
}
