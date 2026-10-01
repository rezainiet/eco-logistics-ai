import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as activity } from "@/app/api/activity/route";
import { POST as recover } from "@/app/api/recover/route";
import { POST as checkout } from "@/app/api/checkout/route";
import { tokenFromHash } from "@/lib/commerce/recovery";

/**
 * Cart-recovery proxies: same-origin only, the page's own Host is the only
 * page/tenant identifier, and only the fields the API reads are forwarded.
 */

const HOST = "bazar.localhost";
const TOKEN = "A".repeat(43);

function request(path: string, body: unknown, origin = `http://${HOST}`) {
  return new Request(`http://${HOST}${path}`, {
    method: "POST",
    headers: { host: HOST, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let forwarded: { url: string; body: Record<string, unknown> } | null = null;
function stubApi(status = 200, reply: unknown = { ok: true }) {
  forwarded = null;
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    forwarded = { url, body: JSON.parse(init.body) as Record<string, unknown> };
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("recovery token in the link fragment", () => {
  it("reads a well-formed token only", () => {
    expect(tokenFromHash(`#cx_recover=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(`#foo=1&cx_recover=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash("#cx_recover=short")).toBeNull();
    expect(tokenFromHash(`#cx_recover=${TOKEN}<script>`)).toBeNull();
    expect(tokenFromHash("")).toBeNull();
  });
});

describe("activity proxy", () => {
  it("forwards the page's own host and only the activity fields", async () => {
    stubApi(202, { ok: true, recorded: true });
    const res = await activity(
      request("/api/activity", {
        host: "evil.localhost",
        merchantId: "6ab000000000000000000000",
        locale: "bn",
        sessionId: "s-123456789",
        type: "add_to_cart",
        clientEventId: "e-123456789",
        cart: [{ productId: "a".repeat(24), quantity: 1 }],
        item: { productId: "a".repeat(24), quantity: 1 },
        email: "x@y.test",
      }),
    );
    expect(res.status).toBe(202);
    expect(forwarded!.url).toMatch(/\/api\/landing\/activity$/);
    expect(forwarded!.body.host).toBe(HOST);
    expect(forwarded!.body).not.toHaveProperty("merchantId");
    expect(Object.keys(forwarded!.body).sort()).toEqual(["cart", "clientEventId", "email", "host", "item", "locale", "sessionId", "type"].sort());
  });

  it("refuses another origin", async () => {
    stubApi();
    const res = await activity(request("/api/activity", { type: "add_to_cart" }, "https://evil.example"));
    expect(res.status).toBe(403);
    expect(forwarded).toBeNull();
  });
});

describe("recover proxy", () => {
  it("forwards host + token only and passes the API's answer through", async () => {
    stubApi(200, { ok: true, lines: [] });
    const res = await recover(request("/api/recover", { token: TOKEN, host: "evil.localhost", locale: null }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(forwarded!.body).toEqual({ host: HOST, locale: null, token: TOKEN });
  });
});

describe("checkout proxy", () => {
  it("forwards the recovery token when present, and nothing extra when absent", async () => {
    stubApi(201, { ok: true });
    await checkout(request("/api/checkout", { idempotencyKey: "k".repeat(20), items: [], customer: {}, recoveryToken: TOKEN }));
    expect(forwarded!.body.recoveryToken).toBe(TOKEN);
    await checkout(request("/api/checkout", { idempotencyKey: "k".repeat(20), items: [], customer: {} }));
    expect(forwarded!.body).not.toHaveProperty("recoveryToken");
  });
});

describe("routing", () => {
  it("the middleware leaves the recovery proxies alone (not rewritten to a page)", async () => {
    const { config } = await import("@/middleware");
    const matcher = new RegExp(`^${config.matcher[0]!.replace("/((?!", "/(?!").replace(").*)", ").*")}$`);
    for (const path of ["/api/checkout", "/api/activity", "/api/recover"]) expect(matcher.test(path), path).toBe(false);
    expect(matcher.test("/bn")).toBe(true);
  });
});
