import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { type ContentIssue, type FieldDef, SYSTEM_TEMPLATES, effectiveSections } from "@ecom/landing";

// next/font only works inside the Next compiler.
vi.mock("./bn-font", () => ({ localeInputClass: () => "", editorBnFont: { variable: "" } }));
const { FieldInput, invalidCls } = await import("./field-editor");

const shop = SYSTEM_TEMPLATES.find((t) => t.key === "bd-modern-shop")!;
const sections = effectiveSections(shop.spec, "en");
const fieldOf = (sectionId: string, key: string) => sections.find((s) => s.id === sectionId)!.fields.find((f) => f.key === key)! as FieldDef;
const env = { locale: "en", assetUrl: () => null, upload: async () => ({ id: "x" }), sectionTargets: [{ id: "products", label: "Products" }] };

function render(sectionId: string, key: string, value: unknown, issues: ContentIssue[]) {
  const html = renderToStaticMarkup(
    <FieldInput field={fieldOf(sectionId, key)} value={value} path={`${sectionId}.${key}`} issues={issues} env={env} onChange={() => {}} />,
  );
  const doc = new (class {
    constructor(public html: string) {}
    /** attributes of the first element matching a tag + optional attribute filter */
    el(tag: string, has?: string) {
      const re = new RegExp(`<${tag}\\b[^>]*${has ? has.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : ""}[^>]*>`);
      return re.exec(this.html)?.[0] ?? null;
    }
  })(html);
  return { html, doc };
}
const attrOf = (tag: string | null, name: string) => (tag ? new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null : null);

describe("missing required field — red state and accessibility", () => {
  const missing = [{ path: "hero.headline", message: "Headline is required" }];

  it("marks the control invalid, with the danger styling", () => {
    const { doc } = render("hero", "headline", "", missing);
    const input = doc.el("input");
    expect(attrOf(input, "aria-invalid")).toBe("true");
    for (const cls of invalidCls.split(" ")) expect(input).toContain(cls);
    expect(invalidCls).toMatch(/aria-\[invalid=true\]:border-danger/);
    expect(invalidCls).toMatch(/ring-danger\/20/);
  });

  it("aria-describedby points at the visible inline error, which says what is wrong", () => {
    const { html, doc } = render("hero", "headline", "", missing);
    const describedBy = attrOf(doc.el("input"), "aria-describedby");
    expect(describedBy).toBeTruthy();
    const errorEl = new RegExp(`<p id="${describedBy}"[^>]*>([^<]*)</p>`).exec(html);
    expect(errorEl?.[1]).toBe("Headline is required");
    expect(errorEl?.[0]).toContain("text-danger");
  });

  it("the control is labelled by the visible field label", () => {
    const { html, doc } = render("hero", "headline", "", missing);
    const labelledBy = attrOf(doc.el("input"), "aria-labelledby");
    expect(new RegExp(`<div id="${labelledBy}"[^>]*>Headline`).test(html)).toBe(true);
  });

  it("keeps the existing required asterisk, adds screen-reader text, no extra visible label", () => {
    const { html } = render("hero", "headline", "Hello", []);
    expect(html).toContain('<span aria-hidden="true" class="ml-0.5 text-danger">*</span>');
    expect(html).toContain('<span class="sr-only"> (required)</span>');
    expect(html).not.toMatch(/>Required</);
  });
});

describe("valid field — no error state", () => {
  it("has no aria-invalid, no aria-describedby and no error message", () => {
    const { html, doc } = render("hero", "headline", "Hello", []);
    const input = doc.el("input");
    expect(attrOf(input, "aria-invalid")).toBeNull();
    expect(attrOf(input, "aria-describedby")).toBeNull();
    expect(html).not.toContain("text-2xs text-danger");
  });
});

describe("CTA — the part that is actually missing is marked", () => {
  const issue = [{ path: "order.cta", message: "Button needs somewhere to go (WhatsApp, phone, email or a link)" }];

  it("action not chosen → the action select is invalid, the filled button text is not", () => {
    const { doc } = render("order", "cta", { label: "Order now", action: { kind: "none" } }, issue);
    expect(attrOf(doc.el("select"), "aria-invalid")).toBe("true");
    expect(attrOf(doc.el("select"), "aria-describedby")).toBeTruthy();
    expect(attrOf(doc.el("input", 'aria-label="Button — button text"'), "aria-invalid")).toBeNull();
  });

  it("button text empty → the text input is invalid", () => {
    const { doc } = render("order", "cta", { label: "", action: { kind: "link", url: "https://example.com" } }, issue);
    expect(attrOf(doc.el("input", 'aria-label="Button — button text"'), "aria-invalid")).toBe("true");
    expect(attrOf(doc.el("select"), "aria-invalid")).toBeNull();
  });

  it("every CTA control has an accessible name", () => {
    const { doc } = render("order", "cta", { label: "Hi", action: { kind: "link", url: "" } }, []);
    expect(attrOf(doc.el("select"), "aria-label")).toBe("Button — what the button does");
    expect(doc.el("input", 'aria-label="Button — link"')).not.toBeNull();
  });
});

describe("repeater — the list's own error is shown and announced", () => {
  it("shows the list-level message with an id the Add button references", () => {
    const { html } = render("categories", "items", [], [{ path: "categories.items", message: "Categories is required" }]);
    const btn = /<button[^>]*aria-describedby="([^"]+)"/.exec(html);
    expect(btn).not.toBeNull();
    expect(html).toContain(`<p id="${btn![1]}" class="text-2xs text-danger">Categories is required</p>`);
  });
});
