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
export const PLAN_TIERS = ["starter", "growth", "scale", "enterprise"];
export const INTEGRATION_PROVIDER_KEYS = [
    "csv",
    "shopify",
    "woocommerce",
    "custom_api",
];
export const PLANS = {
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
            integrationProviders: ["csv"],
            maxIntegrations: 0,
            behaviorAnalytics: false,
            advancedBehaviorTables: false,
            behaviorRetentionDays: 30,
            behaviorExports: false,
            slaFeatures: false,
        },
        highlights: [
            "300 orders / month",
            "1 courier integration",
            "CSV upload only",
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
export function getPlan(tier) {
    const key = (tier ?? "starter");
    return PLANS[key] ?? PLANS.starter;
}
export function listPlans() {
    return PLAN_TIERS.map((t) => PLANS[t]);
}
export function isPlanTier(x) {
    return typeof x === "string" && PLAN_TIERS.includes(x);
}
export const USAGE_METRICS = [
    "ordersCreated",
    "shipmentsBooked",
    "fraudReviewsUsed",
    "callsInitiated",
    "callMinutesUsed",
];
export function quotaFor(plan, metric) {
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
//# sourceMappingURL=plans.js.map