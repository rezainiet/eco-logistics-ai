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
import { AuditLog, LandingPage } from "@ecom/db";
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
  it("includes only events with a real action behind them", () => {
    const names = Object.keys(LANDING_EVENTS);
    // No payment is taken and there are no forms/sign-ups (yet).
    for (const fake of ["Lead", "AddPaymentInfo", "CompleteRegistration", "Subscribe"]) {
      expect(names).not.toContain(fake);
    }
    const standard = names.filter((n) => LANDING_EVENTS[n as keyof typeof LANDING_EVENTS].kind === "standard");
    expect(standard.sort()).toEqual(["AddToCart", "Contact", "InitiateCheckout", "PageView", "Purchase", "ViewContent"]);
    // Purchase is tied to a server-created order, never to opening a form.
    expect(LANDING_EVENTS.Purchase.when).toMatch(/server created the order/i);
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

describe("per-page Meta Pixel settings (API)", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });
  afterAll(disconnectDb);

  async function publishedPage(slug: string, merchant?: Awaited<ReturnType<typeof createMerchant>>) {
    await ensureSystemTemplates();
    const owner = merchant ?? (await createMerchant({ email: `${slug}@shop.test` }));
    const caller = callerFor(authUserFor(owner));
    const shop = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
    const page = await caller.landingPages.create({ templateId: shop.id, name: `Shop ${slug}` });
    const got = await caller.landingPages.get({ id: page.id });
    const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
    bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
    const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
    await caller.landingPages.setSlug({ id: page.id, slug });
    await caller.landingPages.publish({ id: page.id, expectedRevision: saved.page.draftRevision });
    return { merchant: owner, caller, pageId: page.id };
  }

  it("rejects invalid IDs and enabling without an ID", async () => {
    const { caller, pageId } = await publishedPage("pixel-a");
    await expect(caller.landingPages.setTracking({ id: pageId, metaPixelId: "<script>alert(1)</script>", enabled: true })).rejects.toThrow(/15 or 16 digits/);
    await expect(caller.landingPages.setTracking({ id: pageId, metaPixelId: "javascript:1", enabled: false })).rejects.toThrow(/15 or 16 digits/);
    await expect(caller.landingPages.setTracking({ id: pageId, metaPixelId: "123456789012345');fbq('init','1", enabled: true })).rejects.toThrow(/15 or 16 digits/);
    await expect(caller.landingPages.setTracking({ id: pageId, metaPixelId: null, enabled: true })).rejects.toThrow(/Pixel ID/);
    expect(await caller.landingPages.tracking({ id: pageId })).toMatchObject({ metaPixelId: null, enabled: false });
  });

  it("serves the page's Pixel ID only while enabled, and takes effect without republishing", async () => {
    const { caller, merchant, pageId } = await publishedPage("pixel-b");
    const resolve = () => resolveLandingPageByHost("pixel-b.pages.test", { rootDomain: "pages.test" }); // cached path

    const before = await resolve();
    expect(before.kind === "ok" && before.analytics).toBeNull();
    expect(before.kind === "ok" && before.template.key).toBe("bd-modern-shop");

    const saved = await caller.landingPages.setTracking({ id: pageId, metaPixelId: " 1234 5678 9012 345 ", enabled: true });
    expect(saved).toMatchObject({ metaPixelId: PIXEL, enabled: true });
    const on = await resolve();
    expect(on.kind === "ok" && on.analytics).toEqual({ metaPixelId: PIXEL });

    await caller.landingPages.setTracking({ id: pageId, metaPixelId: PIXEL, enabled: false });
    const off = await resolve();
    expect(off.kind === "ok" && off.analytics).toBeNull();

    // Audited per page, with before/after — and nothing secret is stored.
    const audits = await AuditLog.find({ merchantId: merchant._id, action: "landing.tracking_updated" }).lean();
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.subjectType === "landing_page" && String(a.subjectId) === pageId)).toBe(true);
    const stored = await LandingPage.findById(pageId).select("tracking").lean();
    expect(Object.keys(stored!.tracking!).sort()).toEqual(["enabled", "metaPixelId", "updatedAt"]);
  });

  it("two pages of the SAME merchant each load only their own pixel", async () => {
    const one = await publishedPage("campaign-one");
    const two = await publishedPage("campaign-two", one.merchant);
    const three = await publishedPage("no-pixel", one.merchant);
    await one.caller.landingPages.setTracking({ id: one.pageId, metaPixelId: PIXEL, enabled: true });
    await one.caller.landingPages.setTracking({ id: two.pageId, metaPixelId: "9876543210987654", enabled: true });
    const r = (slug: string) => resolveLandingPageByHost(`${slug}.pages.test`, { rootDomain: "pages.test", useCache: false });
    const [p1, p2, p3] = await Promise.all([r("campaign-one"), r("campaign-two"), r("no-pixel")]);
    expect(p1.kind === "ok" && p1.analytics).toEqual({ metaPixelId: PIXEL });
    expect(p2.kind === "ok" && p2.analytics).toEqual({ metaPixelId: "9876543210987654" });
    expect(p3.kind === "ok" && p3.analytics).toBeNull();
    expect(await one.caller.landingPages.tracking({ id: three.pageId })).toMatchObject({ metaPixelId: null, enabled: false });
  });

  it("is tenant-isolated: nobody can read or set another merchant's page pixel", async () => {
    const a = await publishedPage("tenant-a");
    const b = await publishedPage("tenant-b");
    await a.caller.landingPages.setTracking({ id: a.pageId, metaPixelId: PIXEL, enabled: true });
    await expect(b.caller.landingPages.tracking({ id: a.pageId })).rejects.toThrow(/not found/i);
    await expect(b.caller.landingPages.setTracking({ id: a.pageId, metaPixelId: "9876543210987654", enabled: true })).rejects.toThrow(/not found/i);
    const pa = await resolveLandingPageByHost("tenant-a.pages.test", { rootDomain: "pages.test", useCache: false });
    const pb = await resolveLandingPageByHost("tenant-b.pages.test", { rootDomain: "pages.test", useCache: false });
    expect(pa.kind === "ok" && pa.analytics).toEqual({ metaPixelId: PIXEL });
    expect(pb.kind === "ok" && pb.analytics).toBeNull();
  });
});
