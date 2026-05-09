import { describe, expect, it } from "vitest";
import { __TEST } from "../src/lib/external-delivery/cache.js";

/**
 * Unit-only tests for the cache helpers. The real Redis-backed
 * round-trip is covered by the orchestrator integration test in S5
 * (which uses a mocked Redis via the existing test harness pattern).
 *
 * These tests pin the contract: versioned key prefix, TTL clamping,
 * key shape stability.
 */

describe("external-delivery / cache key contract", () => {
  it("keyPrefix is versioned (extdp:v1:)", () => {
    expect(__TEST.KEY_PREFIX).toBe("extdp:v1:");
  });

  it("cacheKey produces stable shape", () => {
    const k = __TEST.cacheKey("a".repeat(32));
    expect(k).toBe(`extdp:v1:${"a".repeat(32)}`);
  });

  it("cacheKey passes any phoneHash form (no normalisation here)", () => {
    // The key prefix is the only stability guarantee. Hash normalisation
    // happens upstream in lib/external-delivery/normalization.ts.
    const a = __TEST.cacheKey("foo");
    const b = __TEST.cacheKey("FOO");
    expect(a).not.toBe(b);
  });

  it("ttlSeconds returns the env-driven default with a 60s floor", () => {
    const ttl = __TEST.ttlSeconds();
    expect(ttl).toBeGreaterThanOrEqual(60);
    // Default 24h = 86400s; env clamps to [1,168] hours.
    expect(ttl).toBeLessThanOrEqual(168 * 60 * 60);
  });
});
