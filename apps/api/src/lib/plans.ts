/**
 * Subscription plan catalogue — re-exported from `@ecom/types` so the API,
 * the entitlements module, and the public pricing page on the web all read
 * the same source of truth without crossing the api/web package boundary.
 *
 * Pricing edits happen in `packages/types/src/plans.ts`.
 */

export {
  PLANS,
  PLAN_TIERS,
  INTEGRATION_PROVIDER_KEYS,
  USAGE_METRICS,
  getPlan,
  listPlans,
  isPlanTier,
  quotaFor,
} from "@ecom/types";

export type {
  AnalyticsLevel,
  PlanDefinition,
  PlanFeatures,
  PlanIntegrationProvider,
  PlanTier,
  UsageMetric,
} from "@ecom/types";
