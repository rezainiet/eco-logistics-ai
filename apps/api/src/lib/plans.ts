/**
 * Day 6 — Subscription plan catalogue.
 *
 * Single source of truth for pricing, quotas, and feature gates. Keep this
 * file framework-agnostic (no tRPC / mongoose imports) so it's safe to import
 * from both the API server and, eventually, a public pricing page.
 *
 * Prices are stored in BDT (Bangladesh). We keep a `usdPrice` hint so the
 * international launches later can render the same catalogue without a new
 * migration.
 */

export const PLAN_TIERS = ["starter", "growth", "scale", "enterprise"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export type AnalyticsLevel = "basic" | "advanced" | "premium";

export interface PlanFeatures {
  /** Number of active couriers allowed simultaneously. */
  courierLimit: number;
  /** Can the merchant use the fraud review queue / risk-gated bookings? */
  fraudReview: boolean;
  /** Monthly quota for outbound call-center minutes (Twilio). */
  callMinutes: number;
  /** Dashboard analytics surface the merchant sees. */
  analyticsLevel: AnalyticsLevel;
  /** Soft-quota for users/seats (signups with role=agent). */
  seats: number;
  /** Soft-cap for orders created per month. */
  orderQuota: number;
  /** Soft-cap for shipments booked per month. */
  shipmentQuota: number;
  /** Soft-cap for fraud reviews per month (null = unlimited). */
  fraudReviewQuota: number | null;
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  tagline: string;
  /** Monthly price in BDT. */
  priceBDT: number;
  /** Equivalent USD price (informational, not used for billing yet). */
  priceUSD: number;
  features: PlanFeatures;
  highlights: string[];
}

export const PLANS: Record<PlanTier, PlanDefinition> = {
  starter: {
    tier: "starter",
    name: "Starter",
    tagline: "Perfect for new merchants validating their COD funnel.",
    priceBDT: 999,
    priceUSD: 9,
    features: {
      courierLimit: 1,
      fraudReview: false,
      callMinutes: 60,
      analyticsLevel: "basic",
      seats: 1,
      orderQuota: 300,
      shipmentQuota: 300,
      fraudReviewQuota: 0,
    },
    highlights: [
      "300 orders / month",
      "1 courier integration",
      "Basic analytics",
      "60 call-center minutes",
      "1 user",
    ],
  },
  growth: {
    tier: "growth",
    name: "Growth",
    tagline: "For stores ready to fight RTO and scale cleanly.",
    priceBDT: 2499,
    priceUSD: 25,
    features: {
      courierLimit: 3,
      fraudReview: true,
      callMinutes: 300,
      analyticsLevel: "advanced",
      seats: 3,
      orderQuota: 1500,
      shipmentQuota: 1500,
      fraudReviewQuota: 500,
    },
    highlights: [
      "1,500 orders / month",
      "3 courier integrations",
      "Fraud review + COD verification",
      "Advanced analytics",
      "300 call-center minutes",
      "3 users",
    ],
  },
  scale: {
    tier: "scale",
    name: "Scale",
    tagline: "High-volume operations with a full call-center workflow.",
    priceBDT: 5999,
    priceUSD: 59,
    features: {
      courierLimit: 6,
      fraudReview: true,
      callMinutes: 1500,
      analyticsLevel: "premium",
      seats: 10,
      orderQuota: 6000,
      shipmentQuota: 6000,
      fraudReviewQuota: 2500,
    },
    highlights: [
      "6,000 orders / month",
      "6 courier integrations",
      "Full fraud review queue",
      "Premium analytics + exports",
      "1,500 call-center minutes",
      "10 users",
    ],
  },
  enterprise: {
    tier: "enterprise",
    name: "Enterprise",
    tagline: "Custom-scaled infrastructure with priority support.",
    priceBDT: 14999,
    priceUSD: 149,
    features: {
      courierLimit: 20,
      fraudReview: true,
      callMinutes: 10_000,
      analyticsLevel: "premium",
      seats: 50,
      orderQuota: 50_000,
      shipmentQuota: 50_000,
      fraudReviewQuota: null,
    },
    highlights: [
      "50,000 orders / month",
      "Unlimited courier integrations",
      "Unlimited fraud reviews",
      "Premium analytics + API exports",
      "10,000 call-center minutes",
      "50 users",
      "Priority support + SLA",
    ],
  },
};

export function getPlan(tier: PlanTier | string | undefined | null): PlanDefinition {
  const key = (tier ?? "starter") as PlanTier;
  return PLANS[key] ?? PLANS.starter;
}

export function listPlans(): PlanDefinition[] {
  return PLAN_TIERS.map((t) => PLANS[t]);
}

export function isPlanTier(x: unknown): x is PlanTier {
  return typeof x === "string" && (PLAN_TIERS as readonly string[]).includes(x);
}

/**
 * Quota keys that the usage meter tracks and the billing page renders as
 * progress bars. Kept in one place so adding a new meter is a single diff.
 */
export const USAGE_METRICS = [
  "ordersCreated",
  "shipmentsBooked",
  "fraudReviewsUsed",
  "callsInitiated",
  "callMinutesUsed",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export function quotaFor(
  plan: PlanDefinition,
  metric: UsageMetric,
): number | null {
  switch (metric) {
    case "ordersCreated":
      return plan.features.orderQuota;
    case "shipmentsBooked":
      return plan.features.shipmentQuota;
    case "fraudReviewsUsed":
      return plan.features.fraudReviewQuota;
    case "callsInitiated":
      return plan.features.callMinutes; // uses call-minutes as a proxy quota
    case "callMinutesUsed":
      return plan.features.callMinutes;
  }
}
