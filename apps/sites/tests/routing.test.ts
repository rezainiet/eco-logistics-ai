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

describe("custom domains", () => {
  const on = { ...cfg, customDomains: true };

  it("are off unless enabled: a foreign host is not found", () => {
    expect(routeFor("shop.example.com", "/", cfg)).toEqual({ kind: "not_found" });
  });

  it("route a merchant's own domain by its full hostname, with the same path rules", () => {
    expect(routeFor("Shop.Example.com:443", "/", on)).toEqual({ kind: "page", label: "shop.example.com", locale: null });
    expect(routeFor("example.com", "/en", on)).toEqual({ kind: "page", label: "example.com", locale: "en" });
    for (const path of ["/admin", "/lp/other", "/preview-frame", "/fr"]) {
      expect(routeFor("shop.example.com", path, on), path).toEqual({ kind: "not_found" });
    }
  });

  it("never treat platform names, IPs, wildcards or dev-only names as custom domains", () => {
    for (const host of ["a.b.pages.test", "pages.test", "admin.pages.test", "api.confirmx.ai", "x.y.confirmx.ai", "confirmx.ai", "127.0.0.1", "[::1]", "localhost", "shop.localhost", "shop.test", "*.example.com"]) {
      expect(routeFor(host, "/", on), host).toEqual({ kind: "not_found" });
    }
    // Platform subdomains keep routing by label exactly as before.
    expect(routeFor("mybrand.pages.test", "/", on)).toEqual({ kind: "page", label: "mybrand", locale: null });
    expect(routeFor("preview.pages.test", "/", on)).toEqual({ kind: "preview" });
  });

  it("dev-only names are accepted only when explicitly allowed", () => {
    expect(routeFor("shop.test", "/", { ...on, rootDomain: "localhost", allowNonPublicDomains: true })).toEqual({ kind: "page", label: "shop.test", locale: null });
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
