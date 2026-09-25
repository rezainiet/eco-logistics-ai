import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  LANDING_EVENTS,
  SYSTEM_TEMPLATES,
  type TemplateSpec,
  analyticsConfigOf,
  defaultContent,
  isMetaPixelId,
  linkKind,
  normalizeMetaPixelId,
  productCatalog,
} from "@ecom/landing";
import { LandingRenderer, assetEnv } from "@ecom/landing/react";
import { AuditLog, Merchant } from "@ecom/db";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

/**
 * Meta Pixel for published landing pages: Pixel ID validation, merchant
 * settings, what the public payload exposes, and the honest event catalogue.
 * (Browser-side delivery is verified separately with Playwright against a
 * running published page — see docs/landing-analytics.md.)
 */

const PIXEL = "123456789012345";

describe("Meta Pixel ID validation", () => {
  it("accepts only 15–16 digit IDs", () => {
    expect(isMetaPixelId("123456789012345")).toBe(true);
    expect(isMetaPixelId("1234567890123456")).toBe(true);
    for (const bad of [
      "",
      "12345",
      "12345678901234567",
      "023456789012345",
      "12345678901234a",
      "javascript:alert(1)",
      "<script>alert(1)</script>",
      "123456789012345<script>",
      "123456789012345');fbq('init','1",
      " 123456789012345",
      null,
      123456789012345,
    ]) {
      expect(isMetaPixelId(bad), String(bad)).toBe(false);
    }
  });

  it("normalises pasted IDs but never rescues garbage", () => {
    expect(normalizeMetaPixelId(" 1234 5678 9012 345 ")).toBe(PIXEL);
    expect(normalizeMetaPixelId("1234-5678-9012-345")).toBe(PIXEL);
    expect(normalizeMetaPixelId("<script>123456789012345</script>")).toBeNull();
    expect(normalizeMetaPixelId("fbq('init', '123456789012345')")).toBeNull();
  });

  it("serves a config only when enabled with a valid ID", () => {
    expect(analyticsConfigOf({ metaPixelId: PIXEL, enabled: true })).toEqual({ metaPixelId: PIXEL });
    expect(analyticsConfigOf({ metaPixelId: PIXEL, enabled: false })).toBeNull();
    expect(analyticsConfigOf({ metaPixelId: "abc", enabled: true })).toBeNull();
    expect(analyticsConfigOf(null)).toBeNull();
  });
});

describe("event catalogue", () => {
  it("never includes e-commerce events that have no real action behind them", () => {
    const names = Object.keys(LANDING_EVENTS);
    for (const fake of ["Purchase", "AddToCart", "InitiateCheckout", "Lead", "AddPaymentInfo", "CompleteRegistration"]) {
      expect(names).not.toContain(fake);
    }
    const standard = names.filter((n) => LANDING_EVENTS[n as keyof typeof LANDING_EVENTS].kind === "standard");
    expect(standard.sort()).toEqual(["Contact", "PageView", "ViewContent"]);
  });

  it("classifies links by kind without exposing the destination", () => {
    expect(linkKind("https://wa.me/8801711000000?text=hi")).toBe("whatsapp");
    expect(linkKind("tel:+8801711000000")).toBe("phone");
    expect(linkKind("mailto:shop@example.com")).toBe("email");
    expect(linkKind("https://m.me/bazarmart")).toBe("messenger");
    expect(linkKind("#order")).toBe("section");
    expect(linkKind("https://example.com/x")).toBe("link");
    expect(linkKind("javascript:alert(1)")).toBeNull();
  });

  it("builds a product catalogue (name + BDT price) from validated content", () => {
    const tpl = SYSTEM_TEMPLATES.find((t) => t.key === "bd-modern-shop")!;
    const spec = tpl.spec as TemplateSpec;
    const content = defaultContent(spec, "bn");
    const cat = productCatalog(spec, content, "bn");
    expect(cat["products-0"]).toEqual({ name: "প্রিমিয়াম কটন শার্ট", price: 1290 });
    expect(cat["offer-0"]?.price).toBeTypeOf("number");
    // Keys are positional and non-personal.
    expect(Object.keys(cat).every((k) => /^[a-z][a-z0-9-]*-\d+$/.test(k))).toBe(true);
  });

  it("public markup carries product keys but no pixel code or editor attributes", () => {
    const tpl = SYSTEM_TEMPLATES.find((t) => t.key === "bd-modern-shop")!;
    const spec = tpl.spec as TemplateSpec;
    const html = renderToStaticMarkup(
      createElement(LandingRenderer, { spec, content: defaultContent(spec, "bn"), locale: "bn", env: assetEnv("https://api.example/a") }),
    );
    expect(html).toContain('data-lp-product="products-0"');
    expect(html).toContain('data-lp-product="offer-0"');
    expect(html).not.toContain("fbq");
    expect(html).not.toContain("facebook");
    expect(html).not.toContain("data-lp-field");
  });
});

describe("tracking settings (API)", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });
  afterAll(disconnectDb);

  async function publishedPage(slug: string) {
    await ensureSystemTemplates();
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const shop = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
    const page = await caller.landingPages.create({ templateId: shop.id, name: "Shop" });
    const got = await caller.landingPages.get({ id: page.id });
    const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
    bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
    const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
    await caller.landingPages.setSlug({ id: page.id, slug });
    await caller.landingPages.publish({ id: page.id, expectedRevision: saved.page.draftRevision });
    return { merchant, caller };
  }

  it("rejects invalid IDs and enabling without an ID", async () => {
    const { caller } = await publishedPage("pixel-a");
    await expect(caller.landingPages.setTracking({ metaPixelId: "<script>alert(1)</script>", enabled: true })).rejects.toThrow(/15 or 16 digits/);
    await expect(caller.landingPages.setTracking({ metaPixelId: "javascript:1", enabled: false })).rejects.toThrow(/15 or 16 digits/);
    await expect(caller.landingPages.setTracking({ metaPixelId: null, enabled: true })).rejects.toThrow(/Pixel ID/);
    expect(await caller.landingPages.tracking()).toMatchObject({ metaPixelId: null, enabled: false });
  });

  it("serves the Pixel ID with published pages only while enabled, and takes effect without republishing", async () => {
    const { caller, merchant } = await publishedPage("pixel-b");
    const resolve = () => resolveLandingPageByHost("pixel-b.pages.test", { rootDomain: "pages.test" }); // cached path

    const before = await resolve();
    expect(before.kind === "ok" && before.analytics).toBeNull();
    expect(before.kind === "ok" && before.template.key).toBe("bd-modern-shop");

    const saved = await caller.landingPages.setTracking({ metaPixelId: " 1234 5678 9012 345 ", enabled: true });
    expect(saved).toMatchObject({ metaPixelId: PIXEL, enabled: true });
    const on = await resolve();
    expect(on.kind === "ok" && on.analytics).toEqual({ metaPixelId: PIXEL });

    await caller.landingPages.setTracking({ metaPixelId: PIXEL, enabled: false });
    const off = await resolve();
    expect(off.kind === "ok" && off.analytics).toBeNull();

    // Audited, with before/after — and nothing secret is stored.
    const audits = await AuditLog.find({ merchantId: merchant._id, action: "landing.tracking_updated" }).lean();
    expect(audits).toHaveLength(2);
    const stored = await Merchant.findById(merchant._id).select("landingTracking").lean();
    expect(Object.keys(stored!.landingTracking!).sort()).toEqual(["enabled", "metaPixelId", "updatedAt"]);
  });

  it("is tenant-isolated: one merchant's pixel never appears on another's page", async () => {
    const a = await publishedPage("tenant-a");
    const b = await publishedPage("tenant-b");
    await a.caller.landingPages.setTracking({ metaPixelId: PIXEL, enabled: true });
    await b.caller.landingPages.setTracking({ metaPixelId: "9876543210987654", enabled: true });
    const pa = await resolveLandingPageByHost("tenant-a.pages.test", { rootDomain: "pages.test", useCache: false });
    const pb = await resolveLandingPageByHost("tenant-b.pages.test", { rootDomain: "pages.test", useCache: false });
    expect(pa.kind === "ok" && pa.analytics).toEqual({ metaPixelId: PIXEL });
    expect(pb.kind === "ok" && pb.analytics).toEqual({ metaPixelId: "9876543210987654" });
    expect(await b.caller.landingPages.tracking()).toMatchObject({ metaPixelId: "9876543210987654" });
  });
});
