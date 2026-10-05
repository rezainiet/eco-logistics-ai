import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CatalogProduct,
  type Locale,
  SECTION_TYPES,
  SYSTEM_TEMPLATES,
  type TemplateSpec,
  defaultContent,
  optionValueAvailable,
  parseTemplateSpec,
  resolveEditTarget,
  spotlightProduct,
  validateContent,
} from "@ecom/landing";
import { LandingRenderer, SECTION_COMPONENTS, assetEnv } from "@ecom/landing/react";
import { LandingPage, Order, Product } from "@ecom/db";
import { placeLandingOrder, type PlaceOrderInput } from "../src/lib/commerce/landing-orders.js";
import { catalogFor } from "../src/lib/landing/products.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { __resetTemplateCacheForTests, ensureSystemTemplates } from "../src/lib/landing/templates.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * productSpotlight@1 + Buy now. The section shows one live catalog product
 * (never a copy of it) and its buttons carry `data-lp-cart-buy`, which the
 * public page's existing cart turns into "add, then open checkout". The
 * order itself is the existing placeLandingOrder, re-checked by the server.
 */

const env = assetEnv("https://api.example/api/landing-assets");
type Content = Record<string, Record<string, unknown>>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** BD Modern Shop on theme@2 with a spotlight after the hero, optionally with the mobile order bar. */
function spotSpec(opts: { bar?: boolean; motion?: boolean } = {}): TemplateSpec {
  const s = clone(SYSTEM_TEMPLATES.find((t) => t.key === "bd-modern-shop")!.spec);
  s.sections.find((x) => x.type === "theme")!.typeVersion = 2;
  const at = s.sections.findIndex((x) => x.id === "hero") + 1;
  s.sections.splice(at, 0, { id: "spotlight", type: "productSpotlight", typeVersion: 1 });
  if (opts.bar) s.sections.push({ id: "orderbar", type: "mobileActionBar", typeVersion: 1 });
  const parsed = parseTemplateSpec(s);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.spec;
}

function contentWith(s: TemplateSpec, locale: Locale, patch: Content): Content {
  const c = defaultContent(s, locale) as Content;
  for (const [id, values] of Object.entries(patch)) c[id] = { ...c[id], ...values };
  return c;
}

function render(
  s: TemplateSpec,
  content: unknown,
  opts: { locale?: Locale; editable?: boolean; catalog?: CatalogProduct[] | undefined } = {},
): string {
  return renderToStaticMarkup(
    createElement(LandingRenderer, {
      spec: s,
      content,
      locale: opts.locale ?? "en",
      env: { ...env, editable: !!opts.editable, ...(opts.catalog ? { catalog: opts.catalog } : {}) },
    }),
  );
}

/** Just the spotlight section's markup. */
function spotHtml(html: string): string {
  const start = html.indexOf('<section id="spotlight"');
  if (start < 0) return "";
  // Money is "৳ 300" with a non-breaking space; compare on plain spaces.
  return html.slice(start, html.indexOf("</section>", start) + 10).replace(/ /g, " ");
}

const ID = "6ab73cca06587711398245c7";
const TEE = "6ab73cca06587711398245c8";
const RED_M = "6ab73cca06587711398245d1";
const RED_L = "6ab73cca06587711398245d2";
const BLUE_M = "6ab73cca06587711398245d3";
const BLUE_L = "6ab73cca06587711398245d4";

const mug: CatalogProduct = {
  id: ID,
  name: "Ceramic Mug",
  description: "Holds 350 ml.\nDishwasher safe.",
  imageAssetId: "6ab73cca06587711398245f0",
  price: 300,
  compareAtPrice: 400,
  currency: "BDT",
  available: true,
  stockStatus: "in_stock",
  maxQuantity: 10,
  badge: null,
  ctaText: null,
  featured: false,
};

const tee: CatalogProduct = {
  ...mug,
  id: TEE,
  name: "Cotton Tee",
  price: 450,
  compareAtPrice: null,
  options: [
    { name: "Color", values: ["Red", "Blue"] },
    { name: "Size", values: ["M", "L"] },
  ],
  variants: [
    { id: RED_M, optionValues: ["Red", "M"], label: "Red / M", price: 500, compareAtPrice: null, imageAssetId: null, available: true, stockStatus: "in_stock", maxQuantity: 5 },
    { id: RED_L, optionValues: ["Red", "L"], label: "Red / L", price: 550, compareAtPrice: null, imageAssetId: null, available: true, stockStatus: "low_stock", maxQuantity: 1 },
    { id: BLUE_M, optionValues: ["Blue", "M"], label: "Blue / M", price: 450, compareAtPrice: 600, imageAssetId: null, available: false, stockStatus: "out_of_stock", maxQuantity: 0 },
    { id: BLUE_L, optionValues: ["Blue", "L"], label: "Blue / L", price: 450, compareAtPrice: null, imageAssetId: null, available: false, stockStatus: "out_of_stock", maxQuantity: 0 },
  ],
  priceFrom: true,
};

const soldOut: CatalogProduct = { ...mug, available: false, stockStatus: "out_of_stock", maxQuantity: 0 };

// ── A. Section definition ───────────────────────────────────────────────────

describe("productSpotlight@1 definition", () => {
  it("is registered with a component, holds presentation only (no product name, price or stock fields)", () => {
    const def = SECTION_TYPES.get("productSpotlight@1")!;
    expect(def).toMatchObject({ type: "productSpotlight", version: 1, visual: true });
    expect(def.fields.map((f) => f.key)).toEqual(["eyebrow", "tagline", "highlights", "ctaLabel", "note", "showDescription", "layout"]);
    expect(def.fields.map((f) => f.key).join(" ")).not.toMatch(/name|price|stock|product|variant|image/i);
    expect(SECTION_COMPONENTS["productSpotlight@1"]).toBeTypeOf("function");
  });

  it("validates in a template; the button text is required to publish; limits are enforced", () => {
    const s = spotSpec({ bar: true });
    const blank = defaultContent(s, "en") as Content;
    expect(blank.spotlight).toEqual({
      eyebrow: "",
      tagline: "",
      highlights: [],
      ctaLabel: "Order now",
      note: "",
      showDescription: false,
      layout: "imageLeft",
    });
    expect(validateContent(s, contentWith(s, "en", { spotlight: { ctaLabel: "" } }), "draft").ok).toBe(true);
    expect(validateContent(s, contentWith(s, "en", { spotlight: { ctaLabel: "" } }), "publish").issues).toContainEqual({
      path: "spotlight.ctaLabel",
      message: "Order button text is required",
    });
    const tooMany = { highlights: Array.from({ length: 5 }, () => ({ icon: "check", text: "x" })) };
    for (const bad of [{ ctaLabel: "x".repeat(41) }, { layout: "sideways" }, tooMany, { highlights: [{ icon: "skull", text: "x" }] }]) {
      expect(validateContent(s, contentWith(s, "en", { spotlight: bad }), "draft").ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the five system templates are untouched: none uses the spotlight", () => {
    for (const t of SYSTEM_TEMPLATES) expect(t.spec.sections.some((x) => x.type === "productSpotlight")).toBe(false);
  });

  it("the spotlight is the featured product, else the first linked one; nothing when none is linked", () => {
    expect(spotlightProduct(undefined)).toBeNull();
    expect(spotlightProduct([])).toBeNull();
    expect(spotlightProduct([tee, mug])).toBe(tee);
    expect(optionValueAvailable(tee, 0, "Red")).toBe(true);
    expect(optionValueAvailable(tee, 0, "Blue")).toBe(false);
    expect(optionValueAvailable(tee, 1, "L")).toBe(true);
    expect(optionValueAvailable(tee, 1, "XL")).toBe(false);
    expect(optionValueAvailable(mug, 0, "Red")).toBe(false);
  });
});

// ── B. Rendering live data ──────────────────────────────────────────────────

describe("rendering the live product", () => {
  const s = spotSpec();

  it("a simple product: live name, price, old price, discount, stock and a Buy now button", () => {
    const html = spotHtml(render(s, defaultContent(s, "en"), { catalog: [mug] }));
    expect(html).toContain(`data-lp-spotlight="${ID}"`);
    expect(html).toContain(">Ceramic Mug</h2>");
    expect(html).toMatch(/data-lp-spotlight-price=""[^>]*><span[^>]*>৳ 300<\/span><span[^>]*line-through[^>]*>৳ 400<\/span>/);
    expect(html).toContain(">-25%<");
    expect(html).toContain('data-lp-stock="in"');
    expect(html).toContain("In stock");
    const buy = [...html.matchAll(/<button type="button" data-lp-cart-buy="([^"]+)"([^>]*)>/g)];
    expect(buy).toHaveLength(1);
    expect(buy[0]![1]).toBe(ID);
    expect(buy[0]![2]).not.toContain("disabled");
    expect(html).toContain(">Order now</span>");
    // No option chips and no description unless asked.
    expect(html).not.toContain("data-lp-buy-option");
    expect(html).not.toContain("Dishwasher safe");
  });

  it("the button text: merchant's text, else the product's Products-tab text, else the default", () => {
    const withRef = { ...mug, ctaText: "Buy this mug" };
    expect(spotHtml(render(s, contentWith(s, "en", { spotlight: { ctaLabel: "Get yours" } }), { catalog: [withRef] }))).toContain(">Get yours</span>");
    expect(spotHtml(render(s, contentWith(s, "en", { spotlight: { ctaLabel: "  " } }), { catalog: [withRef] }))).toContain(">Buy this mug</span>");
    expect(spotHtml(render(s, contentWith(s, "en", { spotlight: { ctaLabel: "" } }), { catalog: [mug] }))).toContain(">Order now</span>");
  });

  it("price changes in the catalog show up immediately: nothing is copied into the content", () => {
    const content = defaultContent(s, "en");
    const before = spotHtml(render(s, content, { catalog: [mug] }));
    const after = spotHtml(render(s, content, { catalog: [{ ...mug, name: "Mug v2", price: 350, compareAtPrice: null }] }));
    expect(before).toContain("৳ 300");
    expect(after).toContain(">Mug v2</h2>");
    expect(after).toContain("৳ 350");
    expect(after).not.toMatch(/line-through|-\d+%/);
    expect(JSON.stringify(content)).not.toMatch(/Ceramic Mug|300|in_stock/);
  });

  it("low stock and out of stock: no Buy now on a product that can't be bought", () => {
    const low = spotHtml(render(s, defaultContent(s, "en"), { catalog: [{ ...mug, stockStatus: "low_stock" }] }));
    expect(low).toContain('data-lp-stock="low"');
    expect(low).toContain("Low stock");
    const out = spotHtml(render(s, defaultContent(s, "en"), { catalog: [soldOut] }));
    expect(out).toContain('data-lp-stock="out"');
    expect(out).not.toContain("data-lp-cart-buy");
    expect(out).toMatch(/<button type="button" disabled="" aria-disabled="true"[^>]*>Out of stock<\/button>/);
    expect(out).not.toContain("-25%"); // no discount badge on something you can't buy
  });

  it("variants (two dimensions): 'From' price, every option value, unavailable values disabled and struck through", () => {
    const html = spotHtml(render(s, defaultContent(s, "en"), { catalog: [tee] }));
    expect(html).toMatch(/>From ৳ 450<\/span>/);
    // The cheapest variant (Blue / M, 450) has an old price of 600.
    expect(html).toContain("৳ 600");
    expect(html).toContain("<legend");
    const chips = [...html.matchAll(/<button type="button" data-lp-cart-buy="([^"]+)" data-lp-buy-option="(\d)" data-lp-buy-value="([^"]+)"( disabled="")?/g)].map(
      (m) => [m[2], m[3], !m[4]],
    );
    expect(chips).toEqual([
      ["0", "Red", true],
      ["0", "Blue", false],
      ["1", "M", true],
      ["1", "L", true],
    ]);
    expect(html).toMatch(/disabled="" class="[^"]*line-through[^"]*">Blue<\/button>/);
    expect([...html.matchAll(new RegExp(`data-lp-cart-buy="${TEE}"`, "g"))]).toHaveLength(5); // 4 chips + the button
  });

  it("one dimension, and a sold-out variant product: all chips disabled, no Buy now", () => {
    const cap: CatalogProduct = {
      ...tee,
      options: [{ name: "Color", values: ["Black", "White"] }],
      variants: [
        { ...tee.variants![0]!, optionValues: ["Black"], label: "Black" },
        { ...tee.variants![2]!, optionValues: ["White"], label: "White" },
      ],
      priceFrom: false,
    };
    const html = spotHtml(render(s, defaultContent(s, "en"), { catalog: [cap] }));
    expect(html).toMatch(/data-lp-buy-value="Black"(?! disabled)/);
    expect(html).toMatch(/data-lp-buy-value="White" disabled=""/);
    expect(html).not.toContain(">From ");
    const gone = spotHtml(render(s, defaultContent(s, "en"), { catalog: [{ ...cap, available: false, stockStatus: "out_of_stock", maxQuantity: 0 }] }));
    expect(gone).not.toMatch(/data-lp-cart-buy="[^"]+"(?! data-lp-buy-option)[^>]*>/);
    expect([...gone.matchAll(/data-lp-buy-value="[^"]+"( disabled="")/g)]).toHaveLength(2);
    expect(gone).toContain(">Out of stock</button>");
  });

  it("merchant text: eyebrow, supporting text, highlights, note, description and layout", () => {
    const content = contentWith(s, "en", {
      spotlight: {
        eyebrow: "Best seller",
        tagline: "Made in Dhaka.",
        highlights: [{ icon: "shield", text: "1 year warranty" }, { icon: "truck", text: "Free delivery" }],
        note: "Cash on delivery",
        showDescription: true,
        layout: "imageRight",
      },
    });
    const html = spotHtml(render(s, content, { catalog: [mug] }));
    for (const text of ["Best seller", "Made in Dhaka.", "1 year warranty", "Free delivery", "Cash on delivery", "Dishwasher safe"]) expect(html).toContain(text);
    expect(html).toContain("md:order-2");
    expect(spotHtml(render(s, defaultContent(s, "en"), { catalog: [mug] }))).not.toContain("md:order-2");
  });

  it("no linked product: nothing on the public page, a how-to placeholder in the editor", () => {
    for (const catalog of [undefined, []]) {
      expect(render(s, defaultContent(s, "en"), { catalog })).toContain('<section id="spotlight"');
      expect(spotHtml(render(s, defaultContent(s, "en"), { catalog }))).not.toMatch(/data-lp-spotlight|button/);
      const editor = spotHtml(render(s, defaultContent(s, "en"), { catalog, editable: true }));
      expect(editor).toContain("data-lp-spotlight-empty");
      expect(editor).toContain("Link a product on the Products tab");
    }
  });

  it("is mobile-first: one column, full-width tap-sized button, two columns from md", () => {
    const html = spotHtml(render(s, defaultContent(s, "en"), { catalog: [tee] }));
    expect(html).toContain('class="grid items-start gap-6 md:grid-cols-2');
    expect(html).toMatch(/data-lp-cart-buy="[^"]+" class="[^"]*min-h-14 w-full[^"]*md:w-auto/);
    expect(html).toMatch(/data-lp-buy-value="Red" class="[^"]*min-h-11 min-w-11/);
    // Theme colours only (no hard-coded brand colours on the main surfaces).
    expect(html).toContain("bg-[var(--lp-primary)]");
    expect(html).not.toMatch(/bg-(?:red|blue|green|indigo|emerald)-\d/);
  });
});

// ── C. Mobile order bar → Buy now ───────────────────────────────────────────

describe("mobile order bar pointed at the spotlight", () => {
  const s = spotSpec({ bar: true });
  const barHtml = (html: string) => html.slice(html.indexOf('<section id="orderbar"'));
  const toSpot = { primaryCta: { label: "Order now", action: { kind: "section", sectionId: "spotlight" } } };
  const toProducts = { primaryCta: { label: "Order now", action: { kind: "section", sectionId: "products" } } };

  it("targets the spotlight: the bar's order button becomes Buy now for that product, still a #spotlight link without JavaScript", () => {
    const html = barHtml(render(s, contentWith(s, "en", { orderbar: toSpot }), { catalog: [mug] }));
    expect(html).toMatch(new RegExp(`<a href="#spotlight"[^>]*data-lp-cart-buy="${ID}"`));
  });

  it("variant products too (the page opens the option picker); never for an unavailable product, another section, or no catalog", () => {
    expect(barHtml(render(s, contentWith(s, "en", { orderbar: toSpot }), { catalog: [tee] }))).toContain(`data-lp-cart-buy="${TEE}"`);
    for (const [patch, catalog] of [
      [toSpot, [soldOut]],
      [toSpot, []],
      [toSpot, undefined],
      [toProducts, [mug]],
    ] as const) {
      const html = barHtml(render(s, contentWith(s, "en", { orderbar: patch }), { catalog: catalog as CatalogProduct[] | undefined }));
      expect(html).toContain("<a href=\"#");
      expect(html).not.toContain("data-lp-cart-buy");
    }
  });

  it("the spotlight is a valid target for the bar and publishes", () => {
    const c = contentWith(s, "en", { orderbar: toSpot });
    expect(validateContent(s, c, "publish").issues.filter((i) => i.path.startsWith("orderbar") || i.path.startsWith("spotlight"))).toEqual([]);
  });
});

// ── D. Motion, editor, language, safety ─────────────────────────────────────

describe("motion, click-to-edit, Bangla and escaping", () => {
  const s = spotSpec({ bar: true });

  it("reveals with the page's motion setting; never in the editor; markup otherwise identical", () => {
    const off = render(s, contentWith(s, "en", { theme: { motion: "none" } }), { catalog: [tee] });
    for (const motion of ["subtle", "lively"] as const) {
      const on = render(s, contentWith(s, "en", { theme: { motion } }), { catalog: [tee] });
      expect(on).toMatch(/<section id="spotlight" data-section-type="productSpotlight"[^>]*data-lp-reveal=""/);
      expect(on.replace(/\s(?:data-lp-motion="[^"]*"|data-lp-reveal="[^"]*")/g, "")).toBe(off);
      expect(render(s, contentWith(s, "en", { theme: { motion } }), { catalog: [tee], editable: true })).not.toMatch(/data-lp-reveal|data-lp-motion/);
    }
    expect(off).not.toMatch(/data-lp-reveal/);
  });

  it("every merchant-written element opens its own field; live product data is not editable", () => {
    const content = contentWith(s, "en", {
      spotlight: { eyebrow: "New", tagline: "Soft", highlights: [{ icon: "check", text: "A" }, { icon: "star", text: "B" }], note: "COD" },
    });
    for (const catalog of [[mug], [soldOut]]) {
      const html = spotHtml(render(s, content, { catalog, editable: true }));
      const paths = [...html.matchAll(/data-lp-field="([^"]+)"/g)].map((m) => m[1]!);
      expect(paths).toEqual(["eyebrow", "tagline", "highlights.0", "highlights.1", "ctaLabel", "note"]);
      for (const p of paths) expect(resolveEditTarget(s, "en", `spotlight.${p}`)).toMatchObject({ kind: "field", sectionId: "spotlight" });
      expect(html).not.toMatch(/<h2[^>]*data-lp-field/);
    }
  });

  it("Bangla page: Bangla labels and Bangla numerals for the live price", () => {
    const content = contentWith(s, "bn", { spotlight: { ctaLabel: "এখনই কিনুন" }, theme: { numerals: "bn" } });
    const html = spotHtml(render(s, content, { locale: "bn", catalog: [tee] }));
    expect(html).toContain(">এখনই কিনুন</span>");
    expect(html).toContain(">শুরু ৳ ৪৫০</span>");
    expect(html).toContain("২৫% ছাড়");
    expect(html).toContain("শুরু");
    const out = spotHtml(render(s, contentWith(s, "bn", {}), { locale: "bn", catalog: [soldOut] }));
    expect(out).toContain("স্টকে নেই");
    const empty = spotHtml(render(s, contentWith(s, "bn", {}), { locale: "bn", editable: true }));
    expect(empty).toContain("Products ট্যাবে");
  });

  it("escapes merchant text and product data alike", () => {
    const xss = '<img src=x onerror=alert(1)>"';
    const content = contentWith(s, "en", { spotlight: { eyebrow: xss, tagline: xss, note: xss, ctaLabel: xss, highlights: [{ icon: "check", text: xss }], showDescription: true } });
    const evil: CatalogProduct = {
      ...tee,
      name: xss,
      description: xss,
      badge: xss,
      options: [{ name: xss, values: [xss, "Blue"] }],
      variants: [{ ...tee.variants![0]!, optionValues: [xss] }],
    };
    const html = render(s, content, { catalog: [evil] });
    expect(html).not.toMatch(/<img src=x|onerror=alert\(1\)>/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;");
    // Attribute values are quoted and escaped too.
    expect(html).toContain('data-lp-buy-value="&lt;img src=x onerror=alert(1)&gt;&quot;"');
    // A tampered stored id never ends up in markup: the product comes from the catalog only.
    const tampered = contentWith(s, "en", { spotlight: { productId: "javascript:alert(1)" } as Record<string, unknown> });
    expect(validateContent(s, tampered, "draft").ok).toBe(false);
    expect(render(s, tampered, { catalog: [mug] })).not.toContain("javascript:");
  });
});

// ── E. Live catalog, merchant isolation and order revalidation (database) ──

const customer = { name: "রহিম", phone: "01712345678", address: "বাড়ি ১২, রোড ৫, ধানমন্ডি", district: "ঢাকা" };
let seq = 0;
const key = () => `spot-${Date.now()}-${++seq}-abcdefgh`;

const TEE_INPUT = {
  options: [
    { name: "Color", values: ["Red", "Blue"] },
    { name: "Size", values: ["M", "L"] },
  ],
  variants: [
    { optionValues: ["Red", "M"], price: 500, initialStock: 5 },
    { optionValues: ["Red", "L"], price: 550, initialStock: 1 },
    { optionValues: ["Blue", "M"], initialStock: 0 },
    { optionValues: ["Blue", "L"], compareAtPrice: 600, initialStock: 3 },
  ],
};

describe("spotlight on a published page (database)", () => {
  beforeAll(ensureDb);
  afterAll(disconnectDb);
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });

  /** A published BD Modern Shop page linking a simple mug and a variant tee (featured). */
  async function shop() {
    await ensureSystemTemplates();
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const mugP = await caller.products.create({ name: "Mug", price: 300, compareAtPrice: 400, initialStock: 4 });
    const teeP = await caller.products.create({ name: "Tee", price: 450, variants: TEE_INPUT });
    const tpl = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
    const page = await caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
    const got = await caller.landingPages.get({ id: page.id });
    const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
    bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
    const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
    const linked = await caller.landingPages.setProducts({
      id: page.id,
      expectedRevision: saved.page.draftRevision,
      products: [{ productId: mugP.id }, { productId: teeP.id, featured: true, ctaText: "Get the tee" }],
    });
    const slug = `spot-${seq++}-shop`;
    await caller.landingPages.setSlug({ id: page.id, slug });
    await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
    const host = `${slug}.localhost`;
    const resolved = await resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });
    if (resolved.kind !== "ok") throw new Error("not published");
    const variant = (label: string) => teeP.variants.find((x) => x.label === label)!;
    const place = (items: PlaceOrderInput["items"], extra: Partial<PlaceOrderInput> = {}) =>
      placeLandingOrder({ host, locale: null, idempotencyKey: key(), items, customer, deliveryOptionId: resolved.commerce!.delivery[0]!.id, ...extra });
    return { m, caller, page, mugP, teeP, variant, place, host, resolved };
  }

  it("the public catalog puts the featured product first, so the spotlight shows it with live data", async () => {
    const { resolved, teeP } = await shop();
    const catalog = resolved.commerce!.products;
    const spot = spotlightProduct(catalog)!;
    expect(spot.id).toBe(teeP.id);
    expect(spot).toMatchObject({ name: "Tee", price: 450, priceFrom: true, ctaText: "Get the tee", available: true });
    const s = spotSpec({ bar: true });
    const html = render(s, contentWith(s, "en", { spotlight: { ctaLabel: "" }, orderbar: { primaryCta: { label: "Order", action: { kind: "section", sectionId: "spotlight" } } } }), {
      catalog,
    });
    expect(spotHtml(html)).toContain(">Get the tee</span>");
    expect(spotHtml(html)).toMatch(/data-lp-buy-value="Blue"(?! disabled)/); // Blue / L in stock
    expect(html.slice(html.indexOf('<section id="orderbar"'))).toContain(`data-lp-cart-buy="${teeP.id}"`);
  });

  it("stock and price edits reach the spotlight without republishing; archived products drop out; inactive ones are unavailable", async () => {
    const { caller, page, mugP, teeP, m } = await shop();
    const stored = (await LandingPage.findById(page.id).lean())!.draftProducts as Array<{ productId: Types.ObjectId; featured?: boolean }>;
    await caller.products.update({ id: mugP.id, price: 333 });
    let catalog = await catalogFor(m._id, stored);
    expect(catalog.find((p) => p.id === mugP.id)!.price).toBe(333);
    await Product.updateOne({ _id: teeP.id }, { $set: { status: "inactive" } });
    catalog = await catalogFor(m._id, stored);
    expect(spotlightProduct(catalog)).toMatchObject({ id: teeP.id, available: false, stockStatus: "out_of_stock" });
    await Product.updateOne({ _id: teeP.id }, { $set: { status: "archived" } });
    catalog = await catalogFor(m._id, stored);
    expect(spotlightProduct(catalog)!.id).toBe(mugP.id);
  });

  it("merchant isolation: another merchant's product can't be linked, and never appears in this page's catalog", async () => {
    const a = await shop();
    const other = await createMerchant();
    const otherCaller = callerFor(authUserFor(other));
    const theirs = await otherCaller.products.create({ name: "Theirs", price: 1, initialStock: 9 });
    const cur = await a.caller.landingPages.get({ id: a.page.id });
    await expect(
      a.caller.landingPages.setProducts({ id: a.page.id, expectedRevision: cur.page.draftRevision, products: [{ productId: theirs.id, featured: true }] }),
    ).rejects.toThrow(/Product not found/);
    // Even a forged ref is filtered by merchant.
    const forged = await catalogFor(a.m._id, [{ productId: new Types.ObjectId(theirs.id), featured: true }, { productId: new Types.ObjectId(a.mugP.id) }]);
    expect(forged.map((p) => p.id)).toEqual([a.mugP.id]);
    // And it can't be ordered from this page.
    expect(await a.place([{ productId: theirs.id, quantity: 1 }])).toMatchObject({ ok: false, code: "not_on_page" });
  });

  it("Buy now orders go through the same server checks: variant required, unavailable refused, browser price ignored, stock enforced", async () => {
    const { place, teeP, mugP, variant } = await shop();
    // No variant chosen for a variant product.
    expect(await place([{ productId: teeP.id, quantity: 1 }])).toMatchObject({ ok: false, code: "invalid_request" });
    // A sold-out variant.
    expect(await place([{ productId: teeP.id, variantId: variant("Blue / M").id, quantity: 1 }])).toMatchObject({ ok: false, code: "unavailable" });
    // A tampered price.
    expect(await place([{ productId: mugP.id, quantity: 1, unitPrice: 1 }])).toMatchObject({ ok: false, code: "price_changed", prices: [{ productId: mugP.id, price: 300 }] });
    // More than the stock.
    expect(await place([{ productId: teeP.id, variantId: variant("Red / L").id, quantity: 2 }])).toMatchObject({ ok: false, code: "insufficient_stock", available: 1 });
    // The legitimate Buy now order, priced by the server.
    const ok = await place([{ productId: teeP.id, variantId: variant("Red / M").id, quantity: 1, unitPrice: 500 }]);
    if (!ok.ok) throw new Error(JSON.stringify(ok));
    expect(ok.items).toEqual([{ productId: teeP.id, variantId: variant("Red / M").id, variantLabel: "Red / M", name: "Tee (Red / M)", quantity: 1, price: 500 }]);
    expect((await Order.countDocuments({})) >= 1).toBe(true);
  });

  it("an out-of-stock simple product can't be bought, whatever the browser sends", async () => {
    const { place, mugP } = await shop();
    await Product.updateOne({ _id: mugP.id }, { $set: { "inventory.onHand": 0 } });
    expect(await place([{ productId: mugP.id, quantity: 1 }])).toMatchObject({ ok: false });
    const r = await place([{ productId: mugP.id, quantity: 1 }]);
    expect(["unavailable", "insufficient_stock"]).toContain((r as { code: string }).code);
  });
});
