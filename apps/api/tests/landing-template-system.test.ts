import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SECTION_TYPES,
  SYSTEM_TEMPLATES,
  type TemplateSpec,
  ctaHref,
  defaultContent,
  effectiveSections,
  extractLandingLabel,
  normalizeHost,
  parseRichText,
  parseTemplateSpec,
  resolveContent,
  resolveSeo,
  safeUrl,
  validateContent,
  validateSlug,
} from "@ecom/landing";
import { LandingRenderer, SECTION_COMPONENTS, assetEnv, themeStyle } from "@ecom/landing/react";

const ASSET = "0123456789abcdef01234567";
const env = assetEnv("https://api.example/api/landing-assets");

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function spec(key: string): TemplateSpec {
  const t = SYSTEM_TEMPLATES.find((s) => s.key === key);
  if (!t) throw new Error(`no template ${key}`);
  return clone(t.spec);
}

function render(s: TemplateSpec, content: unknown): string {
  return renderToStaticMarkup(createElement(LandingRenderer, { spec: s, content, env }));
}

describe("template specs", () => {
  it("every system template spec is valid and distinct", () => {
    expect(SYSTEM_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    const layouts = new Set<string>();
    for (const t of SYSTEM_TEMPLATES) {
      const parsed = parseTemplateSpec(t.spec);
      expect(parsed.ok, `${t.key}: ${JSON.stringify(!parsed.ok && parsed.issues)}`).toBe(true);
      layouts.add(t.spec.sections.map((s) => s.type).join(","));
    }
    // Structurally different pages, not recolours of one layout.
    expect(layouts.size).toBe(SYSTEM_TEMPLATES.length);
  });

  it("rejects unknown section types, unknown fields and invalid defaults", () => {
    const base = spec("launch");
    const unknownType = clone(base);
    unknownType.sections.push({ id: "evil", type: "rawHtml", typeVersion: 1 });
    expect(parseTemplateSpec(unknownType).ok).toBe(false);

    const unknownField = clone(base);
    unknownField.sections[2]!.fields = { script: { default: "<script>alert(1)</script>" } };
    expect(parseTemplateSpec(unknownField).ok).toBe(false);

    const badDefault = clone(base);
    badDefault.sections[0]!.fields = { primary: { default: "red; background:url(x)" } };
    const r = parseTemplateSpec(badDefault);
    expect(r.ok).toBe(false);

    const badUrlDefault = clone(base);
    badUrlDefault.sections.find((s) => s.id === "hero")!.fields!.primaryCta = {
      default: { label: "Go", action: { kind: "link", url: "javascript:alert(1)" } },
    };
    expect(parseTemplateSpec(badUrlDefault).ok).toBe(false);
  });

  it("requires exactly one theme and one seo section, and unique ids", () => {
    const noTheme = clone(spec("launch"));
    noTheme.sections = noTheme.sections.filter((s) => s.type !== "theme");
    expect(parseTemplateSpec(noTheme).ok).toBe(false);

    const dupe = clone(spec("launch"));
    dupe.sections.push({ ...dupe.sections[3]! });
    expect(parseTemplateSpec(dupe).ok).toBe(false);
  });

  it("rejects a locked required field without a value", () => {
    const s = clone(spec("launch"));
    s.sections.find((x) => x.id === "hero")!.fields!.headline = { editable: false, default: "" };
    const r = parseTemplateSpec(s);
    expect(r.ok).toBe(false);
  });

  it("rejects arbitrary top-level keys (no smuggled markup/styles)", () => {
    const s = { ...clone(spec("launch")), css: "body{display:none}" };
    expect(parseTemplateSpec(s).ok).toBe(false);
  });
});

describe("content validation", () => {
  it("builds default content with every editable field and no locked field", () => {
    const s = spec("launch");
    const content = defaultContent(s);
    expect(content.hero?.headline).toBe("Everyday quality, delivered to your door");
    // variant is locked in Launch — never stored in page content.
    expect(content.hero).not.toHaveProperty("variant");
    expect(content.theme).not.toHaveProperty("radius");
    expect(validateContent(s, content, "draft").ok).toBe(true);
  });

  it("allows incomplete drafts but enforces required fields on publish", () => {
    const s = spec("launch");
    const content = defaultContent(s);
    content.hero!.headline = "";
    expect(validateContent(s, content, "draft").ok).toBe(true);
    const pub = validateContent(s, content, "publish");
    expect(pub.ok).toBe(false);
    expect(pub.issues.some((i) => i.path === "hero.headline")).toBe(true);
    // Launch's order CTA is required and defaults to "none" — must be set before publishing.
    expect(pub.issues.some((i) => i.path === "order.cta")).toBe(true);
  });

  it("rejects locked fields, unknown sections and unknown fields", () => {
    const s = spec("launch");
    const content = defaultContent(s) as Record<string, Record<string, unknown>>;
    content.hero!.variant = "split";
    content.injected = { html: "<b>x</b>" };
    content.hero!.onClick = "alert(1)";
    const r = validateContent(s, content, "draft");
    expect(r.ok).toBe(false);
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("hero.variant");
    expect(paths).toContain("injected");
    expect(paths).toContain("hero.onClick");
  });

  it("enforces repeater item requirements and limits on publish", () => {
    const s = spec("launch");
    const content = defaultContent(s);
    content.order!.cta = { label: "Order", action: { kind: "phone", phone: "+8801711000000" } };
    (content.features!.items as unknown[]).push({ icon: "check", title: "", text: "" });
    const r = validateContent(s, content, "publish");
    expect(r.issues.some((i) => /^features\.items\.\d+\.title$/.test(i.path))).toBe(true);

    content.features!.items = Array.from({ length: 13 }, () => ({ icon: "check", title: "x", text: "" }));
    expect(validateContent(s, content, "draft").ok).toBe(false);
  });

  it("strips control and bidi-override characters from text", () => {
    const s = spec("launch");
    const content = defaultContent(s);
    content.hero!.headline = "Hello\u202Edlrow\u0000 there";
    const r = validateContent(s, content, "draft");
    expect(r.content.hero!.headline).toBe("Hellodlrow there");
  });
});

describe("URL and value safety", () => {
  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example/x",
    "https://user:pass@evil.example",
    "#<script>",
    "",
  ])("rejects %j", (url) => {
    expect(safeUrl(url)).toBeNull();
  });

  it.each(["https://shop.example/p?a=1", "http://example.com", "mailto:a@b.co", "tel:+8801711000000", "#order"])(
    "accepts %j",
    (url) => {
      expect(safeUrl(url)).not.toBeNull();
    },
  );

  it("rejects dangerous URLs and colours in content", () => {
    const s = spec("launch");
    const content = defaultContent(s);
    content.hero!.primaryCta = { label: "Go", action: { kind: "link", url: "javascript:alert(document.cookie)" } };
    content.theme!.primary = "#fff;}body{display:none";
    const r = validateContent(s, content, "draft");
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["hero.primaryCta.action.url", "theme.primary"]),
    );
  });

  it("rejects image references that are not asset ids", () => {
    const s = spec("showcase");
    const content = defaultContent(s);
    content.hero!.image = { assetId: "https://evil.example/x.png", alt: "" };
    expect(validateContent(s, content, "draft").ok).toBe(false);
    content.hero!.image = { assetId: ASSET, alt: "Product", src: "javascript:alert(1)" };
    expect(validateContent(s, content, "draft").ok).toBe(false);
  });

  it("builds CTA hrefs only from validated parts", () => {
    expect(ctaHref({ kind: "whatsapp", phone: "+880 1711-000000", message: "Hi & bye" })?.href).toBe(
      "https://wa.me/8801711000000?text=Hi%20%26%20bye",
    );
    expect(ctaHref({ kind: "phone", phone: "+8801711000000" })?.href).toBe("tel:+8801711000000");
    expect(ctaHref({ kind: "link", url: "javascript:alert(1)" })).toBeNull();
    expect(ctaHref({ kind: "section", sectionId: "x\" onmouseover=\"alert(1)" })).toBeNull();
    expect(ctaHref({ kind: "email", email: "a@b.co?bcc=x@y.z" })).toBeNull();
  });

  it("parses rich text into data, never markup", () => {
    const blocks = parseRichText("<script>alert(1)</script>\n\n- **bold** item\n- _it_");
    expect(blocks[0]).toEqual({ type: "paragraph", children: [{ text: "<script>alert(1)</script>" }] });
    expect(blocks[1]).toMatchObject({ type: "list" });
  });
});

describe("rendering", () => {
  it("has a component for every visual section type", () => {
    for (const [key, def] of SECTION_TYPES) {
      if (def.visual) expect(SECTION_COMPONENTS[key], key).toBeTruthy();
    }
  });

  it.each(SYSTEM_TEMPLATES.map((t) => t.key))("renders system template %s from defaults", (key) => {
    const s = spec(key);
    const html = render(s, defaultContent(s));
    const hero = defaultContent(s).hero!.headline as string;
    expect(html).toContain(hero.replace(/&/g, "&amp;"));
    expect(html).not.toMatch(/<script/i);
    for (const section of effectiveSections(s).filter((x) => x.visual)) {
      expect(html).toContain(`id="${section.id}"`);
    }
  });

  it("renders locked template values even if stored content tries to override them", () => {
    const s = spec("launch");
    const content = defaultContent(s) as Record<string, Record<string, unknown>>;
    content.hero!.variant = "banner"; // tampered row
    const html = render(s, content);
    const resolved = resolveContent(s, content);
    expect(resolved.hero!.variant).toBe("centered");
    expect(html).not.toContain("opacity-30"); // banner-only markup
  });

  it("escapes XSS payloads in every text channel", () => {
    const s = spec("local-service");
    const content = defaultContent(s);
    const payload = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
    content.hero!.headline = payload;
    content.about!.body = `**${payload}**\n\n- ${payload}`;
    content.footer!.brandName = payload;
    const html = render(s, content);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops unsafe hrefs, colours and asset ids from tampered stored content", () => {
    const s = spec("launch");
    const content = defaultContent(s) as Record<string, Record<string, unknown>>;
    content.hero!.primaryCta = { label: "Click", action: { kind: "link", url: "javascript:alert(1)" } };
    content.theme!.primary = "red;background:url(javascript:alert(1))";
    content.hero!.image = { assetId: "../../etc/passwd", alt: "x" };
    content.footer!.links = [{ label: "Bad", url: "javascript:alert(1)" }];
    const html = render(s, content);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain("etc/passwd");
    expect(html).toContain("--lp-primary:#4f46e5");
  });

  it("theme tokens only ever emit validated hex colours", () => {
    const style = themeStyle({ primary: "expression(alert(1))", font: "</style><script>" }) as Record<string, string>;
    expect(style["--lp-primary"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(style.fontFamily).not.toContain("<");
  });

  it("renders images only through the configured asset base URL", () => {
    const s = spec("showcase");
    const content = defaultContent(s);
    content.hero!.image = { assetId: ASSET, alt: "Our product" };
    const html = render(s, content);
    expect(html).toContain(`src="https://api.example/api/landing-assets/${ASSET}"`);
    expect(html).toContain('alt="Our product"');
  });

  it("external links get rel=noopener nofollow", () => {
    const s = spec("launch");
    const content = defaultContent(s);
    content.order!.cta = { label: "WhatsApp", action: { kind: "whatsapp", phone: "+8801711000000" } };
    const html = render(s, content);
    expect(html).toMatch(/href="https:\/\/wa\.me\/8801711000000"[^>]*rel="noopener noreferrer nofollow ugc"/);
  });

  it("resolves SEO with fallbacks to visible copy", () => {
    const s = spec("launch");
    const content = defaultContent(s);
    const seo = resolveSeo(s, resolveContent(s, content));
    expect(seo.title).toBe("Everyday quality, delivered to your door");
    expect(seo.noindex).toBe(false);
    content.seo!.title = "Custom title";
    content.seo!.noindex = true;
    const seo2 = resolveSeo(s, resolveContent(s, content));
    expect(seo2.title).toBe("Custom title");
    expect(seo2.noindex).toBe(true);
  });
});

describe("hosts and slugs", () => {
  it("normalises host headers", () => {
    expect(normalizeHost("MyBrand.Pages.Example:443")).toBe("mybrand.pages.example");
    expect(normalizeHost("mybrand.pages.example.")).toBe("mybrand.pages.example");
    for (const bad of ["", "[::1]:80", "127.0.0.1", "a b.example", "evil.example/path", "x@evil.example", "a..b", "-a.example", "a.example:99999x"]) {
      expect(normalizeHost(bad), bad).toBeNull();
    }
  });

  it("extracts exactly one label under the root domain", () => {
    expect(extractLandingLabel("mybrand.pages.example", "pages.example")).toBe("mybrand");
    expect(extractLandingLabel("mybrand.localhost:3002", "localhost")).toBe("mybrand");
    expect(extractLandingLabel("pages.example", "pages.example")).toBeNull();
    expect(extractLandingLabel("a.b.pages.example", "pages.example")).toBeNull();
    expect(extractLandingLabel("mybrand.pages.example.evil.example", "pages.example")).toBeNull();
    expect(extractLandingLabel("mybrandpages.example", "pages.example")).toBeNull();
    expect(extractLandingLabel("admin.pages.example", "pages.example")).toBeNull();
    expect(extractLandingLabel("xn--80ak6aa92e.pages.example", "pages.example")).toBeNull();
  });

  it("validates slugs and reserves sensitive names", () => {
    expect(validateSlug("my-brand").ok).toBe(true);
    for (const bad of ["ab", "-abc", "abc-", "a--b", "xn--abc", "has_underscore", "UPPER case", "www", "api", "bkash", "confirmx"]) {
      expect(validateSlug(bad).ok, bad).toBe(false);
    }
  });
});
