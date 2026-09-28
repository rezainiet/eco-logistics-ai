import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/checkout/route";

/**
 * The same-origin checkout proxy forwards marketing attribution to the API
 * only after sanitising it (@ecom/landing sanitizeAttribution); the page's
 * Host header stays the only page/tenant identifier.
 */

const HOST = "bazar.localhost";

function request(body: unknown) {
  return new Request(`http://${HOST}/api/checkout`, {
    method: "POST",
    headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let forwarded: Record<string, unknown> | null = null;
function stubApi() {
  forwarded = null;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    forwarded = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true, orderNumber: "ORD-1" }), { status: 201, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("checkout proxy → attribution", () => {
  it("forwards a sanitized first/last touch and the page's own host only", async () => {
    stubApi();
    const at = new Date().toISOString();
    const res = await POST(
      request({
        host: "evil.localhost",
        merchantId: "6ab000000000000000000000",
        idempotencyKey: "k".repeat(20),
        items: [],
        customer: {},
        attribution: {
          firstTouch: { at, source: "facebook<script>", medium: "cpc", clickIdType: "fbclid", fbclid: "RAW-CLICK-ID", referrerHost: "l.facebook.com" },
          lastTouch: { at, source: "tiktok", campaign: "x".repeat(900), landingPath: "/bn?phone=017" },
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(forwarded!.host).toBe(HOST);
    expect(forwarded).not.toHaveProperty("merchantId");
    const a = forwarded!.attribution as { firstTouch: Record<string, unknown>; lastTouch: Record<string, unknown> };
    expect(a.firstTouch).toMatchObject({ source: "facebook script", medium: "cpc", clickIdType: "fbclid", referrerHost: "l.facebook.com" });
    expect(JSON.stringify(a)).not.toContain("RAW-CLICK-ID");
    expect((a.lastTouch.campaign as string).length).toBe(200);
    expect(a.lastTouch.landingPath).toBe("/bn");
  });

  it("forwards null for missing or junk attribution — the order is still sent", async () => {
    stubApi();
    for (const attribution of [undefined, "junk", { firstTouch: { source: "no-date" } }]) {
      const res = await POST(request({ idempotencyKey: "k".repeat(20), items: [], customer: {}, attribution }));
      expect(res.status).toBe(201);
      expect(forwarded!.attribution).toBeNull();
    }
  });
});
