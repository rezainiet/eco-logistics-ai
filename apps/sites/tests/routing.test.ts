import { describe, expect, it } from "vitest";
import { PREVIEW_MESSAGE_SOURCE, SYSTEM_TEMPLATES, parsePreviewMessage } from "@ecom/landing";
import { routeFor } from "../src/lib/routing";

const cfg = { rootDomain: "pages.test", previewHost: "preview.pages.test" };

describe("host routing", () => {
  it("routes a tenant host to its page, default and explicit locales", () => {
    expect(routeFor("mybrand.pages.test", "/", cfg)).toEqual({ kind: "page", label: "mybrand", locale: null });
    expect(routeFor("MyBrand.Pages.Test:443", "/en", cfg)).toEqual({ kind: "page", label: "mybrand", locale: "en" });
    expect(routeFor("mybrand.pages.test", "/bn/", cfg)).toEqual({ kind: "page", label: "mybrand", locale: "bn" });
  });

  it("serves nothing else on tenant hosts", () => {
    for (const path of ["/fr", "/admin", "/lp/other", "/preview-frame", "/en/x", "/../", "/%2e%2e"]) {
      expect(routeFor("mybrand.pages.test", path, cfg), path).toEqual({ kind: "not_found" });
    }
  });

  it("rejects malformed, reserved, nested and foreign hosts", () => {
    for (const host of [
      "",
      null,
      "pages.test",
      "a.b.pages.test",
      "admin.pages.test",
      "www.pages.test",
      "mybrand.pages.test.evil.example",
      "mybrand.other.test",
      "[::1]",
      "127.0.0.1",
      "xn--80ak6aa92e.pages.test",
    ]) {
      expect(routeFor(host, "/", cfg), String(host)).toEqual({ kind: "not_found" });
    }
  });

  it("routes only the preview host root to the preview frame", () => {
    expect(routeFor("preview.pages.test", "/", cfg)).toEqual({ kind: "preview" });
    expect(routeFor("preview.pages.test", "/lp/mybrand", cfg)).toEqual({ kind: "not_found" });
    // "preview" is a reserved slug, so without a configured preview host it is nothing.
    expect(routeFor("preview.pages.test", "/", { ...cfg, previewHost: null })).toEqual({ kind: "not_found" });
  });

  it("fails closed without a root domain (production before the domain phase)", () => {
    expect(routeFor("mybrand.pages.test", "/", { rootDomain: null, previewHost: null })).toEqual({ kind: "not_found" });
  });
});

describe("preview protocol", () => {
  const spec = SYSTEM_TEMPLATES.find((t) => t.key === "bd-modern-shop")!.spec;

  it("accepts a well-formed render message", () => {
    const m = parsePreviewMessage({ source: PREVIEW_MESSAGE_SOURCE, type: "render", spec, content: {}, locale: "bn" });
    expect(m?.locale).toBe("bn");
  });

  it("rejects foreign, malformed or dangerous messages", () => {
    expect(parsePreviewMessage(null)).toBeNull();
    expect(parsePreviewMessage({ type: "render", spec, content: {}, locale: "bn" })).toBeNull();
    expect(parsePreviewMessage({ source: PREVIEW_MESSAGE_SOURCE, type: "render", spec, content: {}, locale: "fr" })).toBeNull();
    const evil = { ...spec, sections: [...spec.sections, { id: "x", type: "iframe", typeVersion: 1 }] };
    expect(parsePreviewMessage({ source: PREVIEW_MESSAGE_SOURCE, type: "render", spec: evil, content: {}, locale: "en" })).toBeNull();
    const huge = { source: PREVIEW_MESSAGE_SOURCE, type: "render", spec, content: { x: "a".repeat(500_000) }, locale: "en" };
    expect(parsePreviewMessage(huge)).toBeNull();
  });
});
