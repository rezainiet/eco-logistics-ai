import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_MESSAGE_SOURCE,
  SYSTEM_TEMPLATES,
  type Locale,
  type TemplateSpec,
  defaultContent,
  isEditPath,
  parsePreviewMessage,
  parsePreviewSelect,
  resolveEditTarget,
  templateLocales,
} from "@ecom/landing";
import { LandingRenderer, assetEnv } from "@ecom/landing/react";

/**
 * Click-to-edit: the editor preview tags each rendered element with the
 * schema path it shows; the editor resolves a clicked path against the
 * template schema. These tests pin both halves together for every system
 * template and language, so a component whose path drifts from the schema
 * fails here instead of silently opening the wrong field.
 */

const env = assetEnv("https://api.example/api/landing-assets");

function spec(key: string): TemplateSpec {
  return JSON.parse(JSON.stringify(SYSTEM_TEMPLATES.find((t) => t.key === key)!.spec)) as TemplateSpec;
}

function render(s: TemplateSpec, locale: Locale, editable: boolean, content: unknown = defaultContent(s, locale)): string {
  return renderToStaticMarkup(createElement(LandingRenderer, { spec: s, content, locale, env: { ...env, editable } }));
}

const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "area", "wbr", "col", "embed"]);

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Full schema path → text of every element tagged with it (in document order). */
function editTargets(html: string): Array<{ path: string; tag: string; text: string }> {
  const out: Array<{ path: string; tag: string; text: string }> = [];
  const stack: Array<{ tag: string; section?: string; field?: string; text: string[] }> = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const currentSection = () => [...stack].reverse().find((e) => e.section)?.section;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      for (const e of stack) if (e.section || e.field) e.text.push(decode(m[5]));
      continue;
    }
    const [, close, tag, attrs, selfClose] = m;
    const t = tag!.toLowerCase();
    if (close) {
      const e = stack.pop();
      if (e && (e.field || e.section)) {
        const path = e.field ? `${currentSection() ?? e.section}.${e.field}` : e.section!;
        out.push({ path, tag: e.tag, text: e.text.join("").trim() });
      }
      continue;
    }
    const section = /data-lp-section="([^"]*)"/.exec(attrs!)?.[1];
    const field = /data-lp-field="([^"]*)"/.exec(attrs!)?.[1];
    if (VOID.has(t) || selfClose) {
      if (field) out.push({ path: `${currentSection()}.${field}`, tag: t, text: "" });
      continue;
    }
    stack.push({ tag: t, section, field, text: [] });
  }
  return out;
}

describe("click-to-edit mapping", () => {
  for (const tpl of SYSTEM_TEMPLATES) {
    for (const locale of templateLocales(tpl.spec)) {
      it(`${tpl.key} (${locale}): every tagged element resolves to an editable field or section`, () => {
        const s = spec(tpl.key);
        const targets = editTargets(render(s, locale, true));
        expect(targets.length).toBeGreaterThan(15);
        const bad = targets
          .map((t) => ({ ...t, r: resolveEditTarget(s, locale, t.path) }))
          .filter((t) => t.r.kind === "invalid");
        expect(bad.map((b) => b.path)).toEqual([]);
        // Locked fields must never be tagged as editable targets.
        const locked = targets.filter((t) => resolveEditTarget(s, locale, t.path).kind === "locked").map((t) => t.path);
        expect(locked).toEqual([]);
      });
    }
  }

  it("public pages carry no editor attributes", () => {
    for (const tpl of SYSTEM_TEMPLATES) {
      for (const locale of templateLocales(tpl.spec)) {
        const html = render(spec(tpl.key), locale, false);
        expect(html).not.toContain("data-lp-field");
        expect(html).not.toContain("data-lp-section");
      }
    }
  });

  it("maps BD Modern Shop (Bangla) elements to the exact fields", () => {
    const s = spec("bd-modern-shop");
    const t = editTargets(render(s, "bn", true));
    const text = (path: string) => t.find((x) => x.path === path)?.text;
    expect(text("hero.headline")).toBe("আপনার পছন্দের পণ্য এখন হাতের মুঠোয়");
    expect(text("hero.subheadline")).toContain("ক্যাশ অন ডেলিভারি");
    expect(text("hero.primaryCta")).toBe("এখনই কিনুন");
    expect(text("hero.secondaryCta")).toBe("আজকের অফার");
    expect(text("header.brandName")).toBe("বাজার মার্ট");
    expect(text("header.links.0")).toBeTruthy();
    expect(text("products.items.0.name")).toBe("প্রিমিয়াম কটন শার্ট");
    expect(text("products.items.0.price")).toBe("৳\u00A0১,২৯০");
    expect(text("products.items.0.oldPrice")).toBe("৳\u00A0১,৬৫০");
    expect(text("products.items.1.name")).toBeTruthy();
    expect(t.some((x) => x.path === "products.items.0.image")).toBe(true);
    expect(t.some((x) => x.path === "products.items.0")).toBe(true); // whole card
    expect(text("categories.items.0.name")).toBeTruthy();
    expect(t.some((x) => x.path === "reviews.items.0")).toBe(true);
    expect(text("reviews.items.0.quote")).toBeTruthy();
    expect(text("footer.brandName")).toBe("বাজার মার্ট");
    expect(text("order.cta")).toBe("WhatsApp-এ অর্ডার করুন");
    expect(text("offer.price")).toMatch(/^৳/);
    expect(text("delivery.zones.0.charge")).toMatch(/^৳/);
    expect(t.some((x) => x.path === "hero.image")).toBe(true);
  });

  it("maps an uploaded logo and product image to their fields", () => {
    const s = spec("bd-modern-shop");
    const content = defaultContent(s, "bn") as Record<string, Record<string, unknown>>;
    const asset = { assetId: "a".repeat(24), alt: "" };
    content.header!.logo = asset;
    (content.products!.items as Array<Record<string, unknown>>)[0]!.image = asset;
    const paths = editTargets(render(s, "bn", true, content)).map((x) => x.path);
    expect(paths).toContain("header.logo");
    expect(paths).toContain("products.items.0.image");
    expect(resolveEditTarget(s, "bn", "header.logo")).toMatchObject({ kind: "field", label: "Shop header → Logo" });
  });

  it("maps the English copy of the same template to the same paths", () => {
    const s = spec("bd-modern-shop");
    const t = editTargets(render(s, "en", true));
    const text = (path: string) => t.find((x) => x.path === path)?.text;
    expect(text("hero.headline")).toBe("Your favourite products, now in your hands");
    expect(text("hero.primaryCta")).toBe("Shop now");
    expect(text("products.items.0.price")).toBe("৳\u00A01,290");
  });

  it("maps BD Premium Brand and the classic templates' key elements", () => {
    const brand = editTargets(render(spec("bd-premium-brand"), "bn", true)).map((x) => x.path);
    for (const p of ["hero.headline", "hero.cta", "hero.image", "collection.items.0.name", "bestsellers.items.0.price", "reviews.items.0.quote", "footer.brandName"]) {
      expect(brand).toContain(p);
    }
    for (const key of ["launch", "showcase", "local-service"]) {
      const s = spec(key);
      const paths = editTargets(render(s, "en", true)).map((x) => x.path);
      const hero = s.sections.find((x) => x.type === "hero")!.id;
      expect(paths).toContain(`${hero}.headline`);
      expect(paths).toContain(`${hero}.primaryCta`);
    }
  });
});

describe("resolveEditTarget", () => {
  const s = spec("bd-modern-shop");

  it("labels fields with a readable breadcrumb", () => {
    expect(resolveEditTarget(s, "bn", "hero.headline")).toMatchObject({ kind: "field", sectionId: "hero", label: "Promotional hero → Headline" });
    const price = resolveEditTarget(s, "bn", "products.items.2.price");
    expect(price).toMatchObject({ kind: "field", sectionId: "products" });
    expect((price as { label: string }).label).toBe("Products → Product 3 → Price (BDT)");
    expect(resolveEditTarget(s, "bn", "products.items.2")).toMatchObject({ kind: "field" });
    expect(resolveEditTarget(s, "bn", "footer")).toMatchObject({ kind: "section", sectionId: "footer" });
  });

  it("refuses locked fields and page settings", () => {
    // The order band's style is fixed by the template.
    expect(resolveEditTarget(s, "bn", "order.style").kind).toBe("locked");
    expect(resolveEditTarget(s, "bn", "theme").kind).toBe("locked");
    expect(resolveEditTarget(s, "bn", "seo.title").kind).toBe("locked");
  });

  it("rejects paths that do not exist in the schema", () => {
    for (const bad of [
      "",
      "nope.headline",
      "hero.nope",
      "hero.headline.0",
      "products.items.x.name",
      "products.items.999.name",
      "products.items.0.nope",
      "hero.__proto__",
      "constructor",
      "../hero",
      "hero..headline",
      "Hero.headline",
      "a.b.c.d.e.f.g.h",
      "x".repeat(300),
    ]) {
      expect(resolveEditTarget(s, "bn", bad).kind, bad).toBe("invalid");
    }
    expect(resolveEditTarget(s, "bn", 42).kind).toBe("invalid");
    expect(resolveEditTarget(s, "bn", { path: "hero" }).kind).toBe("invalid");
  });
});

describe("preview click-to-edit protocol", () => {
  const base = { source: PREVIEW_MESSAGE_SOURCE };

  it("accepts only well-formed select messages", () => {
    expect(parsePreviewSelect({ ...base, type: "select", path: "hero.headline", locale: "bn" })).toMatchObject({ path: "hero.headline", locale: "bn" });
    expect(parsePreviewSelect({ ...base, type: "select", path: "hero.headline", locale: "fr" })).toBeNull();
    expect(parsePreviewSelect({ ...base, type: "select", path: "<img onerror=x>", locale: "bn" })).toBeNull();
    expect(parsePreviewSelect({ ...base, type: "select", path: "javascript:alert(1)", locale: "en" })).toBeNull();
    expect(parsePreviewSelect({ source: "other", type: "select", path: "hero", locale: "en" })).toBeNull();
    expect(parsePreviewSelect({ ...base, type: "render", path: "hero", locale: "en" })).toBeNull();
    expect(parsePreviewSelect(null)).toBeNull();
  });

  it("sanitises the editor selection carried on render messages", () => {
    const s = spec("bd-modern-shop");
    const ok = parsePreviewMessage({ ...base, type: "render", spec: s, content: {}, locale: "bn", edit: { selected: "hero.headline" } });
    expect(ok?.edit).toEqual({ selected: "hero.headline" });
    const bad = parsePreviewMessage({ ...base, type: "render", spec: s, content: {}, locale: "bn", edit: { selected: "<script>" } });
    expect(bad?.edit).toEqual({ selected: null });
    const plain = parsePreviewMessage({ ...base, type: "render", spec: s, content: {}, locale: "bn" });
    expect(plain?.edit).toBeUndefined();
  });

  it("isEditPath is purely syntactic and bounded", () => {
    expect(isEditPath("products.items.2.price")).toBe(true);
    expect(isEditPath("products.items.2.price.0.a.b")).toBe(false);
    expect(isEditPath("products items")).toBe(false);
  });
});
