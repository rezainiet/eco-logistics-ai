import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isPrivateOrLoopbackHost } from "@ecom/types";
import {
  assertPublicHost,
  safeFetch,
} from "../src/lib/integrations/safe-fetch.js";
import { IntegrationError } from "../src/lib/integrations/types.js";

/**
 * SSRF guard test.
 *
 * The static URL validator (`isAllowedWooSiteUrl`) rejects private IP
 * literals at connect time. This test layer exercises the second-line
 * guard — `safeFetch` / `assertPublicHost` — which DNS-resolves the
 * hostname and re-checks the predicate against the resolved address.
 *
 * NODE_ENV is flipped to "production" inside the SSRF test cases because
 * the assertion is intentionally a no-op in dev/test (so local dev
 * sandboxes keep working). Each test restores the original env in
 * afterAll. We DON'T touch the global env outside the production-mode
 * cases so unrelated tests aren't affected.
 */

const PRIOR_NODE_ENV = process.env.NODE_ENV;
afterAll(() => {
  // Be paranoid about restoring NODE_ENV even if a test bails mid-flight.
  if (PRIOR_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = PRIOR_NODE_ENV;
});

describe("isPrivateOrLoopbackHost (pure predicate)", () => {
  it("rejects loopback v4", () => {
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.55.55.1")).toBe(true);
  });

  it("rejects RFC1918 ranges", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.31.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.1.1")).toBe(true);
  });

  it("rejects link-local (incl. AWS metadata 169.254.169.254)", () => {
    expect(isPrivateOrLoopbackHost("169.254.169.254")).toBe(true);
  });

  it("rejects 0.0.0.0/8 + multicast + broadcast", () => {
    expect(isPrivateOrLoopbackHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrLoopbackHost("224.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("255.255.255.255")).toBe(true);
  });

  it("rejects IPv6 loopback / ULA / link-local", () => {
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fc00::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fd00::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fe80::1")).toBe(true);
  });

  it("accepts a public IPv4", () => {
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackHost("203.0.113.42")).toBe(false);
  });

  it("accepts a public hostname (not an IP)", () => {
    // The predicate is IP-only — non-numeric hostnames return false here
    // and the DNS-resolve step is responsible for the real check.
    expect(isPrivateOrLoopbackHost("merchant.example.com")).toBe(false);
  });
});

describe("assertPublicHost (DNS-resolve guard)", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  it("rejects an IP-literal hostname in private range without DNS lookup", async () => {
    await expect(assertPublicHost("169.254.169.254")).rejects.toThrow(
      /ssrf: refusing to call private host/i,
    );
  });

  it("rejects IPv6 loopback literal", async () => {
    await expect(assertPublicHost("::1")).rejects.toThrow(/ssrf/i);
  });

  it("rejects a public hostname whose DNS records point at a private IP (rebinding)", async () => {
    // Mock dns.lookup so we don't need real network. The hostname looks
    // public, the resolved A record is the AWS metadata IP — exactly
    // the rebinding shape the static check misses.
    const dnsModule = await import("node:dns/promises");
    const spy = vi
      .spyOn(dnsModule.default, "lookup")
      .mockImplementation((async () => [
        { address: "169.254.169.254", family: 4 },
      ]) as never);
    try {
      await expect(assertPublicHost("evil.example.com")).rejects.toThrow(
        /ssrf:.*resolves to private ip/i,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("allows a public hostname that resolves to a public IP", async () => {
    const dnsModule = await import("node:dns/promises");
    const spy = vi
      .spyOn(dnsModule.default, "lookup")
      .mockImplementation((async () => [
        { address: "8.8.8.8", family: 4 },
      ]) as never);
    try {
      await expect(assertPublicHost("dns.google")).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("blocks dual-stack victims where IPv4 is public but IPv6 is link-local", async () => {
    const dnsModule = await import("node:dns/promises");
    const spy = vi
      .spyOn(dnsModule.default, "lookup")
      .mockImplementation((async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "fe80::abcd", family: 6 },
      ]) as never);
    try {
      await expect(assertPublicHost("dual-stack.example.com")).rejects.toThrow(
        /ssrf/i,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a hostname that fails to resolve (suspicious / dangling)", async () => {
    const dnsModule = await import("node:dns/promises");
    const spy = vi
      .spyOn(dnsModule.default, "lookup")
      .mockImplementation((async () => {
        throw new Error("ENOTFOUND");
      }) as never);
    try {
      await expect(
        assertPublicHost("does-not-resolve.invalid"),
      ).rejects.toThrow(/ssrf: cannot resolve/i);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("assertPublicHost — non-production", () => {
  it("is a no-op in dev/test so localhost dev sandboxes keep working", async () => {
    process.env.NODE_ENV = "test";
    await expect(assertPublicHost("127.0.0.1")).resolves.toBeUndefined();
    await expect(assertPublicHost("localhost")).resolves.toBeUndefined();
  });
});

describe("safeFetch wrapper", () => {
  it("calls the injected fetchImpl after the SSRF check passes", async () => {
    process.env.NODE_ENV = "test"; // skip DNS so test runs offline
    const stubResponse = {
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => stubResponse);
    const res = await safeFetch(
      "https://merchant.example.com/wp-json/wc/v3/system_status",
      { method: "GET" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res).toBe(stubResponse);
  });

  it("never invokes fetchImpl when the SSRF check fails (production)", async () => {
    process.env.NODE_ENV = "production";
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not be called");
    });
    await expect(
      safeFetch(
        "http://10.0.0.5/wp-json/wc/v3/system_status",
        {},
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(IntegrationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs without ever resolving DNS", async () => {
    process.env.NODE_ENV = "production";
    const fetchImpl = vi.fn();
    await expect(
      safeFetch(
        "not-a-url",
        {},
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/ssrf: invalid url/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
