import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  type CatalogProduct,
  type LocalizedContent,
  SYSTEM_TEMPLATES,
  type TemplateSpec,
  defaultContent,
  validateLocalizedContent,
} from "@ecom/landing";
import { findElements } from "@/test-utils/element-tree";
import { SECTION_UX, TEMPLATE_SECTION_UX, landingSetup, sectionUx } from "./section-setup";
import { SectionRowContent, SetupSummary } from "./section-setup-view";

/** Landing page setup: importance, description and readiness per visible section. */

type Raw = Record<string, Record<string, Record<string, unknown>>>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const specOf = (key: string): TemplateSpec => clone(SYSTEM_TEMPLATES.find((t) => t.key === key)!.spec);
const KEY = "bd-single-product";
const BOTH = ["bn", "en"] as const;
const contentOf = (spec: TemplateSpec): Raw => ({ bn: defaultContent(spec, "bn"), en: defaultContent(spec, "en") }) as Raw;

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

/** The setup exactly as the editor builds it: real validator issues, enabled languages, linked products. */
function setupFor(opts: { key?: string; content?: Raw; catalog?: CatalogProduct[] | null; locales?: ReadonlyArray<"bn" | "en"> } = {}) {
  const key = opts.key ?? KEY;
  const spec = specOf(key);
  const content = (opts.content ?? contentOf(spec)) as LocalizedContent;
  const locales = opts.locales ?? BOTH;
  const issues = validateLocalizedContent(spec, content, { locales: [...locales], defaultLocale: locales[0]! }, "publish").issues;
  return landingSetup({ templateKey: key, spec, content, locales, catalog: opts.catalog === undefined ? [product()] : opts.catalog, issues });
}

const byId = (s: ReturnType<typeof setupFor>, id: string) => s.sections.find((x) => x.id === id)!;
const withRealReviews = (c: Raw) => {
  for (const l of BOTH) c[l]!.reviews!.items = [{ quote: "Arrived in two days.", name: "Rafiq", role: "Dhaka", avatar: null, rating: "5" }];
  return c;
};

describe("BD Single Product metadata", () => {
  it("12 visible sections in page order with the agreed importance", () => {
    const s = setupFor();
    expect(s.sections.map((x) => [x.number, x.id, x.label, x.importance])).toEqual([
      [1, "topbar", "Offer bar", "recommended"],
      [2, "hero", "Promotional hero", "recommended"],
      [3, "spotlight", "Product spotlight", "required"],
      [4, "benefits", "Benefits", "recommended"],
      [5, "trust", "Why choose us", "recommended"],
      [6, "how", "How to order", "recommended"],
      [7, "offer", "Offer / flash sale", "optional"],
      [8, "reviews", "Testimonials", "optional"],
      [9, "faq", "FAQ", "optional"],
      [10, "delivery", "Delivery & payment", "required"],
      [11, "orderbar", "Mobile order bar", "required"],
      [12, "footer", "Shop footer", "optional"],
    ]);
  });

  it("every section has a short description", () => {
    const s = setupFor();
    expect(s.sections.find((x) => !x.description)).toBeUndefined();
    expect(byId(s, "topbar").description).toBe("Offer message and campaign announcement");
    expect(byId(s, "hero").description).toBe("Main headline and product introduction");
    expect(byId(s, "spotlight").description).toBe("Product, price, variants and Buy Now");
    expect(byId(s, "reviews").description).toBe("Customer reviews");
    expect(byId(s, "delivery").description).toBe("Delivery areas and payment method");
    expect(byId(s, "footer").description).toBe("Contact and store information");
  });

  it("page settings (colours, SEO) are separate and never counted", () => {
    const s = setupFor();
    expect(s.pageSettings.map((x) => x.label)).toEqual(["Colours, font & animation", "Search & sharing"]);
    expect(s.counts.total).toBe(12);
    expect(s.sections.map((x) => x.id)).not.toContain("theme");
    expect(s.sections.map((x) => x.id)).not.toContain("seo");
  });

  it("is editor metadata: a template mapping, falling back to per-type defaults; ids beat types", () => {
    expect(Object.keys(TEMPLATE_SECTION_UX)).toEqual([KEY]);
    expect(sectionUx("some-other-template", { id: "x", type: "testimonials" })).toEqual(SECTION_UX.testimonials);
    expect(sectionUx(null, { id: "x", type: "brandNewType" })).toEqual({ importance: "recommended", description: "" });
    expect(sectionUx(KEY, { id: "how", type: "features" }).description).toBe("The steps to order");
  });
});

describe("readiness", () => {
  it("Product spotlight: no product → needs editing; buyable → ready; unbuyable → needs editing; loading → checking", () => {
    const clean = withRealReviews(contentOf(specOf(KEY)));
    expect(byId(setupFor({ content: clean, catalog: [] }), "spotlight")).toMatchObject({ readiness: "needs-editing", detail: "Link a product on the Products tab" });
    expect(byId(setupFor({ content: clean, catalog: [product()] }), "spotlight")).toMatchObject({ readiness: "ready", detail: null });
    const out = product({ name: "Honey", available: false, stockStatus: "out_of_stock", maxQuantity: 0 });
    expect(byId(setupFor({ content: clean, catalog: [out] }), "spotlight")).toMatchObject({ readiness: "needs-editing", detail: "“Honey” can’t be ordered right now" });
    expect(byId(setupFor({ content: clean, catalog: null }), "spotlight")).toMatchObject({ readiness: null });
  });

  it("Testimonials: template placeholders → needs editing with a count; real reviews → ready", () => {
    expect(byId(setupFor(), "reviews")).toMatchObject({ importance: "optional", readiness: "needs-editing", detail: "Replace 3 placeholder reviews" });
    expect(byId(setupFor({ content: withRealReviews(contentOf(specOf(KEY))) }), "reviews")).toMatchObject({ readiness: "ready", detail: null });
    const one = withRealReviews(contentOf(specOf(KEY)));
    one.en!.reviews!.items = [{ quote: "[Add a real review]", name: "Rafiq", role: "", avatar: null, rating: "0" }];
    expect(byId(setupFor({ content: one }), "reviews").detail).toBe("Replace 1 placeholder review");
    // A language that isn't enabled doesn't count.
    expect(byId(setupFor({ content: one, locales: ["bn"] }), "reviews").readiness).toBe("ready");
  });

  it("Delivery: the template's ৳60 / ৳120 → check defaults (not an error); changed charges → ready", () => {
    expect(byId(setupFor(), "delivery")).toMatchObject({ importance: "required", readiness: "check-defaults", detail: "Review ৳60 / ৳120 delivery charges" });
    const changed = contentOf(specOf(KEY));
    for (const l of BOTH) (changed[l]!.delivery!.zones as Array<{ charge: number }>)[1]!.charge = 150;
    expect(byId(setupFor({ content: changed }), "delivery")).toMatchObject({ readiness: "ready", detail: null });
    // A change in any enabled language counts as the merchant having reviewed the charges.
    const half = contentOf(specOf(KEY));
    (half.bn!.delivery!.zones as Array<{ charge: number }>)[0]!.charge = 70;
    expect(byId(setupFor({ content: half }), "delivery").readiness).toBe("ready");
  });

  it("existing validation issues make a section need editing (the shared validator, not new rules)", () => {
    const c = withRealReviews(contentOf(specOf(KEY)));
    c.bn!.spotlight!.ctaLabel = "";
    expect(byId(setupFor({ content: c }), "spotlight")).toMatchObject({ readiness: "needs-editing", detail: "Order button text is required" });
    c.en!.hero!.headline = "";
    expect(byId(setupFor({ content: c }), "hero")).toMatchObject({ readiness: "needs-editing", detail: "Headline is required" });
  });

  it("optional sections that are fine count as ready — they never make the page look incomplete", () => {
    const s = setupFor({ content: withRealReviews(contentOf(specOf(KEY))) });
    for (const id of ["offer", "reviews", "faq", "footer"]) expect(byId(s, id)).toMatchObject({ importance: "optional", readiness: "ready" });
  });
});

describe("summary counts", () => {
  it("count all 12 visible sections: default page = 10 ready, 1 needs editing, 1 to review", () => {
    const s = setupFor();
    expect(s.counts).toEqual({ total: 12, ready: 10, needsEditing: 1, checkDefaults: 1, checking: 0 });
    expect(s.attention.map((x) => [x.id, x.readiness])).toEqual([
      ["reviews", "needs-editing"],
      ["delivery", "check-defaults"],
    ]);
  });

  it("no product linked adds the spotlight; fixing everything leaves all 12 ready", () => {
    expect(setupFor({ catalog: [] }).counts).toEqual({ total: 12, ready: 9, needsEditing: 2, checkDefaults: 1, checking: 0 });
    const done = withRealReviews(contentOf(specOf(KEY)));
    for (const l of BOTH) (done[l]!.delivery!.zones as Array<{ charge: number }>)[0]!.charge = 70;
    const s = setupFor({ content: done });
    expect(s.counts).toEqual({ total: 12, ready: 12, needsEditing: 0, checkDefaults: 0, checking: 0 });
    expect(s.attention).toEqual([]);
  });

  it("works for every built-in template without editor metadata of its own", () => {
    for (const key of ["bd-modern-shop", "bd-premium-brand", "launch", "showcase", "local-service"]) {
      const s = setupFor({ key, catalog: [] });
      expect(s.counts.total, key).toBe(s.sections.length);
      expect(s.counts.total, key).toBeGreaterThan(5);
      for (const x of s.sections) {
        expect(["required", "recommended", "optional"], `${key} ${x.id}`).toContain(x.importance);
        expect(x.description, `${key} ${x.id}`).not.toBe("");
      }
      expect(s.pageSettings.every((p) => !s.sections.some((x) => x.id === p.id))).toBe(true);
    }
  });
});

describe("view", () => {
  it("rows say importance and readiness in words, with the attention detail", () => {
    const s = setupFor();
    const html = renderToStaticMarkup(<SectionRowContent section={byId(s, "reviews")} />);
    expect(html).toContain(">08<");
    expect(html).toContain(">Testimonials<");
    expect(html).toContain('data-importance="optional"');
    expect(html).toContain(">Optional<");
    expect(html).toContain(">Needs editing<");
    expect(html).toContain("Replace 3 placeholder reviews");
    expect(renderToStaticMarkup(<SectionRowContent section={byId(s, "delivery")} />)).toMatch(/>Required<[\s\S]*>Check defaults<[\s\S]*Review ৳60 \/ ৳120 delivery charges/);
    expect(renderToStaticMarkup(<SectionRowContent section={byId(s, "spotlight")} />)).toMatch(/>Required<[\s\S]*>Ready</);
    // Only phrasing content: it lives inside the existing <summary>.
    expect(html).not.toMatch(/<(div|p|section|ul|button)\b/);
  });

  it("summary shows counts, and each attention item opens that section", () => {
    const s = setupFor();
    const html = renderToStaticMarkup(<SetupSummary setup={s} onOpen={() => {}} />);
    expect(html).toContain("Landing page setup");
    expect(html).toMatch(/<span class="font-semibold">10<\/span> of 12 sections ready/);
    expect(html).toContain("1 needs editing");
    expect(html).toContain("1 to review");
    const onOpen = vi.fn();
    const buttons = findElements(SetupSummary({ setup: s, onOpen }), (el) => el.type === "button");
    expect(buttons.map((b) => b.props["data-open-section"])).toEqual(["reviews", "delivery"]);
    (buttons[1]!.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith("delivery");
    expect(buttons[0]!.props["aria-label"]).toBe("Open Testimonials: Replace 3 placeholder reviews");
  });

  it("all ready: no attention list", () => {
    const done = withRealReviews(contentOf(specOf(KEY)));
    for (const l of BOTH) (done[l]!.delivery!.zones as Array<{ charge: number }>)[0]!.charge = 70;
    const html = renderToStaticMarkup(<SetupSummary setup={setupFor({ content: done })} onOpen={() => {}} />);
    expect(html).toContain("Every section is ready.");
    expect(html).not.toContain("<button");
  });
});

describe("in the editor", () => {
  const src = readFileSync(fileURLToPath(new URL("./landing-editor.tsx", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

  it("rows stay the existing section panels; setup clicks use the existing reveal", () => {
    // Each section is still its own <details data-section-id> panel with its fields; the row only changes the summary text.
    expect(src).toContain("data-section-id={section.id}");
    expect(src).toContain("{row ? <SectionRowContent section={row} /> : <span>{section.label}</span>}");
    expect(src).toContain("<FieldInput");
    const open = src.slice(src.indexOf("const openSection = (sectionId: string) => {"), src.indexOf("const requestPublish"));
    expect(open).toContain("setReveal((r) => ({ path: sectionId, n: (r?.n ?? 0) + 1 }))");
    expect(src).toContain("<SetupSummary setup={setup} onOpen={openSection} />");
  });

  it("publishing is untouched: blockers and the confirmation don't use the setup", () => {
    const requestPublish = src.slice(src.indexOf("const requestPublish = () => {"), src.indexOf('setConfirm("publish");'));
    expect(requestPublish).toContain("if (blockers.length)");
    expect(requestPublish).not.toMatch(/setup|readiness/);
    expect(src).toContain("const blockers = describePublishBlockers(spec, publishIssues, draftIssues);");
    const dialog = src.slice(src.indexOf('open={confirm === "publish"}'), src.indexOf("</ConfirmDialog>", src.indexOf('open={confirm === "publish"}')));
    expect(dialog).not.toMatch(/setup|readiness/);
  });
});
