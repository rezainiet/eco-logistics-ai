import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Merchant, Order } from "@ecom/db";
import { PLAN_TIERS, getPlan } from "../src/lib/plans.js";
import {
  assertFullAutomation,
  assertIntegrationProvider,
  entitledAutomationConfig,
  entitlementsFor,
  fullAutomationTier,
} from "../src/lib/entitlements.js";
import { decideAutomationAction } from "../src/lib/automation.js";
import { enqueueAutoBook } from "../src/workers/automationBook.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

// Observe the auto-book paths without a queue.
vi.mock("../src/workers/automationBook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workers/automationBook.js")>()),
  enqueueAutoBook: vi.fn(async () => {}),
}));

/**
 * Pricing ↔ entitlement alignment: what the plans sell is what the API
 * enforces. Full-auto order automation (auto-confirm + auto-book) is a
 * Growth-and-up feature; manual and semi-auto are on every plan.
 */

beforeAll(ensureDb);
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  vi.mocked(enqueueAutoBook).mockClear();
});

const rank = (t: (typeof PLAN_TIERS)[number]) => PLAN_TIERS.indexOf(t);

describe("canonical plans are internally consistent", () => {
  it("limits never shrink and features are never lost as the tier rises", () => {
    for (const [i, tier] of PLAN_TIERS.entries()) {
      if (i === 0) continue;
      const lo = getPlan(PLAN_TIERS[i - 1]).features;
      const hi = getPlan(tier).features;
      for (const k of ["orderQuota", "shipmentQuota", "courierLimit", "callMinutes", "maxIntegrations"] as const) {
        expect(hi[k], `${tier}.${k}`).toBeGreaterThanOrEqual(lo[k]);
      }
      for (const p of lo.integrationProviders) expect(hi.integrationProviders, tier).toContain(p);
      for (const k of ["fraudReview", "behaviorAnalytics", "advancedBehaviorTables", "behaviorExports", "slaFeatures", "fullAutomation"] as const) {
        if (lo[k]) expect(hi[k], `${tier}.${k}`).toBe(true);
      }
    }
  });

  it("CSV is on every plan; WooCommerce is Growth and up — Starter does not get it", () => {
    for (const tier of PLAN_TIERS) expect(getPlan(tier).features.integrationProviders).toContain("csv");
    expect(getPlan("starter").features.integrationProviders).toEqual(["csv", "shopify"]);
    expect(() => assertIntegrationProvider("starter", "woocommerce")).toThrow("entitlement_blocked:integration_provider_locked:woocommerce");
    expect(() => assertIntegrationProvider("growth", "woocommerce")).not.toThrow();
  });

  it("full-auto automation: Starter no, Growth and up yes — the plan the homepage names", () => {
    expect(Object.fromEntries(PLAN_TIERS.map((t) => [t, getPlan(t).features.fullAutomation]))).toEqual({
      starter: false,
      growth: true,
      scale: true,
      enterprise: true,
    });
    expect(fullAutomationTier()).toBe("growth");
    expect(entitlementsFor("starter").fullAutomation).toBe(false);
    expect(entitlementsFor("growth").fullAutomation).toBe(true);
  });

  it("plan highlights promise nothing the product can't deliver (no seats, no 'unlimited' integrations)", () => {
    for (const tier of PLAN_TIERS) {
      const text = getPlan(tier).highlights.join(" | ");
      expect(text, tier).not.toMatch(/\b\d+\s+(users?|seats?)\b/i);
      expect(text, tier).not.toMatch(/multi-?store|multiple stores/i);
      expect(text, tier).not.toMatch(/unlimited commerce integrations/i);
      if (!getPlan(tier).features.integrationProviders.includes("woocommerce")) expect(text, tier).not.toMatch(/woo/i);
      if (rank(tier) > 0 && getPlan(tier).features.maxIntegrations === 1) expect(text, tier).not.toMatch(/Shopify \+ WooCommerce/);
    }
  });
});

describe("full-auto entitlement — pure rules", () => {
  const stored = { enabled: true, mode: "full_auto" as const, maxRiskForAutoConfirm: 39, autoBookEnabled: true };

  it("assertFullAutomation denies full_auto and auto-book on Starter, allows manual / semi-auto", () => {
    expect(() => assertFullAutomation("starter", { mode: "full_auto" })).toThrow("entitlement_blocked:full_automation_locked");
    expect(() => assertFullAutomation("starter", { autoBookEnabled: true })).toThrow("entitlement_blocked:full_automation_locked");
    expect(() => assertFullAutomation("starter", { mode: "semi_auto", autoBookEnabled: false })).not.toThrow();
    expect(() => assertFullAutomation("starter", { mode: "manual" })).not.toThrow();
    for (const tier of ["growth", "scale", "enterprise"] as const) {
      expect(() => assertFullAutomation(tier, { mode: "full_auto", autoBookEnabled: true })).not.toThrow();
    }
  });

  it("a stored full_auto config runs as semi-auto without auto-book on Starter; unchanged on Growth", () => {
    const starter = entitledAutomationConfig("starter", stored);
    expect(starter).toEqual({ ...stored, mode: "semi_auto", autoBookEnabled: false });
    const d = decideAutomationAction("low", 10, starter);
    expect([d.action, d.shouldAutoBook]).toEqual(["auto_confirm", false]);

    expect(entitledAutomationConfig("growth", stored)).toBe(stored);
    const g = decideAutomationAction("low", 10, entitledAutomationConfig("growth", stored));
    expect([g.action, g.shouldAutoBook]).toEqual(["auto_confirm_and_book", true]);
    // An unknown / missing tier is treated as Starter, never as a paid plan.
    expect(entitledAutomationConfig(undefined, stored).autoBookEnabled).toBe(false);
  });
});

describe("full-auto entitlement — enforced by the API", () => {
  async function merchantOn(tier: "starter" | "growth", status: "trial" | "active" = "active") {
    const m = await createMerchant({ tier, status, trialEndsAt: new Date(Date.now() + 7 * 864e5) });
    return { m, caller: callerFor(authUserFor(m)) };
  }

  it("Starter (and a Starter trial) cannot save full_auto or auto-book — denied server-side", async () => {
    for (const status of ["active", "trial"] as const) {
      const { m, caller } = await merchantOn("starter", status);
      await expect(caller.merchants.updateAutomationConfig({ enabled: true, mode: "full_auto" })).rejects.toThrow(
        "entitlement_blocked:full_automation_locked",
      );
      await expect(caller.merchants.updateAutomationConfig({ autoBookEnabled: true })).rejects.toThrow(
        "entitlement_blocked:full_automation_locked",
      );
      const saved = await Merchant.findById(m._id).select("automationConfig").lean();
      expect(saved?.automationConfig?.mode ?? "manual").not.toBe("full_auto");
    }
  });

  it("Starter keeps manual and semi-auto", async () => {
    const { caller } = await merchantOn("starter");
    await caller.merchants.updateAutomationConfig({ enabled: true, mode: "semi_auto", maxRiskForAutoConfirm: 30 });
    const cfg = await caller.merchants.getAutomationConfig();
    expect(cfg).toMatchObject({ enabled: true, mode: "semi_auto", maxRiskForAutoConfirm: 30, fullAutomation: false, fullAutomationTier: "growth" });
    await caller.merchants.updateAutomationConfig({ mode: "manual" });
    expect((await caller.merchants.getAutomationConfig()).mode).toBe("manual");
  });

  it("Growth can save full_auto", async () => {
    const { caller } = await merchantOn("growth");
    await caller.merchants.updateAutomationConfig({ enabled: true, mode: "full_auto" });
    expect(await caller.merchants.getAutomationConfig()).toMatchObject({ mode: "full_auto", fullAutomation: true });
  });

  /** A stored full-auto + auto-book config (e.g. saved before a downgrade), with an enabled courier. */
  async function withStoredFullAuto(tier: "starter" | "growth") {
    const ctx = await merchantOn(tier);
    await Merchant.collection.updateOne(
      { _id: ctx.m._id },
      {
        $set: {
          automationConfig: { enabled: true, mode: "full_auto", maxRiskForAutoConfirm: 100, autoBookEnabled: true, autoBookCourier: "steadfast" },
          couriers: [{ name: "steadfast", enabled: true }],
        },
      },
    );
    return ctx;
  }
  let phoneSeq = 20;
  async function pendingOrder(caller: ReturnType<typeof callerFor>) {
    const o = await caller.orders.createOrder({
      customer: { name: "Rahim", phone: `+88017123457${String(++phoneSeq).padStart(2, "0")}`, address: "House 5, Road 3", district: "Dhaka" },
      items: [{ name: "Shirt", quantity: 1, price: 1000 }],
      cod: 1000,
    });
    await Order.updateOne({ _id: o.id }, { $set: { "automation.state": "pending_confirmation", "order.status": "pending" } });
    return o;
  }

  it("a stored full-auto config never auto-books on Starter — at order creation or after a confirm", async () => {
    const { caller } = await withStoredFullAuto("starter");
    const o = await pendingOrder(caller);
    await caller.orders.confirmOrder({ id: o.id });
    expect(enqueueAutoBook).not.toHaveBeenCalled();
    const doc = await Order.findById(o.id).select("automation").lean();
    expect(doc?.automation?.reason ?? "").not.toContain("full_auto");
  });

  it("Growth with the same config still auto-books after a confirm (behaviour unchanged)", async () => {
    const { caller } = await withStoredFullAuto("growth");
    const o = await pendingOrder(caller);
    vi.mocked(enqueueAutoBook).mockClear();
    await caller.orders.confirmOrder({ id: o.id });
    expect(enqueueAutoBook).toHaveBeenCalledWith(expect.objectContaining({ orderId: o.id, courier: "steadfast" }));
  });
});
