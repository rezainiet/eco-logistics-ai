import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type CatalogProduct, type LocalizedContent, SYSTEM_TEMPLATES, type TemplateSpec, defaultContent } from "@ecom/landing";
import { findElements } from "@/test-utils/element-tree";
import { PublishWarnings, placeholderSections, publishWarnings } from "./publish-warnings";

/**
 * Publish warnings: shown in the existing publish confirmation, never
 * blocking it. BD Single Product is the template that needs them today.
 */

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const specOf = (key: string): TemplateSpec => clone(SYSTEM_TEMPLATES.find((t) => t.key === key)!.spec);
const single = () => specOf("bd-single-product");
const contentOf = (spec: TemplateSpec): LocalizedContent => ({ bn: defaultContent(spec, "bn"), en: defaultContent(spec, "en") });
const BOTH = ["bn", "en"] as const;

const product = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: "6ab73cca06587711398245c7",
  name: "Panjabi",
  description: "",
  imageAssetId: null,
  price: 1200,
  compareAtPrice: null,
  currency: "BDT",
  available: true,
  stockStatus: "in_stock",
  maxQuantity: 5,
  badge: null,
  ctaText: null,
  featured: false,
  ...over,
});

/** BD Single Product content with every bracketed review prompt replaced by real text. */
function withRealReviews(spec: TemplateSpec): LocalizedContent {
  const c = contentOf(spec) as Record<string, Record<string, Record<string, unknown>>>;
  for (const l of BOTH) {
    c[l]!.reviews!.items = [{ quote: "Arrived in two days, great fabric.", name: "Rafiq", role: "Dhaka", avatar: null, rating: "5" }];
  }
  return c as LocalizedContent;
}

const keys = (w: ReturnType<typeof publishWarnings>) => w.map((x) => x.key);

describe("no product to sell (BD Single Product)", () => {
  it("warns when no product is linked", () => {
    const spec = single();
    const w = publishWarnings({ spec, content: withRealReviews(spec), locales: BOTH, catalog: [] });
    expect(w).toEqual([
      {
        key: "no-product",
        message: "This page has no product to sell yet — its Order now buttons won’t open checkout. Link a product on the Products tab.",
      },
    ]);
  });

  it("no warning with a buyable linked product", () => {
    const spec = single();
    expect(publishWarnings({ spec, content: withRealReviews(spec), locales: BOTH, catalog: [product()] })).toEqual([]);
  });

  it("warns when the product the spotlight shows can't be bought (it is the featured / first one)", () => {
    const spec = single();
    const out = product({ name: "Honey", available: false, stockStatus: "out_of_stock", maxQuantity: 0 });
    const w = publishWarnings({ spec, content: withRealReviews(spec), locales: BOTH, catalog: [out, product({ id: "6ab73cca06587711398245c8" })] });
    expect(keys(w)).toEqual(["product-unavailable"]);
    expect(w[0]!.message).toContain("“Honey” can’t be ordered right now");
  });

  it("says nothing while the linked products are still loading", () => {
    const spec = single();
    for (const catalog of [null, undefined]) expect(publishWarnings({ spec, content: withRealReviews(spec), locales: BOTH, catalog })).toEqual([]);
  });

  it("other templates (no Product spotlight) never get it", () => {
    for (const key of ["bd-modern-shop", "bd-premium-brand", "launch", "showcase", "local-service"]) {
      const spec = specOf(key);
      expect(publishWarnings({ spec, content: contentOf(spec), locales: BOTH, catalog: [] }), key).toEqual([]);
    }
  });
});

describe("template placeholders left in the text", () => {
  it("BD Single Product's default review prompts trigger it, naming the section", () => {
    const spec = single();
    expect(placeholderSections(spec, contentOf(spec), BOTH)).toEqual([{ id: "reviews", type: "testimonials", label: "Testimonials" }]);
    const w = publishWarnings({ spec, content: contentOf(spec), locales: BOTH, catalog: [product()] });
    expect(w).toEqual([
      {
        key: "placeholders",
        message: "Some text in Testimonials still contains placeholders in [square brackets]. Replace it with real customer reviews before publishing.",
      },
    ]);
  });

  it("goes away once the prompts are replaced — or the reviews removed", () => {
    const spec = single();
    expect(publishWarnings({ spec, content: withRealReviews(spec), locales: BOTH, catalog: [product()] })).toEqual([]);
    const removed = contentOf(spec) as Record<string, Record<string, Record<string, unknown>>>;
    for (const l of BOTH) removed[l]!.reviews!.items = [];
    expect(placeholderSections(spec, removed as LocalizedContent, BOTH)).toEqual([]);
  });

  it("checks every enabled language, and only enabled ones", () => {
    const spec = single();
    const c = withRealReviews(spec) as Record<string, Record<string, Record<string, unknown>>>;
    c.en!.reviews!.items = [{ quote: "[Replace me]", name: "Rafiq", role: "", avatar: null, rating: "0" }];
    expect(placeholderSections(spec, c as LocalizedContent, BOTH).map((s) => s.id)).toEqual(["reviews"]);
    expect(placeholderSections(spec, c as LocalizedContent, ["bn"])).toEqual([]);
  });

  it("only whole bracketed values count: ordinary brackets in real text don't", () => {
    const spec = single();
    const c = withRealReviews(spec) as Record<string, Record<string, Record<string, unknown>>>;
    c.bn!.faq!.heading = "সাধারণ জিজ্ঞাসা [FAQ]";
    c.bn!.hero!.headline = "[২০২৬] কালেকশন এসেছে";
    expect(placeholderSections(spec, c as LocalizedContent, BOTH)).toEqual([]);
    c.bn!.footer!.brandName = "[Your shop name]";
    expect(publishWarnings({ spec, content: c as LocalizedContent, locales: BOTH, catalog: [product()] })[0]!.message).toBe(
      "Some text in Shop footer still contains placeholders in [square brackets]. Replace it with your own text before publishing.",
    );
  });

  it("the five other built-in templates have no bracketed prompts", () => {
    for (const key of ["bd-modern-shop", "bd-premium-brand", "launch", "showcase", "local-service"]) {
      const spec = specOf(key);
      expect(placeholderSections(spec, contentOf(spec), BOTH), key).toEqual([]);
    }
  });

  it("both warnings together, product first", () => {
    const spec = single();
    expect(keys(publishWarnings({ spec, content: contentOf(spec), locales: BOTH, catalog: [] }))).toEqual(["no-product", "placeholders"]);
  });
});

describe("in the publish confirmation", () => {
  it("lists each warning; renders nothing when there are none (the confirmation is as before)", () => {
    const spec = single();
    const html = renderToStaticMarkup(<PublishWarnings warnings={publishWarnings({ spec, content: contentOf(spec), locales: BOTH, catalog: [] })} />);
    expect(html).toContain('data-warning="no-product"');
    expect(html).toContain('data-warning="placeholders"');
    expect(html).toContain("Link a product on the Products tab.");
    expect(renderToStaticMarkup(<PublishWarnings warnings={[]} />)).toBe("");
  });

  it("is information only: no buttons, links or anything that could stand in for Publish", () => {
    const tree = PublishWarnings({ warnings: [{ key: "no-product", message: "x" }, { key: "placeholders", message: "y" }] });
    expect(findElements(tree, (el) => el.type === "button" || el.type === "a" || "onClick" in el.props)).toEqual([]);
  });

  it("the editor shows them inside the existing publish confirmation, which still publishes on confirm", () => {
    const src = readFileSync(fileURLToPath(new URL("./landing-editor.tsx", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
    const dialog = src.slice(src.indexOf('open={confirm === "publish"}'), src.indexOf("</ConfirmDialog>", src.indexOf('open={confirm === "publish"}')));
    expect(dialog).toContain("onConfirm={() => void doPublish()}");
    expect(dialog).toContain("<PublishWarnings warnings={warnings} />");
    // The same product data the preview uses; publishing is never gated on warnings.
    expect(src).toContain("catalog: linkedProducts.data?.catalog ?? null");
    const requestPublish = src.slice(src.indexOf("const requestPublish = () => {"), src.indexOf('setConfirm("publish");'));
    expect(requestPublish).not.toContain("warnings");
  });
});
