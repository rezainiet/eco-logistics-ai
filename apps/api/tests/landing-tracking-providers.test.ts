import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FinanceEntry, InventoryMovement, Order, Product } from "@ecom/db";
import { __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";
import { analyticsConfigOf } from "@ecom/landing";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { authUserFor, callerFor, createMerchant } from "./helpers.js";
import { shop } from "./landing-shop-fixture.js";

/** Per-landing-page Google (GA4 / Ads) and TikTok tracking settings. Public IDs only, per page, per merchant. */

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), FinanceEntry.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
});

describe("per-page Google / TikTok tracking settings", () => {
  it("validates IDs, stores only public identifiers, and serves only enabled providers", async () => {
    const { caller, page, host } = await shop();
    await expect(caller.landingPages.setTracking({ id: page.id, metaPixelId: null, enabled: false, google: { ga4MeasurementId: "UA-123", googleAdsId: null, googleAdsPurchaseLabel: null, enabled: true } })).rejects.toThrow(/GA4/);
    await expect(caller.landingPages.setTracking({ id: page.id, metaPixelId: null, enabled: false, google: { ga4MeasurementId: null, googleAdsId: null, googleAdsPurchaseLabel: "AbCdEf12", enabled: false } })).rejects.toThrow(/Google Ads tag/);
    await expect(caller.landingPages.setTracking({ id: page.id, metaPixelId: null, enabled: false, google: { ga4MeasurementId: null, googleAdsId: null, googleAdsPurchaseLabel: null, enabled: true } })).rejects.toThrow(/before turning Google on/);
    await expect(caller.landingPages.setTracking({ id: page.id, metaPixelId: null, enabled: false, tiktok: { pixelId: "<script>", enabled: true } })).rejects.toThrow(/TikTok/);

    const s = await caller.landingPages.setTracking({
      id: page.id,
      metaPixelId: "123456789012345",
      enabled: true,
      google: { ga4MeasurementId: " g-abc123xyz9 ", googleAdsId: "AW-123456789", googleAdsPurchaseLabel: "AbC-D_efG-h12", enabled: true },
      tiktok: { pixelId: "c4abcdef1234567890gh", enabled: true },
    });
    expect(s.google).toMatchObject({ ga4MeasurementId: "G-ABC123XYZ9", googleAdsId: "AW-123456789", enabled: true });
    expect(s.tiktok).toEqual({ pixelId: "C4ABCDEF1234567890GH", enabled: true });

    const r = await resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });
    expect(r.kind === "ok" && r.analytics).toEqual({
      metaPixelId: "123456789012345",
      ga4MeasurementId: "G-ABC123XYZ9",
      googleAds: { id: "AW-123456789", purchaseLabel: "AbC-D_efG-h12" },
      tiktokPixelId: "C4ABCDEF1234567890GH",
    });

    // Meta-only save (the existing UI) leaves Google/TikTok untouched; switching them off hides them.
    await caller.landingPages.setTracking({ id: page.id, metaPixelId: "123456789012345", enabled: false });
    const kept = await caller.landingPages.tracking({ id: page.id });
    expect(kept.google.enabled).toBe(true);
    await caller.landingPages.setTracking({ id: page.id, metaPixelId: null, enabled: false, google: { ga4MeasurementId: "G-ABC123XYZ9", googleAdsId: null, googleAdsPurchaseLabel: null, enabled: false }, tiktok: { pixelId: "C4ABCDEF1234567890GH", enabled: false } });
    const off = await resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });
    expect(off.kind === "ok" && off.analytics).toBeNull();
  });

  it("the public config holds only the intended public IDs", () => {
    const cfg = analyticsConfigOf({
      metaPixelId: "123456789012345",
      enabled: true,
      ga4MeasurementId: "G-ABC123XYZ9",
      googleAdsId: "AW-123456789",
      googleAdsPurchaseLabel: "AbC-D_efG-h12",
      googleEnabled: true,
      tiktokPixelId: "C4ABCDEF1234567890GH",
      tiktokEnabled: true,
      ...({ accessToken: "EAAB-secret", apiSecret: "x", updatedAt: new Date() } as object),
    });
    expect(Object.keys(cfg!).sort()).toEqual(["ga4MeasurementId", "googleAds", "metaPixelId", "tiktokPixelId"]);
    expect(JSON.stringify(cfg)).not.toMatch(/secret|token|updatedAt/i);
    expect(analyticsConfigOf({ metaPixelId: "123456789012345", enabled: true })).toEqual({ metaPixelId: "123456789012345" });
    expect(analyticsConfigOf({ ga4MeasurementId: "G-ABC123XYZ9", googleEnabled: false })).toBeNull();
    expect(analyticsConfigOf({ tiktokPixelId: "C4ABCDEF1234567890GH", tiktokEnabled: false })).toBeNull();
  });

  it("two pages of the same merchant keep separate IDs; another merchant can't read or change them", async () => {
    const a = await shop();
    const tpl = (await a.caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
    const second = await a.caller.landingPages.create({ templateId: tpl.id, name: "Second" });
    await a.caller.landingPages.setTracking({ id: a.page.id, metaPixelId: null, enabled: false, tiktok: { pixelId: "AAAAAAAAAAAAAAAAAAA1", enabled: true } });
    await a.caller.landingPages.setTracking({ id: second.id, metaPixelId: null, enabled: false, tiktok: { pixelId: "BBBBBBBBBBBBBBBBBBB2", enabled: true } });
    expect((await a.caller.landingPages.tracking({ id: a.page.id })).tiktok.pixelId).toBe("AAAAAAAAAAAAAAAAAAA1");
    expect((await a.caller.landingPages.tracking({ id: second.id })).tiktok.pixelId).toBe("BBBBBBBBBBBBBBBBBBB2");

    const b = callerFor(authUserFor(await createMerchant()));
    await expect(b.landingPages.tracking({ id: a.page.id })).rejects.toThrow(/not found/i);
    await expect(b.landingPages.setTracking({ id: a.page.id, metaPixelId: null, enabled: false, tiktok: { pixelId: "CCCCCCCCCCCCCCCCCCC3", enabled: true } })).rejects.toThrow(/not found/i);
    expect(await b.marketing.trackingStatus()).toEqual([]);
    const statuses = await a.caller.marketing.trackingStatus();
    expect(statuses.map((s) => s.tiktok.id).sort()).toEqual(["AAAAAAAAAAAAAAAAAAA1", "BBBBBBBBBBBBBBBBBBB2"]);
  });
});

