import { describe, expect, it } from "vitest";
import { subdomainBaseOf } from "../src/lib/landing/pages.js";

// The landing editor showed a literal "<slug>.<landing domain>" hint; it now
// shows the real host derived from LANDING_PUBLIC_URL_PATTERN.
describe("subdomainBaseOf", () => {
  it("extracts the host under the {slug} label", () => {
    expect(subdomainBaseOf("https://{slug}.confirmx.ai")).toBe("confirmx.ai");
    expect(subdomainBaseOf("https://{slug}.confirmx.ai/")).toBe("confirmx.ai");
    expect(subdomainBaseOf("http://{slug}.localhost:3002")).toBe("localhost:3002");
  });
  it("returns null when hosting is off or the pattern isn't a subdomain pattern", () => {
    expect(subdomainBaseOf(null)).toBeNull();
    expect(subdomainBaseOf(undefined)).toBeNull();
    expect(subdomainBaseOf("")).toBeNull();
    expect(subdomainBaseOf("https://pages.confirmx.ai/{slug}")).toBeNull();
    expect(subdomainBaseOf("https://{slug}.")).toBeNull();
  });
});
