import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Integration, Notification } from "@ecom/db";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { enforceDowngradeIfNeeded } from "../src/lib/entitlements.js";
import { encryptSecret } from "../src/lib/crypto.js";

/**
 * Plan-downgrade enforcement test.
 *
 * `enforceDowngradeIfNeeded` is the shared helper called from every path
 * that flips `merchant.subscription.tier` — admin changePlan, the Stripe
 * portal handler, the recurring-invoice handler, the checkout handler.
 *
 * Coverage:
 *   - upgrade / same-tier / no-prevTier paths are no-ops
 *   - downgrade with provider-locked rows disconnects them
 *   - downgrade with over-cap rows disconnects oldest first
 *   - merchant notification fires once (deduped)
 *   - plan-write side effects are not undone
 *
 * Notice that we do NOT exercise the Stripe webhook entry point here —
 * the helper is what we depend on, and the stripe.ts call sites just
 * pass `prevTier` + `newTier` through. See `stripeWebhookHttp.test.ts`
 * for the wire-level path; this file pins the contract that file relies
 * on.
 */

async function seedIntegration(
  merchantId: Types.ObjectId,
  provider: "shopify" | "woocommerce" | "custom_api",
  accountKey: string,
  createdAt: Date,
) {
  return Integration.create({
    merchantId,
    provider,
    status: "connected",
    accountKey,
    label: `${provider} ${accountKey}`,
    credentials: {
      siteUrl:
        provider === "woocommerce"
          ? "https://shop.example.com"
          : provider === "shopify"
            ? "myshop.myshopify.com"
            : undefined,
      apiKey: encryptSecret("dummy"),
    },
    counts: { ordersImported: 0, ordersFailed: 0 },
    createdAt,
  });
}

describe("enforceDowngradeIfNeeded", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("no-op when prevTier is null/undefined (first activation)", async () => {
    const m = await createMerchant({ tier: "starter" });
    const r = await enforceDowngradeIfNeeded({
      merchantId: m._id as Types.ObjectId,
      prevTier: null,
      newTier: "starter",
      source: "stripe_checkout",
    });
    expect(r).toBeNull();
    expect(await Notification.countDocuments({ merchantId: m._id })).toBe(0);
  });

  it("no-op for an upgrade", async () => {
    const m = await createMerchant({ tier: "growth" });
    const r = await enforceDowngradeIfNeeded({
      merchantId: m._id as Types.ObjectId,
      prevTier: "growth",
      newTier: "scale",
      source: "stripe_portal",
    });
    expect(r).toBeNull();
  });

  it("no-op for same-tier writes (idempotent renewal)", async () => {
    const m = await createMerchant({ tier: "scale" });
    const r = await enforceDowngradeIfNeeded({
      merchantId: m._id as Types.ObjectId,
      prevTier: "scale",
      newTier: "scale",
      source: "stripe_invoice",
    });
    expect(r).toBeNull();
  });

  it("Scale → Starter: provider-locked WooCommerce + custom_api are disconnected", async () => {
    const m = await createMerchant({ tier: "scale" });
    const merchantId = m._id as Types.ObjectId;
    // Scale allows: csv, shopify, woocommerce, custom_api.
    // Starter allows: csv, shopify only. So Woo + custom_api must die.
    const t0 = new Date(Date.now() - 30 * 60_000);
    const woo = await seedIntegration(merchantId, "woocommerce", "shop.example.com", t0);
    const custom = await seedIntegration(merchantId, "custom_api", "custom-1", new Date(t0.getTime() + 1));
    const shopify = await seedIntegration(merchantId, "shopify", "myshop.myshopify.com", new Date(t0.getTime() + 2));

    const r = await enforceDowngradeIfNeeded({
      merchantId,
      prevTier: "scale",
      newTier: "starter",
      source: "stripe_portal",
    });

    expect(r).not.toBeNull();
    const lockedProviders = r!.providerLocked.map((p) => p.provider).sort();
    expect(lockedProviders).toEqual(["custom_api", "woocommerce"]);

    // Provider-locked rows are now disconnected with the canonical
    // sentinel `health.lastError` so the UI shows a clear reason.
    const wooAfter = await Integration.findById(woo._id).lean();
    expect(wooAfter?.status).toBe("disconnected");
    expect(wooAfter?.health?.lastError ?? "").toMatch(
      /Disconnected automatically: plan downgrade/i,
    );
    const customAfter = await Integration.findById(custom._id).lean();
    expect(customAfter?.status).toBe("disconnected");

    // Shopify is allowed on Starter — it stays connected.
    const shopifyAfter = await Integration.findById(shopify._id).lean();
    expect(shopifyAfter?.status).toBe("connected");

    // One notification per (merchantId, newTier) — keyed dedupe.
    const notes = await Notification.find({
      merchantId,
      kind: "subscription.plan_downgrade_enforced",
    }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toMatch(/Plan changed to Starter/i);
    expect(notes[0]!.body).toMatch(/connector/i);
    expect(notes[0]!.dedupeKey).toBe(
      `plan-downgrade-enforcement:${String(merchantId)}:starter`,
    );
  });

  it("Growth → Starter: oldest of two Shopify rows is cut for cap-overflow", async () => {
    // Growth caps at 1 commerce integration; Starter also caps at 1.
    // Seed 2 Shopify rows on Growth (which is already over the cap —
    // legacy data); downgrade to Starter and assert oldest is cut.
    const m = await createMerchant({ tier: "growth" });
    const merchantId = m._id as Types.ObjectId;
    const tOld = new Date(Date.now() - 60 * 60_000);
    const tNew = new Date(Date.now() - 5 * 60_000);
    const oldRow = await seedIntegration(merchantId, "shopify", "old.myshopify.com", tOld);
    const newRow = await seedIntegration(merchantId, "shopify", "new.myshopify.com", tNew);

    const r = await enforceDowngradeIfNeeded({
      merchantId,
      prevTier: "growth",
      newTier: "starter",
      source: "admin",
    });

    expect(r).not.toBeNull();
    expect(r!.cap).toBe(1);
    expect(r!.disabled.map((d) => d.id)).toEqual([String(oldRow._id)]);

    const oldAfter = await Integration.findById(oldRow._id).lean();
    expect(oldAfter?.status).toBe("disconnected");
    const newAfter = await Integration.findById(newRow._id).lean();
    expect(newAfter?.status).toBe("connected");
  });

  it("downgrade with NO active integrations: enforcement runs, returns empty, no notification", async () => {
    const m = await createMerchant({ tier: "scale" });
    const r = await enforceDowngradeIfNeeded({
      merchantId: m._id as Types.ObjectId,
      prevTier: "scale",
      newTier: "starter",
      source: "stripe_portal",
    });
    expect(r).not.toBeNull();
    expect(r!.disabled).toEqual([]);
    expect(r!.providerLocked).toEqual([]);
    expect(
      await Notification.countDocuments({
        merchantId: m._id,
        kind: "subscription.plan_downgrade_enforced",
      }),
    ).toBe(0);
  });

  it("repeated calls with the same (merchantId, newTier) upsert ONE notification (dedupe)", async () => {
    const m = await createMerchant({ tier: "scale" });
    const merchantId = m._id as Types.ObjectId;
    await seedIntegration(merchantId, "woocommerce", "shop.example.com", new Date());

    await enforceDowngradeIfNeeded({
      merchantId,
      prevTier: "scale",
      newTier: "starter",
      source: "stripe_portal",
    });
    // Second call (e.g. retry of the same Stripe webhook) must not
    // produce a second notification.
    await enforceDowngradeIfNeeded({
      merchantId,
      prevTier: "scale",
      newTier: "starter",
      source: "stripe_portal",
    });

    expect(
      await Notification.countDocuments({
        merchantId,
        kind: "subscription.plan_downgrade_enforced",
      }),
    ).toBe(1);
  });
});
