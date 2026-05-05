import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { Integration, Notification } from "@ecom/db";
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

/**
 * Result of a plan-downgrade enforcement pass — what was kept, what was
 * disabled, and what the caller should report to the merchant.
 */
export interface EnforceCapacityResult {
  /** Total active integrations BEFORE enforcement (excl. csv). */
  activeBefore: number;
  /** Cap on the new plan tier. */
  cap: number;
  /**
   * Active integrations DISABLED (status flipped to disconnected) because
   * they exceeded the cap. Oldest wins, newest gets cut — predictable for
   * the merchant. Empty array means no enforcement was needed.
   */
  disabled: Array<{
    id: string;
    provider: string;
    accountKey?: string;
    label?: string | null;
  }>;
  /**
   * Provider-locked integrations — the merchant's old plan allowed (e.g.)
   * woocommerce but the new one doesn't. These are also disabled. Counted
   * separately so the merchant-facing copy can explain "X provider isn't
   * on your new plan" rather than "you have too many".
   */
  providerLocked: Array<{
    id: string;
    provider: string;
    accountKey?: string;
  }>;
}

/**
 * Apply the plan's integration cap and provider allowlist to a merchant.
 * Idempotent — running twice with the same target tier produces the same
 * end state. Designed to be called from `changePlan` (admin), `downgrade`
 * (self-serve), and trial-expiry workers.
 *
 * Behavior:
 *  1. Disconnect any integration whose provider isn't on the target tier
 *     (e.g. WooCommerce on a Starter plan that only allows Shopify+CSV).
 *  2. Disconnect the OLDEST active non-CSV integrations until the count
 *     fits under `maxIntegrations`. Oldest-first because the merchant is
 *     most likely to still recognise their newest connection; killing the
 *     freshest one would feel like the dashboard ate their last action.
 *  3. CSV integrations are uncapped and never disabled — they're the
 *     manual fallback that makes a degraded plan still usable.
 *
 * Disabled rows are flipped to `disconnected` (soft-delete pattern, same
 * as the manual disconnect button). Their data + dedup keys persist; the
 * merchant can reconnect after upgrading without losing webhook history.
 *
 * NOTE: webhook deregistration with the upstream platform (Shopify,
 * WooCommerce) is INTENTIONALLY skipped here — that's a network call per
 * row and we don't want a slow Shopify API to make plan downgrades hang.
 * The caller should fire-and-forget a cleanup job afterward.
 */
export async function enforceIntegrationCapacity(
  merchantId: Types.ObjectId,
  targetTier: PlanTier,
): Promise<EnforceCapacityResult> {
  const features = getPlan(targetTier).features;
  const allowedProviders = new Set<string>(features.integrationProviders);

  // Pull all active rows for this merchant. lean() is fine — we only
  // need ids and ordering metadata for the bulk update.
  const active = await Integration.find({
    merchantId,
    status: { $in: ["pending", "connected"] },
  })
    .select("_id provider accountKey label createdAt status")
    .sort({ createdAt: 1 }) // oldest first; we keep the newest under the cap.
    .lean();

  // Always-allowed CSV is excluded from both gates.
  const nonCsv = active.filter((row) => row.provider !== "csv");

  const providerLocked = nonCsv.filter(
    (row) => !allowedProviders.has(String(row.provider)),
  );
  const lockedIds = new Set(providerLocked.map((r) => String(r._id)));

  // From the survivors, pick the oldest excess to cut.
  const allowedRows = nonCsv.filter((row) => !lockedIds.has(String(row._id)));
  const cap = Math.max(0, features.maxIntegrations);
  const overflowCount = Math.max(0, allowedRows.length - cap);
  const overflow = overflowCount > 0 ? allowedRows.slice(0, overflowCount) : [];

  const toDisableIds = [
    ...providerLocked.map((r) => r._id),
    ...overflow.map((r) => r._id),
  ];

  if (toDisableIds.length > 0) {
    const now = new Date();
    await Integration.updateMany(
      { _id: { $in: toDisableIds }, merchantId },
      {
        $set: {
          status: "disconnected",
          disconnectedAt: now,
          "health.ok": false,
          "health.lastError":
            "Disconnected automatically: plan downgrade exceeded the integration cap. Reconnect after upgrading.",
          "health.lastCheckedAt": now,
          "webhookStatus.registered": false,
        },
      },
    );
  }

  return {
    activeBefore: nonCsv.length,
    cap,
    disabled: overflow.map((r) => ({
      id: String(r._id),
      provider: String(r.provider),
      accountKey: r.accountKey,
      label: r.label,
    })),
    providerLocked: providerLocked.map((r) => ({
      id: String(r._id),
      provider: String(r.provider),
      accountKey: r.accountKey,
    })),
  };
}

/**
 * Dry-run version of `enforceIntegrationCapacity` — returns the SAME
 * shape but performs zero writes. Used to power the downgrade warning
 * modal so the merchant sees exactly which connectors will be
 * disabled BEFORE they confirm. Never throws on missing plan data;
 * returns an empty preview when the merchant has no active rows.
 *
 * Idempotent and safe to call repeatedly — the page can re-fetch on
 * tier-selector changes without producing side effects.
 */
export async function previewIntegrationCapacityChange(
  merchantId: Types.ObjectId,
  targetTier: PlanTier,
): Promise<EnforceCapacityResult> {
  const features = getPlan(targetTier).features;
  const allowedProviders = new Set<string>(features.integrationProviders);
  const active = await Integration.find({
    merchantId,
    status: { $in: ["pending", "connected"] },
  })
    .select("_id provider accountKey label createdAt status")
    .sort({ createdAt: 1 })
    .lean();

  const nonCsv = active.filter((row) => row.provider !== "csv");
  const providerLocked = nonCsv.filter(
    (row) => !allowedProviders.has(String(row.provider)),
  );
  const lockedIds = new Set(providerLocked.map((r) => String(r._id)));
  const allowedRows = nonCsv.filter((row) => !lockedIds.has(String(row._id)));
  const cap = Math.max(0, features.maxIntegrations);
  const overflowCount = Math.max(0, allowedRows.length - cap);
  const overflow = overflowCount > 0 ? allowedRows.slice(0, overflowCount) : [];

  return {
    activeBefore: nonCsv.length,
    cap,
    disabled: overflow.map((r) => ({
      id: String(r._id),
      provider: String(r.provider),
      accountKey: r.accountKey,
      label: r.label,
    })),
    providerLocked: providerLocked.map((r) => ({
      id: String(r._id),
      provider: String(r.provider),
      accountKey: r.accountKey,
    })),
  };
}

/**
 * Source label of the call site that flipped the merchant's tier. Used
 * for notification metadata + log lines so an ops engineer can tell, at
 * a glance, whether a downgrade enforcement came from an admin action,
 * the Stripe portal, or a recurring invoice that landed at a lower tier.
 */
export type PlanChangeSource =
  | "admin"
  | "stripe_portal"
  | "stripe_invoice"
  | "stripe_checkout"
  | "trial_expiry";

/**
 * One-shot helper for any path that flips `merchant.subscription.tier`.
 *
 * If the tier change is a DOWNGRADE (new < prev in PLAN_TIERS order):
 *   1. Calls `enforceIntegrationCapacity()` to disconnect provider-locked
 *      and over-cap integrations under the new tier.
 *   2. Upserts a deduped `subscription.plan_downgrade_enforced`
 *      Notification listing what was disabled, so the merchant sees
 *      "Plan changed to Starter — N integrations were disabled" in their
 *      inbox without polling the integrations page.
 *
 * Otherwise: returns null (no-op).
 *
 * Failure isolation: a thrown error from `enforceIntegrationCapacity` is
 * logged and swallowed — the caller's plan write has already succeeded
 * and the merchant's billing state must remain correct even if a
 * capacity glitch leaves a couple of orphan connectors. A notification
 * write failure is similarly logged and swallowed.
 *
 * Idempotent: the dedupe key is keyed on (merchantId, newTier) so calling
 * this helper twice on the same downgrade upserts the same notification
 * row.
 */
export async function enforceDowngradeIfNeeded(args: {
  merchantId: Types.ObjectId;
  prevTier: PlanTier | null | undefined;
  newTier: PlanTier;
  source: PlanChangeSource;
}): Promise<EnforceCapacityResult | null> {
  const { merchantId, prevTier, newTier, source } = args;
  // First-time activations (trial → paid) have no prevTier; nothing to enforce.
  if (!prevTier) return null;
  // Same tier or upgrade → no-op.
  if (PLAN_TIERS.indexOf(newTier) >= PLAN_TIERS.indexOf(prevTier)) return null;

  let enforcement: EnforceCapacityResult | null = null;
  try {
    enforcement = await enforceIntegrationCapacity(merchantId, newTier);
  } catch (err) {
    console.error(
      "[enforceDowngradeIfNeeded] enforceIntegrationCapacity failed",
      {
        merchantId: String(merchantId),
        from: prevTier,
        to: newTier,
        source,
        error: (err as Error).message,
      },
    );
    return null;
  }

  const totalDisabled =
    enforcement.disabled.length + enforcement.providerLocked.length;
  if (totalDisabled === 0) return enforcement;

  const planName = getPlan(newTier).name;
  const lines: string[] = [];
  if (enforcement.providerLocked.length > 0) {
    const providers = Array.from(
      new Set(enforcement.providerLocked.map((r) => r.provider)),
    ).join(", ");
    lines.push(
      `${enforcement.providerLocked.length} ${providers} connector${
        enforcement.providerLocked.length === 1 ? "" : "s"
      } disabled — your new plan doesn't include ${providers}.`,
    );
  }
  if (enforcement.disabled.length > 0) {
    lines.push(
      `${enforcement.disabled.length} integration${
        enforcement.disabled.length === 1 ? "" : "s"
      } disabled — your new plan caps integrations at ${enforcement.cap}.`,
    );
  }

  try {
    await Notification.updateOne(
      {
        merchantId,
        dedupeKey: `plan-downgrade-enforcement:${String(merchantId)}:${newTier}`,
      },
      {
        $setOnInsert: {
          merchantId,
          kind: "subscription.plan_downgrade_enforced",
          severity: "warning",
          title: `Plan changed to ${planName} — some integrations were disabled`,
          body: lines.join(" "),
          link: "/dashboard/integrations",
          subjectType: "merchant" as const,
          subjectId: merchantId,
          meta: {
            from: prevTier,
            to: newTier,
            cap: enforcement.cap,
            disabled: enforcement.disabled,
            providerLocked: enforcement.providerLocked,
            source,
          },
          dedupeKey: `plan-downgrade-enforcement:${String(merchantId)}:${newTier}`,
        },
      },
      { upsert: true },
    );
  } catch (notifyErr) {
    console.error(
      "[enforceDowngradeIfNeeded] notification write failed",
      {
        merchantId: String(merchantId),
        error: (notifyErr as Error).message,
      },
    );
  }
  return enforcement;
}
