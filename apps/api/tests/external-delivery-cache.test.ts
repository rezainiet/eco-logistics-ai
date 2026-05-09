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

  it("cacheKey is keyed (merchantHex, phoneHash) — merchant scope baked in", () => {
    const k = __TEST.cacheKey({
      merchantHex: "507f1f77bcf86cd799439011",
      phoneHash: "a".repeat(32),
    });
    expect(k).toBe(`extdp:v1:507f1f77bcf86cd799439011:${"a".repeat(32)}`);
  });

  it("two merchants observing the same phone produce DIFFERENT cache keys", () => {
    const a = __TEST.cacheKey({
      merchantHex: "507f1f77bcf86cd799439011",
      phoneHash: "phone1",
    });
    const b = __TEST.cacheKey({
      merchantHex: "507f1f77bcf86cd799439022",
      phoneHash: "phone1",
    });
    expect(a).not.toBe(b);
  });

  it("ttlSeconds returns the env-driven default with a 60s floor", () => {
    const ttl = __TEST.ttlSeconds();
    expect(ttl).toBeGreaterThanOrEqual(60);
    // Default 24h = 86400s; env clamps to [1,168] hours.
    expect(ttl).toBeLessThanOrEqual(168 * 60 * 60);
  });
});
