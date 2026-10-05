import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CatalogProduct,
  type Locale,
  SYSTEM_TEMPLATES,
  type TemplateSpec,
  defaultContent,
  effectiveSections,
  hasMobileActionBar,
  parseTemplateSpec,
  resolveContent,
  resolveEditTarget,
  themeMotion,
  validateContent,
} from "@ecom/landing";
import { LandingRenderer, assetEnv } from "@ecom/landing/react";
import { LandingPageTemplate, LandingPageTemplateVersion } from "@ecom/db";
import { placeLandingOrder } from "../src/lib/commerce/landing-orders.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { __resetTemplateCacheForTests, ensureSystemTemplates } from "../src/lib/landing/templates.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * BD Single Product: the first built-in template built on theme@2, the
 * Product spotlight (Buy now) and the mobile order bar. Composition of
 * existing section types only — no new section, checkout or renderer.
 */

const KEY = "bd-single-product";
const env = assetEnv("https://api.example/api/landing-assets");
type Content = Record<string, Record<string, unknown>>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const def = () => SYSTEM_TEMPLATES.find((t) => t.key === KEY)!;
const spec = (): TemplateSpec => clone(def().spec);

function render(s: TemplateSpec, content: unknown, opts: { locale?: Locale; editable?: boolean; catalog?: CatalogProduct[] } = {}) {
  return renderToStaticMarkup(
    createElement(LandingRenderer, {
      spec: s,
      content,
      locale: opts.locale ?? "bn",
      env: { ...env, editable: !!opts.editable, ...(opts.catalog ? { catalog: opts.catalog } : {}) },
    }),
  ).replace(/ /g, " ");
}

const sectionHtml = (html: string, id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start) + 10);
};

const P = "6ab73cca06587711398245c7";
const tee: CatalogProduct = {
  id: P,
  name: "Cotton Panjabi",
  description: "Soft cotton.",
  imageAssetId: null,
  price: 1200,
  compareAtPrice: null,
  currency: "BDT",
  available: true,
  stockStatus: "in_stock",
  maxQuantity: 5,
  badge: null,
  ctaText: null,
  featured: true,
  options: [{ name: "Size", values: ["M", "L"] }],
  variants: [
    { id: "6ab73cca06587711398245d1", optionValues: ["M"], label: "M", price: 1200, compareAtPrice: 1500, imageAssetId: null, available: true, stockStatus: "in_stock", maxQuantity: 5 },
    { id: "6ab73cca06587711398245d2", optionValues: ["L"], label: "L", price: 1200, compareAtPrice: null, imageAssetId: null, available: false, stockStatus: "out_of_stock", maxQuantity: 0 },
  ],
  priceFrom: false,
};

// ── Registration and structure ──────────────────────────────────────────────

describe("BD Single Product: registration and structure", () => {
  it("is a registered, valid ecommerce system template, listed after the two shop templates", () => {
    const t = def();
    expect(t).toMatchObject({ key: KEY, name: "BD Single Product", category: "ecommerce" });
    expect(parseTemplateSpec(t.spec).ok).toBe(true);
    expect(SYSTEM_TEMPLATES.map((x) => x.key)).toEqual(["bd-modern-shop", "bd-premium-brand", KEY, "launch", "showcase", "local-service"]);
    expect(t.spec).toMatchObject({ locales: ["bn", "en"], defaultLocale: "bn" });
  });

  it("uses theme@2 with subtle scroll animation (theme@1 is untouched)", () => {
    const theme = spec().sections.find((s) => s.type === "theme")!;
    expect(theme.typeVersion).toBe(2);
    expect(themeMotion(defaultContent(spec(), "bn").theme)).toBe("subtle");
    expect(effectiveSections(spec()).find((s) => s.type === "theme")!.fields.map((f) => f.key)).toContain("motion");
  });

  it("has the funnel's sections in order, all existing section types", () => {
    expect(effectiveSections(spec()).map((s) => `${s.id}:${s.type}@${s.typeVersion}`)).toEqual([
      "theme:theme@2",
      "seo:seo@1",
      "topbar:announcement@1",
      "hero:promoHero@1",
      "spotlight:productSpotlight@1",
      "benefits:benefits@1",
      "trust:trustFeatures@1",
      "how:features@1",
      "offer:offerBanner@1",
      "reviews:testimonials@1",
      "faq:faq@1",
      "delivery:deliveryInfo@1",
      "orderbar:mobileActionBar@1",
      "footer:shopFooter@1",
    ]);
    expect(hasMobileActionBar(spec())).toBe(true);
  });

  it("points every order button at the spotlight, in both languages; the bar's other buttons start unset", () => {
    for (const locale of ["bn", "en"] as const) {
      const c = defaultContent(spec(), locale) as Content;
      for (const [id, key] of [["hero", "primaryCta"], ["benefits", "cta"], ["offer", "cta"], ["orderbar", "primaryCta"]] as const) {
        expect(c[id]![key], `${locale} ${id}.${key}`).toMatchObject({ action: { kind: "section", sectionId: "spotlight" } });
      }
      expect(c.hero!.secondaryCta).toEqual({ label: "", action: { kind: "none" } }); // no second hero button: product sooner on phones
      expect(c.orderbar!.whatsappCta).toMatchObject({ action: { kind: "none" } });
      expect(c.orderbar!.callCta).toMatchObject({ action: { kind: "none" } });
    }
    expect((defaultContent(spec(), "bn") as Content).orderbar!.primaryCta).toMatchObject({ label: "এখনই অর্ডার করুন" });
    expect((defaultContent(spec(), "en") as Content).orderbar!.primaryCta).toMatchObject({ label: "Order now" });
  });

  it("can be published straight from its defaults, in Bangla and English", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(validateContent(spec(), defaultContent(spec(), locale), "publish").issues, locale).toEqual([]);
    }
  });
});

// ── Honest defaults: no copied product data, no invented reviews ────────────

describe("BD Single Product: defaults hold no product data and no invented reviews", () => {
  it("holds no price, stock or product name anywhere in its content", () => {
    for (const locale of ["bn", "en"] as const) {
      const c = defaultContent(spec(), locale) as Content;
      const priced = JSON.stringify(c).match(/"(price|oldPrice|charge)":\s*(-?\d+)/g);
      expect(priced, locale).toBeNull();
      expect(Object.keys(c.spotlight!).sort()).toEqual(["ctaLabel", "eyebrow", "highlights", "layout", "note", "showDescription", "tagline"]);
    }
  });

  it("the offer banner's price fields are locked empty: stored prices are ignored", () => {
    const offer = effectiveSections(spec()).find((s) => s.id === "offer")!;
    for (const key of ["price", "oldPrice"]) expect(offer.fields.find((f) => f.key === key)).toMatchObject({ editable: false, default: null });
    const tampered = clone(defaultContent(spec(), "en")) as Content;
    tampered.offer = { ...tampered.offer, price: 999, oldPrice: 1999 };
    expect(resolveContent(spec(), tampered, "en").offer).toMatchObject({ price: null, oldPrice: null });
    expect(sectionHtml(render(spec(), tampered, { locale: "en" }), "offer")).not.toMatch(/999/);
  });

  it("reviews start as bracketed prompts with no star rating — never invented customers", () => {
    for (const locale of ["bn", "en"] as const) {
      const items = (defaultContent(spec(), locale) as Content).reviews!.items as Array<Record<string, string>>;
      expect(items).toHaveLength(3);
      for (const r of items) {
        expect(r.quote).toMatch(/^\[.*\]$/);
        expect(r.name).toMatch(/^\[.*\]$/);
        expect(r.rating).toBe("0");
      }
    }
    expect(sectionHtml(render(spec(), defaultContent(spec(), "bn")), "reviews")).not.toContain('role="img"'); // no stars
  });

  it("delivery copy names no fee (the checkout shows the live charge) and offers cash on delivery only", () => {
    for (const locale of ["bn", "en"] as const) {
      const d = (defaultContent(spec(), locale) as Content).delivery!;
      expect((d.zones as Array<{ charge: unknown }>).every((z) => z.charge === null)).toBe(true);
      expect(d.payments).toEqual([{ method: "cod" }]);
    }
  });
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe("BD Single Product: rendering", () => {
  it.each(["bn", "en"] as const)("renders every section in %s, with the live product in the spotlight", (locale) => {
    const html = render(spec(), defaultContent(spec(), locale), { locale, catalog: [tee] });
    const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["topbar", "hero", "spotlight", "benefits", "trust", "how", "offer", "reviews", "faq", "delivery", "orderbar", "footer"]);
    const spot = sectionHtml(html, "spotlight");
    expect(spot).toContain(`data-lp-spotlight="${P}"`);
    expect(spot).toContain(">Cotton Panjabi</h2>");
    expect(spot).toMatch(locale === "bn" ? /৳ ১,২০০/ : /৳ 1,200/);
    expect(spot).toMatch(locale === "bn" ? /৳ ১,৫০০/ : /৳ 1,500/); // old price from the live variant
    expect(spot).toMatch(/data-lp-buy-value="L" disabled=""/); // sold-out option disabled
    expect(spot).toContain("Soft cotton."); // live description shown
    expect(spot).toContain(locale === "bn" ? ">এখনই অর্ডার করুন</span>" : ">Order now</span>");
    // The bar buys the spotlight product; its link still scrolls without JavaScript.
    expect(sectionHtml(html, "orderbar")).toMatch(new RegExp(`<a href="#spotlight"[^>]*data-lp-cart-buy="${P}"`));
    // Bottom padding for the bar on phones, and the page's scroll reveal.
    expect(html).toContain("max-md:pb-[calc(4.75rem+env(safe-area-inset-bottom,0px))]");
    expect(html).toContain('data-lp-motion="subtle"');
    expect(html).not.toMatch(/<script/i);
  });

  it("speaks the page's language", () => {
    const bn = render(spec(), defaultContent(spec(), "bn"), { catalog: [tee] });
    for (const text of ["কীভাবে অর্ডার করবেন", "সাধারণ জিজ্ঞাসা", "ডেলিভারি তথ্য", "নিশ্চিন্তে কেনাকাটা করুন", "দ্রুত অর্ডার"]) expect(bn).toContain(text);
    const en = render(spec(), defaultContent(spec(), "en"), { locale: "en", catalog: [tee] });
    for (const text of ["How to order", "Frequently asked questions", "Delivery information", "Shop with confidence", "Quick order"]) expect(en).toContain(text);
  });

  it("without a linked product the public page shows no spotlight and the bar only scrolls", () => {
    const html = render(spec(), defaultContent(spec(), "bn"));
    expect(sectionHtml(html, "spotlight")).not.toMatch(/data-lp-spotlight|<button/);
    expect(html).not.toContain("data-lp-cart-buy");
    expect(sectionHtml(render(spec(), defaultContent(spec(), "bn"), { editable: true }), "spotlight")).toContain("data-lp-spotlight-empty");
  });

  it("click-to-edit: every editable element opens a real field; the editor never animates", () => {
    for (const locale of ["bn", "en"] as const) {
      const html = render(spec(), defaultContent(spec(), locale), { locale, editable: true, catalog: [tee] });
      expect(html).not.toMatch(/data-lp-motion|data-lp-reveal/);
      const targets = [...html.matchAll(/data-lp-section="([^"]+)"[\s\S]*?(?=data-lp-section="|$)/g)].flatMap((m) =>
        [...m[0].matchAll(/data-lp-field="([^"]+)"/g)].map((f) => `${m[1]}.${f[1]}`),
      );
      expect(targets.length).toBeGreaterThan(40);
      for (const path of targets) expect(resolveEditTarget(spec(), locale, path), path).toMatchObject({ kind: "field" });
      for (const path of ["spotlight.ctaLabel", "orderbar.primaryCta", "hero.headline", "faq.items.0", "reviews.items.0"]) expect(targets).toContain(path);
    }
  });
});

// ── Seeding and a real page (database) ──────────────────────────────────────

describe("BD Single Product: seeding, publishing and ordering (database)", () => {
  beforeAll(ensureDb);
  afterAll(disconnectDb);
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });

  it("a merchant publishes it unedited with a linked product; Buy now orders are checked by the server", async () => {
    await ensureSystemTemplates();
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const product = await caller.products.create({
      name: "Panjabi",
      price: 1200,
      variants: { options: [{ name: "Size", values: ["M", "L"] }], variants: [{ optionValues: ["M"], compareAtPrice: 1500, initialStock: 3 }, { optionValues: ["L"], initialStock: 0 }] },
    });
    const tpl = (await caller.landingPages.templates()).find((t) => t.key === KEY)!;
    expect(tpl.name).toBe("BD Single Product");
    const page = await caller.landingPages.create({ templateId: tpl.id, name: "Panjabi offer" });
    const got = await caller.landingPages.get({ id: page.id });
    const linked = await caller.landingPages.setProducts({ id: page.id, expectedRevision: got.page.draftRevision, products: [{ productId: product.id, featured: true }] });
    await caller.landingPages.setSlug({ id: page.id, slug: "single-panjabi" });
    await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });

    const host = "single-panjabi.localhost";
    const resolved = await resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });
    if (resolved.kind !== "ok") throw new Error("not published");
    const catalog = resolved.commerce!.products;
    expect(catalog.map((p) => p.id)).toEqual([product.id]);
    const html = render(resolved.spec as TemplateSpec, resolved.content, { catalog });
    expect(sectionHtml(html, "spotlight")).toContain(">Panjabi</h2>");
    expect(sectionHtml(html, "orderbar")).toContain(`data-lp-cart-buy="${product.id}"`);

    const M = product.variants.find((v) => v.label === "M")!.id;
    const L = product.variants.find((v) => v.label === "L")!.id;
    const place = (items: Array<{ productId: string; variantId?: string; quantity: number; unitPrice?: number }>, phone = "01712345678") =>
      placeLandingOrder({
        host,
        locale: null,
        idempotencyKey: `single-${Date.now()}-${Math.random().toString(36).slice(2)}-abcdefgh`,
        items,
        customer: { name: "রহিম", phone, address: "বাড়ি ১২, রোড ৫, ধানমন্ডি", district: "ঢাকা" },
        deliveryOptionId: resolved.commerce!.delivery[0]!.id,
      });
    expect(await place([{ productId: product.id, quantity: 1 }])).toMatchObject({ ok: false, code: "invalid_request" }); // option required
    expect(await place([{ productId: product.id, variantId: L, quantity: 1 }])).toMatchObject({ ok: false, code: "unavailable" });
    expect(await place([{ productId: product.id, variantId: M, quantity: 1, unitPrice: 1 }])).toMatchObject({ ok: false, code: "price_changed" });
    const ok = await place([{ productId: product.id, variantId: M, quantity: 1 }]);
    expect(ok).toMatchObject({ ok: true, subtotal: 1200 });
  });

  it("is added to a database that already has the other five without touching them", async () => {
    await ensureSystemTemplates();
    // Simulate a database seeded before this template existed.
    const mine = (await LandingPageTemplate.findOne({ key: KEY }).lean())!;
    await LandingPageTemplateVersion.deleteMany({ templateId: mine._id });
    await LandingPageTemplate.deleteOne({ _id: mine._id });
    const before = await LandingPageTemplate.find({}).sort({ key: 1 }).lean();

    expect(await ensureSystemTemplates()).toEqual({ created: 1, versioned: 1 });
    const after = await LandingPageTemplate.find({ key: { $ne: KEY } }).sort({ key: 1 }).lean();
    expect(after.map((t) => [t.key, t.currentVersion, String(t.currentVersionId), t.sortOrder])).toEqual(
      before.map((t) => [t.key, t.currentVersion, String(t.currentVersionId), t.sortOrder]),
    );
    const added = (await LandingPageTemplate.findOne({ key: KEY }).lean())!;
    expect(added).toMatchObject({ origin: "system", status: "active", currentVersion: 1, category: "ecommerce" });
    expect(await ensureSystemTemplates()).toEqual({ created: 0, versioned: 0 });
  });
});
