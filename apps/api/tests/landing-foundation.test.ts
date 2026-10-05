import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type Locale,
  SECTION_TYPES,
  SYSTEM_TEMPLATES,
  type TemplateSpec,
  defaultContent,
  effectiveSections,
  hasMobileActionBar,
  parseTemplateSpec,
  resolveEditTarget,
  themeMotion,
  validateContent,
} from "@ecom/landing";
import { LandingRenderer, SECTION_COMPONENTS, assetEnv } from "@ecom/landing/react";

/**
 * Template foundation: the opt-in scroll reveal (theme@2 `motion`) and the
 * mobile order bar (mobileActionBar@1). Existing templates and pages —
 * all on theme@1, none with the bar — must render exactly as before.
 */

const env = assetEnv("https://api.example/api/landing-assets");
type Content = Record<string, Record<string, unknown>>;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function systemSpec(key: string): TemplateSpec {
  return clone(SYSTEM_TEMPLATES.find((t) => t.key === key)!.spec);
}

function render(s: TemplateSpec, content: unknown, opts: { locale?: Locale; editable?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(LandingRenderer, { spec: s, content, locale: opts.locale ?? "en", env: { ...env, editable: !!opts.editable } }),
  );
}

/** BD Modern Shop on theme@2 (same fields + motion), optionally with the mobile order bar. */
function foundationSpec(opts: { bar?: boolean } = {}): TemplateSpec {
  const s = systemSpec("bd-modern-shop");
  s.sections.find((x) => x.type === "theme")!.typeVersion = 2;
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

const MOTION_ATTRS = /\s(?:data-lp-motion="[^"]*"|data-lp-reveal="[^"]*")/g;
const BAR_PAD = "max-md:pb-[calc(4.75rem+env(safe-area-inset-bottom,0px))]";

describe("existing templates and pages are unchanged", () => {
  const KEYS = ["bd-modern-shop", "bd-premium-brand", "launch", "showcase", "local-service"];

  it("the five system templates are valid, stay on theme@1 and have no order bar", () => {
    // BD Single Product (theme@2 + order bar) was added after them; see landing-single-product.test.ts.
    expect(SYSTEM_TEMPLATES.map((t) => t.key).sort()).toEqual([...KEYS, "bd-single-product"].sort());
    for (const t of SYSTEM_TEMPLATES.filter((x) => KEYS.includes(x.key))) {
      expect(parseTemplateSpec(t.spec).ok).toBe(true);
      expect(t.spec.sections.find((s) => s.type === "theme")?.typeVersion).toBe(1);
      expect(hasMobileActionBar(t.spec)).toBe(false);
    }
  });

  it("render with no motion markers and no order-bar padding, in every language, public and editor", () => {
    for (const key of KEYS) {
      const s = systemSpec(key);
      for (const locale of ["en", "bn"] as const) {
        for (const editable of [false, true]) {
          const html = render(s, defaultContent(s, locale), { locale, editable });
          expect(html, `${key} ${locale}`).not.toMatch(/data-lp-motion|data-lp-reveal|data-lp-action-bar/);
          expect(html).not.toContain("max-md:pb-");
        }
      }
    }
  });

  it("theme@1 never gains a motion field, so the editor and stored content of existing pages are as before", () => {
    const v1 = SECTION_TYPES.get("theme@1")!;
    const v2 = SECTION_TYPES.get("theme@2")!;
    expect(v1.fields.map((f) => f.key)).toEqual(["primary", "onPrimary", "accent", "background", "surface", "text", "muted", "font", "radius", "numerals"]);
    expect(v2.fields.map((f) => f.key)).toEqual([...v1.fields.map((f) => f.key), "motion"]);
    expect(v2.fields.slice(0, -1)).toEqual(v1.fields);
    const s = systemSpec("bd-modern-shop");
    expect(effectiveSections(s).find((x) => x.type === "theme")!.fields.some((f) => f.key === "motion")).toBe(false);
    expect(Object.keys(defaultContent(s).theme!)).not.toContain("motion");
  });

  it("a theme@1 page cannot switch motion on, even with tampered stored content", () => {
    const s = systemSpec("bd-modern-shop");
    const tampered = contentWith(s, "en", { theme: { motion: "lively" } });
    expect(validateContent(s, tampered, "draft").issues.map((i) => i.path)).toContain("theme.motion");
    expect(render(s, tampered)).not.toMatch(/data-lp-motion|data-lp-reveal/);
  });
});

describe("motion (theme@2)", () => {
  it("defaults to none: no markers, same markup as the theme@1 template", () => {
    const v2 = foundationSpec();
    const v1 = systemSpec("bd-modern-shop");
    expect(defaultContent(v2).theme!.motion).toBe("none");
    expect(render(v2, defaultContent(v2))).toBe(render(v1, defaultContent(v1)));
  });

  it("subtle and lively mark the root and every reveal-eligible section; chrome and the bar never", () => {
    const s = foundationSpec({ bar: true });
    for (const motion of ["subtle", "lively"] as const) {
      const c = contentWith(s, "en", { theme: { motion } });
      const html = render(s, c);
      expect(html).toContain(`data-landing-root="" data-lp-motion="${motion}"`);
      const revealed = [...html.matchAll(/<section id="([^"]+)" data-section-type="[^"]+"[^>]*data-lp-reveal=""/g)].map((m) => m[1]);
      expect(revealed).toEqual(["hero", "categories", "offer", "products", "why", "reviews", "delivery", "order", "footer"]);
      for (const chrome of ["topbar", "header", "orderbar"]) expect(revealed).not.toContain(chrome);
    }
  });

  it("server HTML is identical apart from the markers: nothing is hidden or restyled before JavaScript runs", () => {
    const s = foundationSpec({ bar: true });
    for (const locale of ["en", "bn"] as const) {
      const off = render(s, contentWith(s, locale, { theme: { motion: "none" } }), { locale });
      for (const motion of ["subtle", "lively"] as const) {
        const on = render(s, contentWith(s, locale, { theme: { motion } }), { locale });
        // No hiding class, no inline opacity/transform, no pre-set reveal state.
        expect(on).not.toMatch(/\bopacity-0\b|style="(?:[^"]*;)?(?:opacity|transform):|data-lp-reveal="(pending|shown)"/);
        expect(on.replace(MOTION_ATTRS, "")).toBe(off);
      }
    }
  });

  it("the editor's click-to-edit preview never animates", () => {
    const s = foundationSpec();
    const html = render(s, contentWith(s, "en", { theme: { motion: "lively" } }), { editable: true });
    expect(html).toContain("data-lp-field");
    expect(html).not.toMatch(/data-lp-motion|data-lp-reveal/);
  });

  it("only none / subtle / lively are accepted; anything else renders as none", () => {
    const s = foundationSpec();
    const bad = contentWith(s, "en", { theme: { motion: "wild" } });
    expect(validateContent(s, bad, "publish").issues.map((i) => i.path)).toContain("theme.motion");
    expect(render(s, bad)).not.toMatch(/data-lp-motion/);
    expect(themeMotion({ motion: "subtle" })).toBe("subtle");
    expect(themeMotion({ motion: "lively" })).toBe("lively");
    for (const v of [undefined, "none", "LIVELY", 1, null]) expect(themeMotion({ motion: v })).toBe("none");
    expect(themeMotion(undefined)).toBe("none");
  });
});

describe("mobileActionBar@1", () => {
  const bar = (s: TemplateSpec, locale: Locale, values: Record<string, unknown>) => contentWith(s, locale, { orderbar: values });
  const ORDER = { label: "Order now", action: { kind: "section", sectionId: "products" } };
  const WA = { label: "WhatsApp", action: { kind: "whatsapp", phone: "+8801711000000", message: "I want to order" } };
  const CALL = { label: "Call", action: { kind: "phone", phone: "+8801711000000" } };

  it("is registered with a component and validates in a template", () => {
    const def = SECTION_TYPES.get("mobileActionBar@1")!;
    expect(def).toMatchObject({ visual: true });
    expect(def.fields.map((f) => f.key)).toEqual(["primaryCta", "whatsappCta", "callCta"]);
    expect(SECTION_COMPONENTS["mobileActionBar@1"]).toBeTypeOf("function");
    expect(hasMobileActionBar(foundationSpec({ bar: true }))).toBe(true);
  });

  it("requires the order button to scroll to a section before publishing; drafts may be unfinished", () => {
    const s = foundationSpec({ bar: true });
    const blank = defaultContent(s, "en") as Content;
    expect(blank.orderbar).toEqual({
      primaryCta: { label: "Order now", action: { kind: "none" } },
      whatsappCta: { label: "WhatsApp", action: { kind: "none" } },
      callCta: { label: "Call", action: { kind: "none" } },
    });
    expect(validateContent(s, blank, "draft").ok).toBe(true);
    const issues = validateContent(s, blank, "publish").issues.filter((i) => i.path.startsWith("orderbar"));
    expect(issues).toEqual([{ path: "orderbar.primaryCta", message: "Order button needs somewhere to go (WhatsApp, phone, email or a link)" }]);
    const ordered = validateContent(s, bar(s, "en", { primaryCta: ORDER }), "publish");
    expect(ordered.issues.filter((i) => i.path.startsWith("orderbar"))).toEqual([]);
  });

  it("each button only takes its own kind of action", () => {
    const s = foundationSpec({ bar: true });
    const bad = [
      { primaryCta: { label: "Order", action: { kind: "link", url: "https://example.com" } } },
      { primaryCta: { label: "Order", action: { kind: "whatsapp", phone: "+8801711000000" } } },
      { whatsappCta: { label: "WA", action: { kind: "phone", phone: "+8801711000000" } } },
      { callCta: { label: "Call", action: { kind: "link", url: "https://example.com" } } },
    ];
    for (const values of bad) {
      const r = validateContent(s, bar(s, "en", values), "draft");
      expect(r.ok, JSON.stringify(values)).toBe(false);
      expect(r.issues.map((i) => i.message)).toEqual(["This button can't do that"]);
    }
    const all = validateContent(s, bar(s, "en", { primaryCta: ORDER, whatsappCta: WA, callCta: CALL }), "publish");
    expect(all.issues.filter((i) => i.path.startsWith("orderbar"))).toEqual([]);
  });

  it("renders a mobile-only fixed bar with safe links and safe-area padding; the page leaves room for it", () => {
    const s = foundationSpec({ bar: true });
    const html = render(s, bar(s, "en", { primaryCta: ORDER, whatsappCta: WA, callCta: CALL }));
    const section = html.slice(html.indexOf('<section id="orderbar"'));
    expect(section).toContain('<div class="md:hidden" data-lp-action-bar="">');
    expect(section).toContain('aria-label="Quick order"');
    expect(section).toMatch(/class="fixed inset-x-0 bottom-0 z-30 [^"]*pb-\[max\(0\.5rem,env\(safe-area-inset-bottom,0px\)\)\]/);
    expect(section).toContain('href="#products"');
    expect(section).toContain('href="https://wa.me/8801711000000?text=I%20want%20to%20order" target="_blank" rel="noopener noreferrer nofollow ugc" aria-label="WhatsApp"');
    expect(section).toContain('href="tel:+8801711000000" aria-label="Call"');
    expect(section).toContain(">Order now</span>");
    expect(section).toContain("min-h-12");
    expect(html).toContain(`data-landing-root=""`);
    expect(html).toMatch(new RegExp(`class="[^"]*${BAR_PAD.replace(/[[\]().+]/g, "\\$&")}`));
  });

  it("optional buttons appear only when set; unset ones are placeholders in the editor only", () => {
    const s = foundationSpec({ bar: true });
    const publicHtml = render(s, bar(s, "en", { primaryCta: ORDER }));
    expect(publicHtml).not.toMatch(/wa\.me|tel:\+8801711000000|border-dashed/);
    const editHtml = render(s, bar(s, "en", { primaryCta: ORDER }), { editable: true });
    const barHtml = editHtml.slice(editHtml.indexOf('data-lp-section="orderbar"'));
    expect(barHtml).toMatch(/border-dashed[^"]*" data-lp-field="whatsappCta"/);
    expect(barHtml).toMatch(/border-dashed[^"]*" data-lp-field="callCta"/);
  });

  it("speaks Bangla on Bangla pages, with Bangla fallback labels", () => {
    const s = foundationSpec({ bar: true });
    const html = render(
      s,
      bar(s, "bn", {
        primaryCta: { label: "এখনই অর্ডার করুন", action: { kind: "section", sectionId: "products" } },
        whatsappCta: { label: "", action: { kind: "whatsapp", phone: "01711000000" } },
        callCta: { label: "", action: { kind: "phone", phone: "01711000000" } },
      }),
      { locale: "bn" },
    );
    expect(html).toContain('aria-label="দ্রুত অর্ডার"');
    expect(html).toContain(">এখনই অর্ডার করুন</span>");
    expect(html).toContain('aria-label="হোয়াটসঅ্যাপ"');
    expect(html).toContain('aria-label="কল করুন"');
  });

  it("every element of the bar opens its own field in click-to-edit", () => {
    const s = foundationSpec({ bar: true });
    for (const locale of ["en", "bn"] as const) {
      const html = render(s, bar(s, locale, { primaryCta: ORDER, whatsappCta: WA, callCta: CALL }), { locale, editable: true });
      const barHtml = html.slice(html.indexOf('data-lp-section="orderbar"'));
      const paths = [...barHtml.matchAll(/data-lp-field="([^"]+)"/g)].map((m) => m[1]!);
      expect(paths).toEqual(["whatsappCta", "callCta", "primaryCta"]);
      for (const p of paths) expect(resolveEditTarget(s, locale, `orderbar.${p}`)).toMatchObject({ kind: "field", sectionId: "orderbar" });
    }
  });

  it("escapes merchant text and never emits an unsafe link, even from tampered stored content", () => {
    const s = foundationSpec({ bar: true });
    const xss = '<img src=x onerror=alert(1)>"';
    const html = render(
      s,
      bar(s, "en", {
        primaryCta: { label: xss, action: { kind: "section", sectionId: "products" } },
        whatsappCta: { label: xss, action: { kind: "whatsapp", phone: "+8801711000000", message: '"><script>alert(1)</script>' } },
      }),
    );
    expect(html).not.toMatch(/<img src=x|<script>alert/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;");
    expect(html).toContain("text=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");

    // Stored JSON that bypassed validation: unsafe actions fall back to the (unlinked) defaults.
    const tampered = bar(s, "en", {
      primaryCta: { label: "Order", action: { kind: "link", url: "javascript:alert(1)" } },
      whatsappCta: { label: "WA", action: { kind: "whatsapp", phone: "javascript:alert(1)" } },
      callCta: { label: "Call", action: { kind: "link", url: "https://evil.example" } },
    });
    const out = render(s, tampered);
    expect(out).not.toMatch(/javascript:|evil\.example|wa\.me|tel:/);
    expect(out.slice(out.indexOf('<section id="orderbar"'))).toContain('aria-disabled="true" data-cta-unlinked=""');
  });
});
