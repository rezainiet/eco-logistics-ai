import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { Integration } from "@ecom/db";
import {
  getPlan,
  PLAN_TIERS,
  type PlanIntegrationProvider,
  type PlanTier,
} from "./plans.js";

/**
 * Day-7 plan-gate enforcement. One module so every router asks the same
 * question and every error message is shaped the same way for the UI's
 * upgrade-CTA hook.
 *
 * Errors are TRPCErrors with `code: "FORBIDDEN"` and a `message` of the form
 * `entitlement_blocked:<code>`. The web client splits on `:` to drive the
 * upgrade dialog without per-message string matching.
 */

export type EntitlementCode =
  | "integration_provider_locked"
  | "integration_count_capped"
  | "behavior_analytics_locked"
  | "advanced_behavior_tables_locked"
  | "behavior_exports_locked"
  | "retention_window_capped";

export interface EntitlementsView {
  tier: PlanTier;
  integrationProviders: ReadonlyArray<PlanIntegrationProvider>;
  maxIntegrations: number;
  behaviorAnalytics: boolean;
  advancedBehaviorTables: boolean;
  behaviorRetentionDays: number | null;
  behaviorExports: boolean;
  slaFeatures: boolean;
  recommendedUpgradeTier: PlanTier | null;
}

const TIER_RANK: Record<PlanTier, number> = {
  starter: 0,
  growth: 1,
  scale: 2,
  enterprise: 3,
};

function nextTierAbove(tier: PlanTier): PlanTier | null {
  const idx = TIER_RANK[tier] + 1;
  return PLAN_TIERS[idx] ?? null;
}

export function entitlementsFor(tier: PlanTier): EntitlementsView {
  const features = getPlan(tier).features;
  return {
    tier,
    integrationProviders: features.integrationProviders,
    maxIntegrations: features.maxIntegrations,
    behaviorAnalytics: features.behaviorAnalytics,
    advancedBehaviorTables: features.advancedBehaviorTables,
    behaviorRetentionDays: features.behaviorRetentionDays,
    behaviorExports: features.behaviorExports,
    slaFeatures: features.slaFeatures,
    recommendedUpgradeTier: nextTierAbove(tier),
  };
}

function blocked(code: EntitlementCode, detail?: string): TRPCError {
  return new TRPCError({
    code: "FORBIDDEN",
    message: `entitlement_blocked:${code}${detail ? `:${detail}` : ""}`,
  });
}

/**
 * Throw if `provider` isn't on the merchant's plan. CSV is universally
 * available so a starter merchant can still bulk-upload.
 */
export function assertIntegrationProvider(
  tier: PlanTier,
  provider: PlanIntegrationProvider,
): void {
  const features = getPlan(tier).features;
  if (!features.integrationProviders.includes(provider)) {
    throw blocked("integration_provider_locked", provider);
  }
}

/**
 * Throw if the merchant already holds the maximum allowed connector count
 * for their tier. Disconnected rows don't count toward the cap; CSV doesn't
 * either (it's a manual fallback, not a live connector).
 */
export async function assertIntegrationCapacity(
  merchantId: Types.ObjectId,
  tier: PlanTier,
  provider: PlanIntegrationProvider,
): Promise<void> {
  if (provider === "csv") return; // CSV connector is uncapped.
  const features = getPlan(tier).features;
  if (features.maxIntegrations <= 0) {
    throw blocked("integration_count_capped", String(features.maxIntegrations));
  }
  const active = await Integration.countDocuments({
    merchantId,
    status: { $in: ["pending", "connected"] },
    provider: { $ne: "csv" },
  });
  if (active >= features.maxIntegrations) {
    throw blocked(
      "integration_count_capped",
      `${active}/${features.maxIntegrations}`,
    );
  }
}

export function assertBehaviorAnalytics(tier: PlanTier): void {
  if (!getPlan(tier).features.behaviorAnalytics) {
    throw blocked("behavior_analytics_locked");
  }
}

export function assertAdvancedBehaviorTables(tier: PlanTier): void {
  if (!getPlan(tier).features.advancedBehaviorTables) {
    throw blocked("advanced_behavior_tables_locked");
  }
}

export function assertBehaviorExports(tier: PlanTier): void {
  if (!getPlan(tier).features.behaviorExports) {
    throw blocked("behavior_exports_locked");
  }
}

/**
 * Clamp the requested behavior-analytics window down to the plan's retention
 * cap. Returns the effective window in days. We never throw here — narrowing
 * silently is the right UX (the UI also surfaces the cap so merchants
 * understand why a longer range produces the same numbers).
 */
export function clampBehaviorRetentionDays(
  tier: PlanTier,
  requestedDays: number,
): number {
  const cap = getPlan(tier).features.behaviorRetentionDays;
  if (cap === null) return Math.max(1, Math.floor(requestedDays));
  return Math.min(cap, Math.max(1, Math.floor(requestedDays)));
}
