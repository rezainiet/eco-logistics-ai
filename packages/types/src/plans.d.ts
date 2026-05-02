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
export declare const PLAN_TIERS: readonly ["starter", "growth", "scale", "enterprise"];
export type PlanTier = (typeof PLAN_TIERS)[number];
export type AnalyticsLevel = "basic" | "advanced" | "premium";
export declare const INTEGRATION_PROVIDER_KEYS: readonly ["csv", "shopify", "woocommerce", "custom_api"];
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
export declare const PLANS: Record<PlanTier, PlanDefinition>;
export declare function getPlan(tier: PlanTier | string | undefined | null): PlanDefinition;
export declare function listPlans(): PlanDefinition[];
export declare function isPlanTier(x: unknown): x is PlanTier;
export declare const USAGE_METRICS: readonly ["ordersCreated", "shipmentsBooked", "fraudReviewsUsed", "callsInitiated", "callMinutesUsed"];
export type UsageMetric = (typeof USAGE_METRICS)[number];
export declare function quotaFor(plan: PlanDefinition, metric: UsageMetric): number | null;
//# sourceMappingURL=plans.d.ts.map