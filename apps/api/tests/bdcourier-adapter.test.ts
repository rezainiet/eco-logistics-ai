import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bdcourierAdapter,
  parseBdCourierResponse,
} from "../src/lib/external-delivery/providers/bdcourier.js";
import { env } from "../src/env.js";

type MutableEnv = {
  BDCOURIER_ENABLED: boolean;
  BDCOURIER_API_KEY: string | undefined;
  BDCOURIER_TIMEOUT_MS: number;
  BDCOURIER_BASE_URL: string;
};

const original: MutableEnv = {
  BDCOURIER_ENABLED: env.BDCOURIER_ENABLED,
  BDCOURIER_API_KEY: env.BDCOURIER_API_KEY,
  BDCOURIER_TIMEOUT_MS: env.BDCOURIER_TIMEOUT_MS,
  BDCOURIER_BASE_URL: env.BDCOURIER_BASE_URL,
};

beforeEach(() => {
  (env as unknown as MutableEnv).BDCOURIER_ENABLED = false;
  (env as unknown as MutableEnv).BDCOURIER_API_KEY = undefined;
});
afterEach(() => {
  (env as unknown as MutableEnv).BDCOURIER_ENABLED = original.BDCOURIER_ENABLED;
  (env as unknown as MutableEnv).BDCOURIER_API_KEY = original.BDCOURIER_API_KEY;
  (env as unknown as MutableEnv).BDCOURIER_TIMEOUT_MS =
    original.BDCOURIER_TIMEOUT_MS;
  (env as unknown as MutableEnv).BDCOURIER_BASE_URL = original.BDCOURIER_BASE_URL;
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* parseBdCourierResponse — pure function, tested without HTTP                */
/* -------------------------------------------------------------------------- */

describe("parseBdCourierResponse — variant shapes", () => {
  it("variant A: courierData.summary with successful_parcel + cancelled_parcel", () => {
    const r = parseBdCourierResponse({
      courierData: {
        summary: {
          total_parcel: 100,
          successful_parcel: 85,
          cancelled_parcel: 15,
        },
        courier: { pathao: { total: 50 } }, // ignored — discarded in v1
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.counters).toEqual({
      total: 100,
      delivered: 85,
      rto: 0,
      cancelled: 15,
    });
  });

  it("variant B: data.summary shape", () => {
    const r = parseBdCourierResponse({
      data: {
        summary: { total: 30, delivered: 20, cancelled: 10 },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.counters).toEqual({
      total: 30,
      delivered: 20,
      rto: 0,
      cancelled: 10,
    });
  });

  it("variant C: flat top-level fields", () => {
    const r = parseBdCourierResponse({
      total_parcel: 8,
      successful_parcel: 7,
      cancelled_parcel: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.counters).toEqual({
      total: 8,
      delivered: 7,
      rto: 0,
      cancelled: 1,
    });
  });

  it("infers total when missing (delivered + cancelled)", () => {
    const r = parseBdCourierResponse({
      courierData: {
        summary: { successful_parcel: 5, cancelled_parcel: 3 },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.counters.total).toBe(8);
  });
});

describe("parseBdCourierResponse — defensive coercion", () => {
  it("coerces stringified numbers from the upstream", () => {
    const r = parseBdCourierResponse({
      summary: {
        total_parcel: "50",
        successful_parcel: "45",
        cancelled_parcel: "5",
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.counters.total).toBe(50);
    expect(r.counters.delivered).toBe(45);
  });

  it("treats absent summary fields as zero counters", () => {
    const r = parseBdCourierResponse({});
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.counters).toEqual({ total: 0, delivered: 0, rto: 0, cancelled: 0 });
  });

  it("DISCARDS reports[] and per-courier breakdowns silently", () => {
    const r = parseBdCourierResponse({
      data: { summary: { total: 10, delivered: 9, cancelled: 1 } },
      reports: [
        { reason: "scam", reporter: "merchant_x", createdAt: "2025-01-01" },
      ],
    });
    expect(r.ok).toBe(true);
    // The mapper's output has NO reports field. Verified by shape.
    if (!r.ok) throw new Error("expected ok");
    expect(Object.keys(r.counters).sort()).toEqual(
      ["cancelled", "delivered", "rto", "total"],
    );
  });
});

describe("parseBdCourierResponse — bad payloads", () => {
  it("returns bad_payload on null / non-object", () => {
    const r1 = parseBdCourierResponse(null);
    expect(r1.ok).toBe(false);
    const r2 = parseBdCourierResponse("hello");
    expect(r2.ok).toBe(false);
  });

  it("returns bad_payload when delivered + cancelled exceeds total", () => {
    const r = parseBdCourierResponse({
      summary: { total: 5, delivered: 4, cancelled: 4 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("bad_payload");
    expect(r.detail).toContain("inconsistent");
  });

  it("returns bad_payload on negative / non-finite counters", () => {
    const r = parseBdCourierResponse({
      summary: {
        total: 10,
        delivered: -1,
        cancelled: 0,
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("bad_payload");
  });

  it("never throws on adversarial input", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      [],
      0,
      true,
      { courierData: "wrong-type" },
      { data: { summary: { total: "not-a-number-at-all" } } },
    ];
    for (const i of inputs) {
      expect(() => parseBdCourierResponse(i)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Adapter behaviour                                                          */
/* -------------------------------------------------------------------------- */

describe("bdcourierAdapter — isConfigured", () => {
  it("returns false when flag is off", () => {
    (env as unknown as MutableEnv).BDCOURIER_ENABLED = false;
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = "secret";
    expect(bdcourierAdapter.isConfigured()).toBe(false);
  });

  it("returns false when flag is on but API key is unset", () => {
    (env as unknown as MutableEnv).BDCOURIER_ENABLED = true;
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = undefined;
    expect(bdcourierAdapter.isConfigured()).toBe(false);
  });

  it("returns true when both flag and key are set", () => {
    (env as unknown as MutableEnv).BDCOURIER_ENABLED = true;
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = "test-key";
    expect(bdcourierAdapter.isConfigured()).toBe(true);
  });
});

describe("bdcourierAdapter — fetchHistory", () => {
  it("returns stub_unconfigured when API key is missing (defence-in-depth)", async () => {
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = undefined;
    const r = await bdcourierAdapter.fetchHistory({
      merchantId: "merchA",
      normalizedPhone: "8801712345678",
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("stub_unconfigured");
  });

  it("returns ok counters on a healthy 200 response", async () => {
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = "test-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          courierData: {
            summary: {
              total_parcel: 25,
              successful_parcel: 22,
              cancelled_parcel: 3,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await bdcourierAdapter.fetchHistory({
      merchantId: "merchA",
      normalizedPhone: "8801712345678",
      timeoutMs: 1000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.delivered).toBe(22);
    expect(r.cancelled).toBe(3);
    expect(r.successRate).toBeCloseTo(22 / 22, 5); // delivered / (delivered + rto), rto=0
  });

  it("never includes the API key in the URL — only in Authorization header", async () => {
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = "test-key-secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await bdcourierAdapter.fetchHistory({
      merchantId: "merchA",
      normalizedPhone: "8801712345678",
      timeoutMs: 1000,
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).not.toContain("test-key-secret");
    expect(String(url)).toContain("8801712345678");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key-secret");
  });

  it("classifies 5xx responses as http_error", async () => {
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 503 }),
    );
    const r = await bdcourierAdapter.fetchHistory({
      merchantId: "merchA",
      normalizedPhone: "8801712345678",
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("http_error");
  });

  it("classifies non-JSON responses as bad_payload", async () => {
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>error page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const r = await bdcourierAdapter.fetchHistory({
      merchantId: "merchA",
      normalizedPhone: "8801712345678",
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toBe("bad_payload");
  });

  it("redacts Bearer tokens from any error message echo", async () => {
    (env as unknown as MutableEnv).BDCOURIER_API_KEY = "leaky-secret-key";
    // Simulate a 401 that (hypothetically) echoes the Authorization header
    // back in the body — the adapter must strip this.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized — Bearer leaky-secret-key was rejected", {
        status: 401,
      }),
    );
    const r = await bdcourierAdapter.fetchHistory({
      merchantId: "merchA",
      normalizedPhone: "8801712345678",
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.detail ?? "").not.toContain("leaky-secret-key");
  });
});
