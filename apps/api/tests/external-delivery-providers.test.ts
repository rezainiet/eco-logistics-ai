import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundedFetch } from "../src/lib/external-delivery/providers/bounded.js";
import {
  DEFAULT_EXTERNAL_PROVIDERS,
  pathaoAdapter,
  redxAdapter,
  steadfastAdapter,
} from "../src/lib/external-delivery/providers/index.js";
import { env } from "../src/env.js";

type MutableEnv = {
  EXTERNAL_DELIVERY_PATHAO_ENABLED: boolean;
  EXTERNAL_DELIVERY_STEADFAST_ENABLED: boolean;
  EXTERNAL_DELIVERY_REDX_ENABLED: boolean;
};
const original: MutableEnv = {
  EXTERNAL_DELIVERY_PATHAO_ENABLED: env.EXTERNAL_DELIVERY_PATHAO_ENABLED,
  EXTERNAL_DELIVERY_STEADFAST_ENABLED: env.EXTERNAL_DELIVERY_STEADFAST_ENABLED,
  EXTERNAL_DELIVERY_REDX_ENABLED: env.EXTERNAL_DELIVERY_REDX_ENABLED,
};
const TEST_MERCHANT_ID = "507f1f77bcf86cd799439011";

beforeEach(() => {
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_PATHAO_ENABLED = false;
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_STEADFAST_ENABLED = false;
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_REDX_ENABLED = false;
});
afterEach(() => {
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_PATHAO_ENABLED =
    original.EXTERNAL_DELIVERY_PATHAO_ENABLED;
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_STEADFAST_ENABLED =
    original.EXTERNAL_DELIVERY_STEADFAST_ENABLED;
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_REDX_ENABLED =
    original.EXTERNAL_DELIVERY_REDX_ENABLED;
});

/* -------------------------------------------------------------------------- */

describe("external-delivery / boundedFetch", () => {
  it("returns ok payload with computed successRate when work resolves", async () => {
    const r = await boundedFetch({
      input: {
        merchantId: TEST_MERCHANT_ID,
        normalizedPhone: "8801712345678",
        timeoutMs: 1000,
      },
      work: async () => ({ total: 10, delivered: 9, rto: 1, cancelled: 0 }),
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.total).toBe(10);
    expect(r.successRate).toBeCloseTo(0.9, 3);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("times out when work takes longer than timeoutMs", async () => {
    const r = await boundedFetch({
      input: {
        merchantId: TEST_MERCHANT_ID,
        normalizedPhone: "8801712345678",
        timeoutMs: 50,
      },
      work: (signal) =>
        new Promise<{ total: number; delivered: number; rto: number; cancelled: number }>(
          (_resolve, reject) => {
            // Simulate a slow HTTP that respects the abort signal.
            const t = setTimeout(
              () =>
                _resolve({ total: 1, delivered: 1, rto: 0, cancelled: 0 }),
              500,
            );
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("aborted by timeout"));
            });
          },
        ),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("timeout");
    expect(r.timedOut).toBe(true);
  });

  it("routes thrown errors via classifyError", async () => {
    const r = await boundedFetch({
      input: {
        merchantId: TEST_MERCHANT_ID,
        normalizedPhone: "8801712345678",
        timeoutMs: 1000,
      },
      work: async () => {
        throw new Error("upstream returned 500");
      },
      classifyError: () => "http_error",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("http_error");
    expect(r.timedOut).toBe(false);
    expect(r.detail).toContain("500");
  });

  it("returns aborted when caller's signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await boundedFetch({
      input: {
        merchantId: TEST_MERCHANT_ID,
        normalizedPhone: "8801712345678",
        timeoutMs: 1000,
        signal: ac.signal,
      },
      work: async () => ({ total: 1, delivered: 1, rto: 0, cancelled: 0 }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("aborted");
  });

  it("defaults classifier to 'unexpected'", async () => {
    const r = await boundedFetch({
      input: {
        merchantId: TEST_MERCHANT_ID,
        normalizedPhone: "8801712345678",
        timeoutMs: 1000,
      },
      work: async () => {
        throw new Error("boom");
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("unexpected");
  });
});

/* -------------------------------------------------------------------------- */

describe("external-delivery / provider stubs", () => {
  it("DEFAULT_EXTERNAL_PROVIDERS lists bdcourier first (real adapter), then per-merchant stubs", () => {
    expect(DEFAULT_EXTERNAL_PROVIDERS.map((p) => p.name)).toEqual([
      "bdcourier",
      "pathao",
      "steadfast",
      "redx",
    ]);
  });

  it("each adapter exposes a stable name + sourceVersion label", () => {
    for (const a of DEFAULT_EXTERNAL_PROVIDERS) {
      expect(typeof a.name).toBe("string");
      expect(a.name.length).toBeGreaterThan(0);
      expect(typeof a.sourceVersion).toBe("string");
      // bdcourier is a real adapter; pathao/steadfast/redx are stubs.
      // Both shapes match a versioned label.
      expect(a.sourceVersion).toMatch(/-(stub-)?v\d+$/);
    }
  });

  it("isConfigured returns false when its env flag is off", () => {
    expect(pathaoAdapter.isConfigured()).toBe(false);
    expect(steadfastAdapter.isConfigured()).toBe(false);
    expect(redxAdapter.isConfigured()).toBe(false);
  });

  it("isConfigured still returns false even when env flag flipped on (stub safety)", () => {
    // Until real HTTP wiring lands, the stubs intentionally never claim
    // configured even when the env flag is on. This prevents accidental
    // production traffic against an unimplemented endpoint.
    (env as unknown as MutableEnv).EXTERNAL_DELIVERY_PATHAO_ENABLED = true;
    (env as unknown as MutableEnv).EXTERNAL_DELIVERY_STEADFAST_ENABLED = true;
    (env as unknown as MutableEnv).EXTERNAL_DELIVERY_REDX_ENABLED = true;
    expect(pathaoAdapter.isConfigured()).toBe(false);
    expect(steadfastAdapter.isConfigured()).toBe(false);
    expect(redxAdapter.isConfigured()).toBe(false);
  });

  it("fetchHistory always resolves to stub_unconfigured for stubs", async () => {
    for (const a of DEFAULT_EXTERNAL_PROVIDERS) {
      const r = await a.fetchHistory({
        merchantId: TEST_MERCHANT_ID,
        normalizedPhone: "8801712345678",
        timeoutMs: 1000,
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected error");
      expect(r.error).toBe("stub_unconfigured");
    }
  });

  it("fetchHistory NEVER throws on degenerate input", async () => {
    for (const a of DEFAULT_EXTERNAL_PROVIDERS) {
      await expect(
        a.fetchHistory({
          merchantId: "",
          normalizedPhone: "",
          timeoutMs: 0,
        }),
      ).resolves.toBeDefined();
    }
  });
});
