/**
 * Subscription plan catalogue — framework-agnostic source of truth.
 *
 * Lives in `@ecom/types` so both the API (entitlements, billing router) and
 * the web app (public pricing page, dashboard CTAs) read the same numbers.
 * Keep this file dependency-free — no tRPC, mongoose, or zod imports.
 *
 * Prices are stored in BDT (Bangladesh) with a `usdPrice` hint for future
 * international launches.
 */

export const PLAN_TIERS = ["starter", "growth", "scale", "enterprise"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export type AnalyticsLevel = "basic" | "advanced" | "premium";

export const INTEGRATION_PROVIDER_KEYS = [
  "csv",
  "shopify",
  "woocommerce",
  "custom_api",
] as const;
export type PlanIntegrationProvider = (typeof INTEGRATION_PROVIDER_KEYS)[number];

export interface PlanFeatures {
  courierLimit: number;
  fraudReview: boolean;
  callMinutes: number;
  analyticsLevel: AnalyticsLevel;
  seats: number;
  orderQuota: number;
  shipmentQuota: number;
  fraudReviewQuota: number | null;
  integrationProviders: ReadonlyArray<PlanIntegrationProvider>;
  maxIntegrations: number;
  behaviorAnalytics: boolean;
  advancedBehaviorTables: boolean;
  behaviorRetentionDays: number | null;
  behaviorExports: boolean;
  slaFeatures: boolean;
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  tagline: string;
  priceBDT: number;
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
      // Starter now ships Shopify alongside CSV so the onboarding promise
      // ("Connect Shopify or WooCommerce in under 2 minutes") is honoured
      // by the trial. WooCommerce stays a Growth-tier upsell. maxIntegrations
      // bumped from 0 to 1 so the merchant can actually wire one connector
      // up — without that, the provider list is decorative.
      integrationProviders: ["csv", "shopify"],
      maxIntegrations: 1,
      behaviorAnalytics: false,
      advancedBehaviorTables: false,
      behaviorRetentionDays: 30,
      behaviorExports: false,
      slaFeatures: false,
    },
    highlights: [
      "300 orders / month",
      "1 courier integration",
      "Shopify or CSV sync",
      "30-day analytics window",
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
      integrationProviders: ["csv", "shopify", "woocommerce"],
      maxIntegrations: 1,
      behaviorAnalytics: true,
      advancedBehaviorTables: false,
      behaviorRetentionDays: 90,
      behaviorExports: false,
      slaFeatures: false,
    },
    highlights: [
      "1,500 orders / month",
      "Shopify + WooCommerce sync",
      "Behavior analytics (90-day window)",
      "Fraud review + COD verification",
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
      integrationProviders: ["csv", "shopify", "woocommerce", "custom_api"],
      maxIntegrations: 5,
      behaviorAnalytics: true,
      advancedBehaviorTables: true,
      behaviorRetentionDays: 180,
      behaviorExports: false,
      slaFeatures: false,
    },
    highlights: [
      "6,000 orders / month",
      "Up to 5 commerce integrations",
      "Custom-API connector",
      "High-intent + suspicious-session tables",
      "180-day analytics window",
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
      integrationProviders: ["csv", "shopify", "woocommerce", "custom_api"],
      maxIntegrations: 50,
      behaviorAnalytics: true,
      advancedBehaviorTables: true,
      behaviorRetentionDays: null,
      behaviorExports: true,
      slaFeatures: true,
    },
    highlights: [
      "50,000 orders / month",
      "Unlimited commerce integrations",
      "Behavior data exports (CSV/JSON)",
      "Custom analytics retention",
      "Priority support + SLA",
      "50 users",
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

export const USAGE_METRICS = [
  "ordersCreated",
  "shipmentsBooked",
  "fraudReviewsUsed",
  "callsInitiated",
  "callMinutesUsed",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export function quotaFor(plan: PlanDefinition, metric: UsageMetric): number | null {
  switch (metric) {
    case "ordersCreated":
      return plan.features.orderQuota;
    case "shipmentsBooked":
      return plan.features.shipmentQuota;
    case "fraudReviewsUsed":
      return plan.features.fraudReviewQuota;
    case "callsInitiated":
      return plan.features.callMinutes;
    case "callMinutesUsed":
      return plan.features.callMinutes;
  }
}
