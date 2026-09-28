import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FinanceEntry, InventoryMovement, Order, Product } from "@ecom/db";
import { __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";
import type { AddressInfo } from "node:net";
import express from "express";
import { mergeTouches, sanitizeAttribution, sanitizeTouch, touchFromVisit } from "@ecom/landing";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { classifyTouch } from "../src/lib/marketing/channel.js";
import { landingOrdersRouter } from "../src/server/landing-orders.js";
import { createMerchant } from "./helpers.js";
import { key, shop, touch } from "./landing-shop-fixture.js";

/**
 * First/last-touch marketing attribution: captured by the landing page,
 * validated and classified by the server, stored on the order once, never
 * deciding tenant, price or revenue.
 */

const NOW = new Date("2026-09-29T08:00:00Z");

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), FinanceEntry.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
});

describe("capture: touch from a visit (pure)", () => {
  const own = "shop.confirmx.ai";
  it("reads all five UTM values, the click-id TYPE only, and the landing path without query", () => {
    const t = touchFromVisit(
      "https://shop.confirmx.ai/bn?utm_source=facebook&utm_medium=cpc&utm_campaign=eid-sale&utm_term=panjabi&utm_content=video-a&fbclid=SECRET123",
      "https://l.facebook.com/somewhere?x=1",
      own,
      NOW,
    )!;
    expect(t).toMatchObject({
      source: "facebook",
      medium: "cpc",
      campaign: "eid-sale",
      term: "panjabi",
      content: "video-a",
      clickIdType: "fbclid",
      referrerHost: "l.facebook.com",
      landingPath: "/bn",
      at: NOW.toISOString(),
    });
    expect(JSON.stringify(t)).not.toContain("SECRET123");
    expect(JSON.stringify(t)).not.toContain("somewhere");
  });

  it("a direct visit (no UTM, no click id, own-site or no referrer) is not attributable", () => {
    expect(touchFromVisit("https://shop.confirmx.ai/", "", own, NOW)).toBeNull();
    expect(touchFromVisit("https://shop.confirmx.ai/en", "https://shop.confirmx.ai/", own, NOW)).toBeNull();
    expect(touchFromVisit("not a url", null, own, NOW)).toBeNull();
    expect(touchFromVisit("https://shop.confirmx.ai/?utm_source=", null, own, NOW)).toBeNull();
  });

  it("first touch is kept; last touch moves only on an attributable visit", () => {
    const first = touchFromVisit("https://s.x/?utm_source=facebook&utm_campaign=a", null, "s.x", NOW)!;
    let a = mergeTouches(null, first)!;
    expect(a.firstTouch).toEqual(first);
    expect(a.lastTouch).toEqual(first);
    const later = touchFromVisit("https://s.x/?utm_source=tiktok&utm_campaign=b", null, "s.x", new Date(NOW.getTime() + 60_000))!;
    a = mergeTouches(a, later)!;
    expect(a.firstTouch).toEqual(first);
    expect(a.lastTouch).toEqual(later);
    a = mergeTouches(a, null)!; // direct revisit
    expect(a).toEqual({ firstTouch: first, lastTouch: later });
    expect(mergeTouches(null, null)).toBeNull();
  });
});

describe("server-side sanitising (untrusted input)", () => {
  it("clamps oversized values, strips control characters/markup, drops unknown fields", () => {
    const t = sanitizeTouch(
      {
        at: NOW.toISOString(),
        source: `face\u0000book<script>${"x".repeat(500)}`,
        campaign: "c".repeat(1000),
        clickIdType: "evilclid",
        referrerHost: "not a host!",
        landingPath: "/p?phone=01711111111#frag",
        merchantId: "6ab000000000000000000000",
        email: "a@b.c",
      },
      NOW,
    )!;
    expect(t.source!.length).toBeLessThanOrEqual(80);
    expect(t.source).not.toMatch(/[\u0000<>]/);
    expect(t.campaign!.length).toBe(200);
    expect(t.clickIdType).toBeUndefined();
    expect(t.referrerHost).toBeUndefined();
    expect(t.landingPath).toBe("/p");
    expect(t).not.toHaveProperty("merchantId");
    expect(t).not.toHaveProperty("email");
  });

  it("rejects stale, future and malformed touches and non-objects", () => {
    expect(sanitizeTouch({ at: "2020-01-01T00:00:00Z", source: "x" }, NOW)).toBeNull();
    expect(sanitizeTouch({ at: "2027-09-29T00:00:00Z", source: "x" }, NOW)).toBeNull();
    expect(sanitizeTouch({ at: "yesterday", source: "x" }, NOW)).toBeNull();
    expect(sanitizeTouch({ at: NOW.toISOString() }, NOW)).toBeNull(); // nothing attributable
    expect(sanitizeAttribution("x", NOW)).toBeNull();
    expect(sanitizeAttribution([1, 2], NOW)).toBeNull();
    expect(sanitizeAttribution({ firstTouch: { at: NOW.toISOString(), source: "fb" } }, NOW)).toMatchObject({
      firstTouch: { source: "fb" },
      lastTouch: { source: "fb" },
    });
  });

  it("classifies channels on the server", () => {
    expect(classifyTouch({ clickIdType: "fbclid" })).toEqual({ channel: "meta", paid: true });
    expect(classifyTouch({ clickIdType: "gclid", source: "facebook" })).toEqual({ channel: "google", paid: true });
    expect(classifyTouch({ clickIdType: "ttclid" })).toEqual({ channel: "tiktok", paid: true });
    expect(classifyTouch({ source: "facebook", medium: "cpc" })).toEqual({ channel: "meta", paid: true });
    expect(classifyTouch({ source: "instagram", medium: "social" })).toEqual({ channel: "meta", paid: false });
    expect(classifyTouch({ source: "google", medium: "cpc" })).toEqual({ channel: "google", paid: true });
    expect(classifyTouch({ referrerHost: "www.google.com.bd" })).toEqual({ channel: "organic", paid: false });
    expect(classifyTouch({ source: "newsletter", medium: "organic" })).toEqual({ channel: "organic", paid: false });
    expect(classifyTouch({ referrerHost: "l.facebook.com" })).toEqual({ channel: "meta", paid: false });
    expect(classifyTouch({ referrerHost: "www.tiktok.com" })).toEqual({ channel: "tiktok", paid: false });
    expect(classifyTouch({ source: "partner-blog" })).toEqual({ channel: "other", paid: false });
    expect(classifyTouch({ referrerHost: "blog.example.com" })).toEqual({ channel: "referral", paid: false });
    expect(classifyTouch(null)).toEqual({ channel: "direct", paid: false });
  });
});

describe("attribution survives checkout and is stored on the order", () => {
  it("first and last touch are persisted with a server-derived channel", async () => {
    const { place } = await shop();
    const r = await place({
      firstTouch: touch({ source: "facebook", medium: "cpc", campaign: "eid", clickIdType: "fbclid" }, new Date(Date.now() - 86_400_000)),
      lastTouch: touch({ source: "tiktok", campaign: "retarget", clickIdType: "ttclid" }),
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const o = await Order.findOne({ orderNumber: r.orderNumber }).lean();
    expect(o!.attribution!.firstTouch).toMatchObject({ source: "facebook", medium: "cpc", campaign: "eid", clickIdType: "fbclid", channel: "meta", paid: true });
    expect(o!.attribution!.lastTouch).toMatchObject({ source: "tiktok", campaign: "retarget", channel: "tiktok", paid: true });
    expect(o!.attribution!.firstTouch!.at).toBeInstanceOf(Date);
  });

  it("attribution never decides tenant: smuggled merchant/page ids and a forged channel are ignored", async () => {
    const a = await shop();
    const b = await createMerchant();
    const r = await a.place({
      merchantId: String(b._id),
      firstTouch: touch({ source: "google", medium: "cpc", channel: "tiktok", merchantId: String(b._id), pageId: "x" }),
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const o = await Order.findOne({ orderNumber: r.orderNumber }).lean();
    expect(String(o!.merchantId)).toBe(String(a.merchant._id));
    expect(o!.attribution!.firstTouch!.channel).toBe("google");
    expect(JSON.stringify(o!.attribution)).not.toContain(String(b._id));
  });

  it("missing or invalid attribution never blocks the order; nothing is stored", async () => {
    const { place } = await shop();
    const bads = [undefined, null, "junk", { firstTouch: { source: "x" } }, { firstTouch: touch({}) }];
    for (const [i, bad] of bads.entries()) {
      const r = await place(bad, `0171234561${i}`);
      if (!r.ok) throw new Error(JSON.stringify(r));
      expect((await Order.findOne({ orderNumber: r.orderNumber }).lean())!.attribution).toBeUndefined();
    }
  });

  it("a replayed checkout returns the same order and does not rewrite its attribution", async () => {
    const { place } = await shop();
    const idempotencyKey = key();
    const first = await place({ firstTouch: touch({ source: "facebook" }) }, "01712345678", { idempotencyKey });
    const again = await place({ firstTouch: touch({ source: "tiktok" }) }, "01712345678", { idempotencyKey });
    if (!first.ok || !again.ok) throw new Error("placement failed");
    expect(again.orderNumber).toBe(first.orderNumber);
    const o = await Order.findOne({ orderNumber: first.orderNumber }).lean();
    expect(o!.attribution!.firstTouch!.source).toBe("facebook");
  });

  it("the public checkout HTTP route passes attribution through to the order", async () => {
    const { host } = await shop();
    const r0 = await resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });
    if (r0.kind !== "ok") throw new Error("no page");
    const app = express();
    app.use(express.json());
    app.use("/api/landing/orders", landingOrdersRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/landing/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          host,
          locale: null,
          idempotencyKey: key(),
          items: [{ productId: r0.commerce!.products[0]!.id, quantity: 1 }],
          customer: { name: "রহিম", phone: "01798765432", address: "বাড়ি ১২, রোড ৫, ধানমন্ডি", district: "ঢাকা" },
          deliveryOptionId: r0.commerce!.delivery[0]!.id,
          attribution: { lastTouch: touch({ source: "google", medium: "cpc", clickIdType: "gclid" }) },
        }),
      });
      const body = (await res.json()) as { ok: boolean; orderNumber: string };
      expect(body.ok).toBe(true);
      const o = await Order.findOne({ orderNumber: body.orderNumber }).lean();
      expect(o!.attribution!.lastTouch).toMatchObject({ source: "google", channel: "google", paid: true });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

