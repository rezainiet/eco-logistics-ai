import { describe, expect, it } from "vitest";
import {
  type LocaleSettings,
  type LocalizedContent,
  SYSTEM_TEMPLATES,
  defaultLocalizedContent,
  validateLocalizedContent,
} from "@ecom/landing";
import {
  blockerHeadline,
  blockerWhere,
  describePublishBlockers,
  fieldIssuesForLocale,
  parseServerPublishIssues,
} from "./publish-blockers";

// The real template and the real validator the server runs on publish.
const shop = SYSTEM_TEMPLATES.find((t) => t.key === "bd-modern-shop")!;
const spec = shop.spec;

function page(locales: LocaleSettings["locales"]) {
  const settings: LocaleSettings = { locales, defaultLocale: locales[0]! };
  return { settings, content: defaultLocalizedContent(spec, locales) as LocalizedContent };
}
function check(content: LocalizedContent, settings: LocaleSettings) {
  const draft = validateLocalizedContent(spec, content, settings, "draft");
  const publish = validateLocalizedContent(spec, content, settings, "publish");
  return { draft: draft.issues, publish: publish.issues, blockers: describePublishBlockers(spec, publish.issues, draft.issues) };
}
function setField(content: LocalizedContent, locale: "en" | "bn", section: string, key: string, value: unknown) {
  content[locale] = { ...content[locale], [section]: { ...(content[locale]?.[section] ?? {}), [key]: value } };
}

describe("describePublishBlockers — labels come from the template, never internal keys", () => {
  it("one missing field: the fresh BD Modern Shop page (the live merchant's case)", () => {
    const { settings, content } = page(["en"]);
    const { publish, blockers } = check(content, settings);
    expect(publish).toEqual([{ path: "en.order.cta", message: "Button needs somewhere to go (WhatsApp, phone, email or a link)" }]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      locale: "en",
      fieldPath: "order.cta",
      sectionId: "order",
      sectionLabel: "Order call to action",
      fieldLabel: "Button",
      missing: true,
    });
    expect(blockerHeadline(blockers)).toBe("1 required field is missing");
  });

  it("multiple missing fields: every one is listed by its label", () => {
    const { settings, content } = page(["en"]);
    setField(content, "en", "hero", "headline", "");
    setField(content, "en", "offer", "heading", "   ");
    const { blockers } = check(content, settings);
    expect(blockers.map((b) => `${b.sectionLabel} / ${b.fieldLabel}`)).toEqual([
      "Promotional hero / Headline",
      "Offer / flash sale / Heading",
      "Order call to action / Button",
    ]);
    expect(blockers.map((b) => b.message)).toEqual([
      "Headline is required",
      "Heading is required",
      "Button needs somewhere to go (WhatsApp, phone, email or a link)",
    ]);
    expect(blockerHeadline(blockers)).toBe("3 required fields are missing");
    for (const b of blockers) {
      expect(b.fieldLabel).not.toMatch(/\.|^[a-z]+[A-Z]/); // no "hero.headline", no "ctaUrl"
    }
  });

  it("repeater item fields are labelled with the item and its position", () => {
    const { settings, content } = page(["en"]);
    const items = [...((content.en!.categories!.items as Array<Record<string, unknown>>) ?? [])];
    items[1] = { ...items[1], name: "" };
    setField(content, "en", "categories", "items", items);
    const { blockers } = check(content, settings);
    const b = blockers.find((x) => x.sectionId === "categories")!;
    expect(b.fieldPath).toBe("categories.items.1.name");
    expect(b.fieldLabel).toMatch(/^Categories → .+ 2 → Name$/);
  });

  it("each language is its own entry; the language shows only on multi-language pages", () => {
    const { settings, content } = page(["en", "bn"]);
    const { blockers } = check(content, settings);
    expect(blockers.map((b) => b.key)).toEqual(["en.order.cta", "bn.order.cta"]);
    expect(blockerWhere(blockers[1]!, true)).toBe("Order call to action · বাংলা");
    expect(blockerWhere(blockers[1]!, false)).toBe("Order call to action");
  });

  it("a value error inside a field collapses onto that field and is 'invalid', not 'missing'", () => {
    const issue = { path: "en.order.cta.action.url", message: "Enter a valid link" };
    const [b] = describePublishBlockers(spec, [issue], [issue]);
    expect(b).toMatchObject({ fieldPath: "order.cta", fieldLabel: "Button", missing: false });
    expect(blockerHeadline([b!])).toBe("1 field needs fixing");
  });

  it("unmappable issues are kept (not dropped) with their message and no jump target", () => {
    const [b] = describePublishBlockers(spec, [{ path: "fr", message: 'Language "fr" is not enabled for this page' }]);
    expect(b).toMatchObject({ fieldPath: null, fieldLabel: 'Language "fr" is not enabled for this page' });
  });

  it("one entry per field even when the validator reports it twice", () => {
    const i = { path: "en.hero.headline", message: "Headline is required" };
    expect(describePublishBlockers(spec, [i, { ...i, message: "other" }])).toHaveLength(1);
  });

  it("does not change the validator's result (server rules stay authoritative)", () => {
    const { settings, content } = page(["en", "bn"]);
    const publish = Object.freeze(validateLocalizedContent(spec, content, settings, "publish").issues.map((i) => Object.freeze({ ...i })));
    const before = JSON.stringify(publish);
    describePublishBlockers(spec, publish);
    expect(JSON.stringify(publish)).toBe(before);
    expect(validateLocalizedContent(spec, content, settings, "publish").ok).toBe(false);
  });
});

describe("fieldIssuesForLocale — red states follow the live validation", () => {
  it("required issues appear only after a blocked publish, then clear and return with the value", () => {
    const { settings, content } = page(["en"]);
    let r = check(content, settings);
    expect(fieldIssuesForLocale("en", r.draft, r.publish, false)).toEqual([]); // no nagging before a publish attempt
    expect(fieldIssuesForLocale("en", r.draft, r.publish, true)).toEqual([
      { path: "order.cta", message: "Button needs somewhere to go (WhatsApp, phone, email or a link)" },
    ]);

    // Fill the field → the error is gone immediately, no second publish needed.
    setField(content, "en", "order", "cta", { label: "Order now", action: { kind: "section", sectionId: "products" } });
    r = check(content, settings);
    expect(r.blockers).toEqual([]);
    expect(fieldIssuesForLocale("en", r.draft, r.publish, true)).toEqual([]);

    // Empty it again → the error comes back.
    setField(content, "en", "order", "cta", { label: "Order now", action: { kind: "none" } });
    r = check(content, settings);
    expect(fieldIssuesForLocale("en", r.draft, r.publish, true).map((i) => i.path)).toEqual(["order.cta"]);
  });

  it("keeps each language's issues on that language only", () => {
    const { settings, content } = page(["en", "bn"]);
    setField(content, "en", "order", "cta", { label: "Order", action: { kind: "section", sectionId: "products" } });
    const r = check(content, settings);
    expect(fieldIssuesForLocale("en", r.draft, r.publish, true)).toEqual([]);
    expect(fieldIssuesForLocale("bn", r.draft, r.publish, true).map((i) => i.path)).toEqual(["order.cta"]);
  });
});

describe("parseServerPublishIssues — the server's 'Page not published' error maps back to fields", () => {
  // Same format as apps/api issuesError(): "<prefix> — <path>: <message>; …" (+N more).
  const serverMessage = (issues: Array<{ path: string; message: string }>, more = 0) =>
    `Page not published — ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}${more ? ` (+${more} more)` : ""}`;

  it("recovers every issue with its path", () => {
    const issues = [
      { path: "bn.order.cta", message: "Button needs somewhere to go (WhatsApp, phone, email or a link)" },
      { path: "en.hero.headline", message: "Headline is required" },
    ];
    expect(parseServerPublishIssues(serverMessage(issues, 3))).toEqual(issues);
    const blockers = describePublishBlockers(spec, parseServerPublishIssues(serverMessage(issues)));
    expect(blockers.map((b) => b.fieldLabel)).toEqual(["Button", "Headline"]);
  });

  it("ignores every other error", () => {
    expect(parseServerPublishIssues("Choose a subdomain for this page before publishing")).toEqual([]);
    expect(parseServerPublishIssues("This page was changed in another tab or by someone else.")).toEqual([]);
  });
});
