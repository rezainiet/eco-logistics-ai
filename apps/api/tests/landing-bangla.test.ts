import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  SYSTEM_TEMPLATES,
  type TemplateSpec,
  defaultContent,
  discountPercent,
  formatBDT,
  formatNumber,
  formatPercent,
  parseTemplateSpec,
  readLocalized,
  resolveContent,
  resolveSeo,
  toBengaliDigits,
  validateLocalizedContent,
} from "@ecom/landing";
import { LandingRenderer, ProductCard, assetEnv, ctxOf } from "@ecom/landing/react";
import { LandingPage } from "@ecom/db";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

const NBSP = String.fromCharCode(0xa0);
const env = assetEnv("https://api.example/api/landing-assets");
type C = Record<string, Record<string, unknown>>;

function spec(key: string): TemplateSpec {
  return JSON.parse(JSON.stringify(SYSTEM_TEMPLATES.find((t) => t.key === key)!.spec)) as TemplateSpec;
}
function render(s: TemplateSpec, content: unknown, locale: "en" | "bn"): string {
  return renderToStaticMarkup(createElement(LandingRenderer, { spec: s, content, env, locale }));
}

// The Phase 19 browser-test copy — natural Bangla, not Banglish.
const FIXTURE = {
  headline: "আপনার পছন্দের পণ্য এখন হাতের মুঠোয়",
  sub: "বাংলাদেশের যেকোনো প্রান্তে দ্রুত ডেলিভারি এবং ক্যাশ অন ডেলিভারি সুবিধা।",
  cta: "এখনই অর্ডার করুন",
  product: "প্রিমিয়াম কটন শার্ট",
};

describe("BDT and number formatting", () => {
  it("uses Bangla digits and South-Asian grouping on Bangla pages", () => {
    expect(formatBDT(1290, { locale: "bn" })).toBe(`৳${NBSP}১,২৯০`);
    expect(formatBDT(125000, { locale: "bn" })).toBe(`৳${NBSP}১,২৫,০০০`);
    expect(formatBDT(1250000, { locale: "bn" })).toBe(`৳${NBSP}১২,৫০,০০০`);
    expect(formatBDT(99.5, { locale: "bn" })).toBe(`৳${NBSP}৯৯.৫`);
  });

  it("uses Latin digits on English pages and when the merchant prefers them", () => {
    expect(formatBDT(1290, { locale: "en" })).toBe(`৳${NBSP}1,290`);
    expect(formatBDT(1290, { locale: "bn", numerals: "latin" })).toBe(`৳${NBSP}1,290`);
    expect(formatBDT(1290, { locale: "en", numerals: "bengali" })).toBe(`৳${NBSP}১,২৯০`);
    expect(formatNumber(0, { locale: "bn" })).toBe("০");
    expect(toBengaliDigits("০১৭১১-000000")).toBe("০১৭১১-০০০০০০");
  });

  it("computes discounts consistently", () => {
    expect(discountPercent(1290, 1650)).toBe(22);
    expect(discountPercent(1650, 1290)).toBeNull();
    expect(discountPercent(100, null)).toBeNull();
    expect(formatPercent(22, { locale: "bn" })).toBe("২২%");
  });
});

describe("product card", () => {
  const product = {
    image: null,
    name: FIXTURE.product,
    price: 1290,
    oldPrice: 1650,
    badge: "নতুন",
    rating: "5",
    cta: { label: "কার্টে যোগ করুন", action: { kind: "section", sectionId: "order" } },
  };

  it("renders a Bangla product with ৳ price, old price and discount", () => {
    const html = renderToStaticMarkup(createElement(ProductCard, { product, ctx: ctxOf({ ...env, locale: "bn" }) }));
    expect(html).toContain(FIXTURE.product);
    expect(html).toContain(`৳${NBSP}১,২৯০`);
    expect(html).toContain(`৳${NBSP}১,৬৫০`);
    expect(html).toContain("২২% ছাড়");
    expect(html).toContain("কার্টে যোগ করুন");
    expect(html).toContain('href="#order"');
  });

  it("renders the same card in English", () => {
    const html = renderToStaticMarkup(
      createElement(ProductCard, { product: { ...product, name: "Premium Cotton Shirt" }, ctx: ctxOf({ ...env, locale: "en" }) }),
    );
    expect(html).toContain(`৳${NBSP}1,290`);
    expect(html).toContain("-22%");
  });
});

describe("Bangla templates and typography", () => {
  it("ships two e-commerce templates that are Bangla-first and structurally different", () => {
    const shop = spec("bd-modern-shop");
    const brand = spec("bd-premium-brand");
    expect(parseTemplateSpec(shop).ok).toBe(true);
    expect(parseTemplateSpec(brand).ok).toBe(true);
    expect(shop.defaultLocale).toBe("bn");
    expect(brand.defaultLocale).toBe("bn");
    const types = (s: TemplateSpec) => s.sections.map((x) => x.type).join(",");
    expect(types(shop)).not.toBe(types(brand));
    expect(defaultContent(shop, "bn").hero!.headline).toBe(FIXTURE.headline);
    expect(defaultContent(shop, "en").hero!.headline).toBe("Your favourite products, now in your hands");
  });

  it.each(["bd-modern-shop", "bd-premium-brand", "launch", "showcase", "local-service"])(
    "renders %s in Bangla with Bangla typography",
    (key) => {
      const s = spec(key);
      const html = render(s, defaultContent(s, "bn"), "bn");
      expect(html).toContain('lang="bn"');
      expect(html).toMatch(/--lp-font-bn-(sans|serif)/);
      expect(html).toContain("--lp-tracking:0");
      expect(html).toContain("font-feature-settings:normal");
      expect(html).toContain("text-transform:none");
      // Latin-only tight tracking utility must not reach Bangla headings.
      expect(html).not.toContain("tracking-tight");
      // Heading line-height must win over responsive text-size utilities at every breakpoint.
      expect(html).toContain("!leading-[var(--lp-lh-heading)]");
      expect(html).not.toMatch(/<script/i);
    },
  );

  it("uses the Bengali serif for the premium template", () => {
    const html = render(spec("bd-premium-brand"), defaultContent(spec("bd-premium-brand"), "bn"), "bn");
    expect(html).toContain("--lp-font-bn-serif");
    expect(html).toContain("চিরন্তন কারুকাজ");
  });

  it("renders prices in the page's numeral style", () => {
    const s = spec("bd-modern-shop");
    const bn = render(s, defaultContent(s, "bn"), "bn");
    expect(bn).toContain(`৳${NBSP}১,২৯০`);
    const latin = defaultContent(s, "bn");
    latin.theme!.numerals = "latin";
    expect(render(s, latin, "bn")).toContain(`৳${NBSP}1,290`);
    expect(render(s, defaultContent(s, "en"), "en")).toContain(`৳${NBSP}1,290`);
  });

  it("keeps mixed Bangla + English, Bangla digits, phone numbers and URLs intact", () => {
    const s = spec("bd-modern-shop");
    const c = defaultContent(s, "bn");
    c.hero!.headline = "নতুন iPhone 15 কভার — মাত্র ৳৪৯৯!";
    c.footer!.phone = "+880 1711-000000";
    c.footer!.links = [{ label: "আমাদের Facebook পেজ", url: "https://facebook.com/bazarmart" }];
    const html = render(s, c, "bn");
    expect(html).toContain("নতুন iPhone 15 কভার — মাত্র ৳৪৯৯!");
    expect(html).toContain('href="tel:+8801711000000"');
    expect(html).toContain('href="https://facebook.com/bazarmart"');
  });

  it("resolves Bangla SEO", () => {
    const s = spec("bd-modern-shop");
    const seo = resolveSeo(s, resolveContent(s, defaultContent(s, "bn"), "bn"));
    expect(seo.title).toBe("বাংলাদেশে অনলাইন শপিং | বাজার মার্ট");
    expect(seo.description).toBe("সেরা পণ্য, দ্রুত ডেলিভারি এবং সহজ অর্ডার সুবিধা।");
  });
});

describe("localized validation and security", () => {
  const s = spec("bd-modern-shop");
  const settings = { locales: ["bn" as const], defaultLocale: "bn" as const };

  it("validates each enabled locale and prefixes issue paths", () => {
    const c = { bn: defaultContent(s, "bn") } as Record<string, C>;
    c.bn!.hero!.headline = "";
    const r = validateLocalizedContent(s, c, settings, "publish");
    expect(r.issues.some((i) => i.path === "bn.hero.headline")).toBe(true);
    expect(validateLocalizedContent(s, { ...c, fr: {} }, settings, "draft").issues.map((i) => i.path)).toContain("fr");
    expect(validateLocalizedContent(s, { ...c, en: {} }, settings, "draft").issues.map((i) => i.path)).toContain("en");
  });

  it("keeps Bangla XSS payloads as text and rejects unsafe URLs, HTML and CSS", () => {
    const base = { bn: defaultContent(s, "bn") } as Record<string, C>;
    const xss = structuredClone(base);
    xss.bn!.hero!.headline = `<script>alert("হ্যাক")</script> ${FIXTURE.headline}`;
    const ok = validateLocalizedContent(s, xss, settings, "draft");
    expect(ok.ok).toBe(true);
    const html = render(s, ok.content.bn, "bn");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");

    const bad = structuredClone(base);
    bad.bn!.hero!.primaryCta = { label: FIXTURE.cta, action: { kind: "link", url: "javascript:alert('ঢাকা')" } };
    bad.bn!.theme!.primary = "red;}body{display:none";
    bad.bn!.hero!.image = { assetId: "https://evil.example/ছবি.png", alt: "" };
    (bad.bn!.hero as Record<string, unknown>).html = "<b>বাংলা</b>";
    const r = validateLocalizedContent(s, bad, settings, "draft");
    expect(r.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "bn.hero.primaryCta.action.url",
        "bn.theme.primary",
        "bn.hero.image.assetId",
        "bn.hero.html",
      ]),
    );
  });

  it("validates prices", () => {
    const base = { bn: defaultContent(s, "bn") } as Record<string, C>;
    for (const price of [-1, "1290", 12.345, Number.POSITIVE_INFINITY]) {
      const c = structuredClone(base);
      c.bn!.offer!.price = price;
      expect(validateLocalizedContent(s, c, settings, "draft").ok, String(price)).toBe(false);
    }
  });

  it("rejects unsafe per-locale template defaults and locale-code section ids", () => {
    const bad = spec("bd-modern-shop");
    bad.localeDefaults!.bn!.hero!.primaryCta = { label: "x", action: { kind: "link", url: "javascript:alert(1)" } };
    expect(parseTemplateSpec(bad).ok).toBe(false);
    const clash = spec("launch");
    clash.sections.push({ id: "bn", type: "faq", typeVersion: 1 });
    expect(parseTemplateSpec(clash).ok).toBe(false);
  });

  it("reads legacy single-locale content as English", () => {
    expect(readLocalized({ hero: { headline: "x" } })).toEqual({ en: { hero: { headline: "x" } } });
    expect(readLocalized({ bn: { hero: {} } })).toEqual({ bn: { hero: {} } });
  });
});

describe("Bangla pages end to end (API)", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });
  afterAll(disconnectDb);

  const resolve = (host: string, locale: string | null = null) =>
    resolveLandingPageByHost(host, { rootDomain: "pages.test", useCache: false, locale });

  async function setup() {
    await ensureSystemTemplates();
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const shop = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
    return { caller, shop };
  }

  it("creates, saves, publishes and serves a Bangla page, then adds English", async () => {
    const { caller, shop } = await setup();
    expect(shop.defaultLocale).toBe("bn");
    const page = await caller.landingPages.create({ templateId: shop.id, name: "বাংলা পেজ" });
    expect(page.locales).toEqual(["bn"]);

    const got = await caller.landingPages.get({ id: page.id });
    const bn = (got.draftContent as Record<string, C>).bn!;
    bn.hero!.headline = FIXTURE.headline;
    bn.hero!.subheadline = FIXTURE.sub;
    bn.hero!.primaryCta = { label: FIXTURE.cta, action: { kind: "section", sectionId: "order" } };
    (bn.products!.items as Array<Record<string, unknown>>)[0] = {
      image: null,
      name: FIXTURE.product,
      price: 1290,
      oldPrice: 1650,
      badge: "২২% ছাড়",
      rating: "5",
      cta: { label: "কার্টে যোগ করুন", action: { kind: "section", sectionId: "order" } },
    };
    bn.order!.cta = { label: FIXTURE.cta, action: { kind: "whatsapp", phone: "+8801711000000", message: "অর্ডার করতে চাই" } };
    const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });

    const reread = await caller.landingPages.get({ id: page.id });
    expect((reread.draftContent as Record<string, C>).bn!.hero!.headline).toBe(FIXTURE.headline);

    await caller.landingPages.setSlug({ id: page.id, slug: "bangla-shop" });
    await caller.landingPages.publish({ id: page.id, expectedRevision: saved.page.draftRevision });

    const live = await resolve("bangla-shop.pages.test");
    expect(live.kind).toBe("ok");
    if (live.kind !== "ok") return;
    expect(live.locale).toBe("bn");
    expect(live.content.hero!.headline).toBe(FIXTURE.headline);
    expect(live.content.hero!.subheadline).toBe(FIXTURE.sub);
    expect(live.seo.title).toBe("বাংলাদেশে অনলাইন শপিং | বাজার মার্ট");
    const html = render(live.spec, live.content, live.locale);
    for (const text of [FIXTURE.headline, FIXTURE.sub, FIXTURE.cta, FIXTURE.product, `৳${NBSP}১,২৯০`, "২২% ছাড়"]) {
      expect(html).toContain(text);
    }
    expect((await resolve("bangla-shop.pages.test", "en")).kind).toBe("not_found");

    // Add English (seeded from the template's English copy), republish.
    const g2 = await caller.landingPages.get({ id: page.id });
    const withEn = await caller.landingPages.setLocales({
      id: page.id,
      locales: ["bn", "en"],
      defaultLocale: "bn",
      expectedRevision: g2.page.draftRevision,
    });
    expect(withEn.locales).toEqual(["bn", "en"]);
    const g3 = await caller.landingPages.get({ id: page.id });
    const localized = g3.draftContent as Record<string, C>;
    expect(localized.bn!.hero!.headline).toBe(FIXTURE.headline);
    expect(localized.en!.hero!.headline).toBe("Your favourite products, now in your hands");
    localized.en!.order!.cta = { label: "Order on WhatsApp", action: { kind: "whatsapp", phone: "+8801711000000" } };
    const s3 = await caller.landingPages.saveDraft({ id: page.id, content: localized, expectedRevision: g3.page.draftRevision });
    await caller.landingPages.publish({ id: page.id, expectedRevision: s3.page.draftRevision });

    const english = await resolve("bangla-shop.pages.test", "en");
    expect(english.kind === "ok" && english.locale).toBe("en");
    expect(english.kind === "ok" && english.locales).toEqual(["bn", "en"]);
    const root = await resolve("bangla-shop.pages.test");
    expect(root.kind === "ok" && root.content.hero!.headline).toBe(FIXTURE.headline);
    // The default language is only served at "/"; unknown locales are not found.
    expect((await resolve("bangla-shop.pages.test", "bn")).kind).toBe("not_found");
    expect((await resolve("bangla-shop.pages.test", "fr")).kind).toBe("not_found");
  });

  it("can start an e-commerce page in English and removing a language drops its draft", async () => {
    const { caller, shop } = await setup();
    const page = await caller.landingPages.create({ templateId: shop.id, name: "English shop", locale: "en" });
    expect(page).toMatchObject({ locales: ["en"], defaultLocale: "en" });
    const both = await caller.landingPages.setLocales({ id: page.id, locales: ["en", "bn"], defaultLocale: "en", expectedRevision: 1 });
    const onlyBn = await caller.landingPages.setLocales({
      id: page.id,
      locales: ["bn"],
      defaultLocale: "bn",
      expectedRevision: both.draftRevision,
    });
    expect(onlyBn).toMatchObject({ locales: ["bn"], defaultLocale: "bn" });
    const row = await LandingPage.findById(page.id).lean();
    expect(Object.keys(row!.draftContent as object)).toEqual(["bn"]);
  });

  it("rejects saving content for a language that is not enabled, and cross-tenant language changes", async () => {
    const { caller, shop } = await setup();
    const page = await caller.landingPages.create({ templateId: shop.id, name: "Only bn" });
    const got = await caller.landingPages.get({ id: page.id });
    const bn = (got.draftContent as Record<string, C>).bn!;
    await expect(
      caller.landingPages.saveDraft({ id: page.id, content: { bn, en: bn }, expectedRevision: 1 }),
    ).rejects.toThrow(/not enabled/);
    const intruder = callerFor(authUserFor(await createMerchant()));
    await expect(
      intruder.landingPages.setLocales({ id: page.id, locales: ["en"], defaultLocale: "en", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps serving pages created before locales existed (legacy content = English)", async () => {
    const { caller } = await setup();
    const launch = (await caller.landingPages.templates()).find((t) => t.key === "launch")!;
    const page = await caller.landingPages.create({ templateId: launch.id, name: "Legacy" });
    // Rewrite the row into the pre-locale shape.
    const row = await LandingPage.findById(page.id).lean();
    const enContent = (row!.draftContent as Record<string, C>).en!;
    enContent.order!.cta = { label: "Order", action: { kind: "phone", phone: "+8801711000000" } };
    await LandingPage.collection.updateOne(
      { _id: row!._id },
      { $set: { draftContent: enContent }, $unset: { locales: 1, defaultLocale: 1 } },
    );
    const got = await caller.landingPages.get({ id: page.id });
    expect(got.page).toMatchObject({ locales: ["en"], defaultLocale: "en" });
    expect(Object.keys(got.draftContent)).toEqual(["en"]);
    await caller.landingPages.setSlug({ id: page.id, slug: "legacy-page" });
    await caller.landingPages.publish({ id: page.id, expectedRevision: got.page.draftRevision });
    const live = await resolve("legacy-page.pages.test");
    expect(live.kind === "ok" && live.locale).toBe("en");
  });
});
