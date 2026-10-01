import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import cors from "cors";
import { Types } from "mongoose";
import {
  CallLog,
  EmailEvent,
  Notification,
  PendingJob,
  RecoveryTask,
  TrackingEvent,
  TrackingSession,
} from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";
import {
  __resetCollectorCache,
  ensureTrackingKey,
  mountTrackingCollector,
  rotateTrackingSecret,
  signTrackingPayload,
  trackingRouter,
} from "../src/server/tracking/collector.js";
import { __resetTrackingGuardForTests } from "../src/lib/tracking-guard.js";
import { sweepCartRecovery } from "../src/workers/cartRecovery.js";
import {
  cartRecoveryEligible,
  cartRecoveryTiers,
  subscriptionAccessDenial,
} from "../src/lib/entitlements.js";

/**
 * Phase 1A — the storefront SDK posts `application/json` to /track. The
 * collector was mounted AFTER the global `express.json()`, which consumed
 * the body, so every SDK batch was rejected as invalid_json. These tests
 * drive the real middleware order with the exact SDK request shape, and the
 * whole path on to Cart Recovery — which must only produce tasks for
 * merchants entitled to it.
 */

const HOUR = 3_600_000;

const DASHBOARD_ORIGIN = "http://app.example.test";
const STOREFRONT_ORIGIN = "https://shop.example.test";

/** Production middleware order (index.ts): collector, THEN the dashboard-only CORS and the global JSON parser. */
function buildProductionOrderApp() {
  const app = express();
  mountTrackingCollector(app);
  app.use(cors({ origin: DASHBOARD_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  // Any other route keeps receiving parsed JSON exactly as before.
  app.post("/other", (req, res) => res.json({ parsed: req.body }));
  return app;
}

/** The broken pre-1A order, kept as a control. */
function buildOldOrderApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/track", trackingRouter);
  return app;
}

async function send(
  app: express.Express,
  path: string,
  body: string,
  headers: Record<string, string> = { "Content-Type": "application/json" },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body })
        .then(async (r) => {
          const json = await r.json().catch(() => ({}));
          server.close();
          resolve({ status: r.status, body: json });
        })
        .catch((e) => {
          server.close();
          reject(e);
        });
    });
  });
}

/** One event exactly as apps/web/public/sdk.js `baseEvent()` builds it. */
function sdkEvent(type: string, sessionId: string, anonId: string, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    type,
    clientEventId: randomUUID(),
    sessionId,
    anonId,
    url: "https://shop.example.test/products/shirt",
    path: "/products/shirt",
    referrer: null,
    campaign: { source: "facebook", medium: "cpc", name: "eid" },
    device: { type: "mobile", os: "Android", browser: "Chrome", viewport: "390x844", language: "en-US" },
    properties: props,
    phone: undefined,
    email: undefined,
    occurredAt: new Date().toISOString(),
    repeatVisitor: false,
    ...extra,
  };
}
const sdkBody = (trackingKey: string, events: unknown[]) => JSON.stringify({ trackingKey, events });
// Each add carries its own timestamp, as the SDK's do. (Two adds with an
// identical payload in the same millisecond are dropped by the collector's
// pre-existing identical-payload spam filter, which fingerprints session,
// type, timestamp and properties.)
let addSeq = 0;
const addToCart = (sid: string, anon: string) =>
  sdkEvent(
    "add_to_cart",
    sid,
    anon,
    { productId: "p-1", name: "Shirt", price: 900, quantity: 1 },
    { occurredAt: new Date(Date.now() - 60_000 + (addSeq++ % 50_000)).toISOString() },
  );

const later = () => Date.now() + 31 * 60_000; // the sweep only takes sessions idle ≥ 30 min

beforeEach(async () => {
  await resetDb();
  __resetCollectorCache();
  __resetTrackingGuardForTests();
});
afterAll(disconnectDb);

describe("/track receives the SDK's application/json (parser order)", () => {
  it("a valid SDK-style application/json batch reaches the collector (not invalid_json)", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const sid = randomUUID();
    const anon = randomUUID();
    const res = await send(
      buildProductionOrderApp(),
      "/track/collect",
      sdkBody(key, [sdkEvent("page_view", sid, anon), sdkEvent("product_view", sid, anon, { productId: "p-1", name: "Shirt", price: 900 })]),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 2 });
    expect(await TrackingEvent.countDocuments({ merchantId: m._id, sessionId: sid })).toBe(2);
  });

  it("also with a charset parameter (as browsers/fetch may send it)", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const res = await send(buildProductionOrderApp(), "/track/collect", sdkBody(key, [sdkEvent("page_view", randomUUID(), randomUUID())]), {
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(res.status).toBe(200);
  });

  it("other routes still get the global JSON parser", async () => {
    const res = await send(buildProductionOrderApp(), "/other", JSON.stringify({ a: 1 }));
    expect(res.body).toEqual({ parsed: { a: 1 } });
  });

  it("a storefront origin passes the SDK's CORS preflight (application/json triggers one)", async () => {
    const res = await new Promise<{ status: number; allow: string | null; methods: string | null }>((resolve, reject) => {
      const app = buildProductionOrderApp();
      const server = app.listen(0, () => {
        const port = (server.address() as { port: number }).port;
        fetch(`http://127.0.0.1:${port}/track/collect`, {
          method: "OPTIONS",
          headers: {
            Origin: STOREFRONT_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        })
          .then((r) => {
            server.close();
            resolve({ status: r.status, allow: r.headers.get("access-control-allow-origin"), methods: r.headers.get("access-control-allow-methods") });
          })
          .catch((e) => {
            server.close();
            reject(e);
          });
      });
    });
    expect(res.status).toBe(204);
    expect(res.allow).toBe(STOREFRONT_ORIGIN);
    expect(res.methods).toContain("POST");
  });

  it("the POST response allows the storefront origin and sends no credentials header", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildProductionOrderApp();
    const headers = await new Promise<Headers>((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = (server.address() as { port: number }).port;
        fetch(`http://127.0.0.1:${port}/track/collect`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: STOREFRONT_ORIGIN },
          body: sdkBody(key, [sdkEvent("page_view", randomUUID(), randomUUID())]),
        })
          .then((r) => {
            server.close();
            resolve(r.headers);
          })
          .catch((e) => {
            server.close();
            reject(e);
          });
      });
    });
    expect(headers.get("access-control-allow-origin")).toBe(STOREFRONT_ORIGIN);
    expect(headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("dashboard routes keep the dashboard-only CORS policy", async () => {
    const app = buildProductionOrderApp();
    const allow = await new Promise<string | null>((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = (server.address() as { port: number }).port;
        fetch(`http://127.0.0.1:${port}/other`, {
          method: "OPTIONS",
          headers: { Origin: STOREFRONT_ORIGIN, "Access-Control-Request-Method": "POST" },
        })
          .then((r) => {
            server.close();
            resolve(r.headers.get("access-control-allow-origin"));
          })
          .catch((e) => {
            server.close();
            reject(e);
          });
      });
    });
    expect(allow).toBe(DASHBOARD_ORIGIN);
  });

  it("malformed JSON is rejected safely (400, nothing stored)", async () => {
    await createMerchant();
    const res = await send(buildProductionOrderApp(), "/track/collect", '{"trackingKey": "pub_x", "events": [');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: "invalid_json" });
    expect(await TrackingEvent.countDocuments()).toBe(0);
  });

  it("control: the old order (global parser first) is detected as a wiring fault, not blamed on the client", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const res = await send(buildOldOrderApp(), "/track/collect", sdkBody(key, [sdkEvent("page_view", randomUUID(), randomUUID())]));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "collector_misconfigured" });
  });

  it("index.ts mounts the collector BEFORE the global CORS policy and the global JSON parser", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const mount = src.indexOf("mountTrackingCollector(app);");
    const json = src.indexOf("app.use(express.json(");
    const globalCors = src.indexOf("app.use(cors({ origin: env.CORS_ORIGIN");
    expect(mount).toBeGreaterThan(0);
    expect(json).toBeGreaterThan(0);
    expect(globalCors).toBeGreaterThan(0);
    expect(mount).toBeLessThan(json);
    expect(mount).toBeLessThan(globalCors);
    expect(src).not.toMatch(/app\.use\(\s*"\/track"/); // one mount point only
  });
});

describe("HMAC signature still enforced through the JSON path", () => {
  it("valid signature over the exact raw bytes is accepted", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const secret = await rotateTrackingSecret(m._id as Types.ObjectId);
    const body = sdkBody(key, [sdkEvent("page_view", randomUUID(), randomUUID())]);
    const res = await send(buildProductionOrderApp(), "/track/collect", body, {
      "Content-Type": "application/json",
      "x-track-signature": signTrackingPayload(secret, body),
    });
    expect(res.status).toBe(200);
  });

  it("invalid signature is rejected (401) and nothing is stored", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const secret = await rotateTrackingSecret(m._id as Types.ObjectId);
    const body = sdkBody(key, [sdkEvent("page_view", randomUUID(), randomUUID())]);
    const tampered = body.replace("page_view", "product_view");
    const res = await send(buildProductionOrderApp(), "/track/collect", tampered, {
      "Content-Type": "application/json",
      "x-track-signature": signTrackingPayload(secret, body),
    });
    expect(res.status).toBe(401);
    expect(await TrackingEvent.countDocuments({ merchantId: m._id })).toBe(0);
  });
});

describe("Cart Recovery eligibility (canonical entitlement)", () => {
  it("recovery tiers are exactly the plans with behaviorAnalytics: Growth, Pro (scale), Enterprise", () => {
    expect(cartRecoveryTiers()).toEqual(["growth", "scale", "enterprise"]);
  });

  it("the shared subscription rule matches billableProcedure's states", () => {
    const now = Date.now();
    const past = new Date(now - HOUR);
    const future = new Date(now + HOUR);
    expect(subscriptionAccessDenial({ status: "active", currentPeriodEnd: future }, now)).toBeNull();
    expect(subscriptionAccessDenial({ status: "active", currentPeriodEnd: past }, now)).toBe("subscription_past_due");
    expect(subscriptionAccessDenial({ status: "past_due", gracePeriodEndsAt: future }, now)).toBeNull();
    expect(subscriptionAccessDenial({ status: "past_due", gracePeriodEndsAt: past }, now)).toBe("subscription_grace_expired");
    expect(subscriptionAccessDenial({ status: "trial", trialEndsAt: future }, now)).toBeNull();
    expect(subscriptionAccessDenial({ status: "trial", trialEndsAt: past }, now)).toBe("trial_expired");
    for (const s of ["suspended", "paused", "cancelled"]) expect(subscriptionAccessDenial({ status: s }, now)).toBe(`subscription_${s}`);
    expect(cartRecoveryEligible({ status: "active", tier: "starter" }, now)).toBe(false);
    expect(cartRecoveryEligible({ status: "active", tier: "growth" }, now)).toBe(true);
  });
});

/** SDK flow for one shopper: identify, then two add_to_cart in SEPARATE requests. */
async function shopperAbandons(app: express.Express, key: string, phone: string) {
  const sid = randomUUID();
  const anon = randomUUID();
  const r1 = await send(app, "/track/collect", sdkBody(key, [sdkEvent("identify", sid, anon, { phone }, { phone }), addToCart(sid, anon)]));
  const r2 = await send(app, "/track/collect", sdkBody(key, [addToCart(sid, anon)]));
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  return { sid, anon };
}

describe("end to end: SDK JSON → /track → session → abandonment → sweep → RecoveryTask", () => {
  for (const tier of ["growth", "scale", "enterprise"] as const) {
    it(`${tier}: events stored, session abandoned, recovery task created`, async () => {
      const m = await createMerchant({ tier });
      const key = await ensureTrackingKey(m._id as Types.ObjectId);
      const app = buildProductionOrderApp();
      const { sid } = await shopperAbandons(app, key, "+8801711000201");
      const s = await TrackingSession.findOne({ merchantId: m._id, sessionId: sid }).lean();
      expect(s).toMatchObject({ addToCartCount: 2, abandonedCart: true });
      const res = await sweepCartRecovery({ now: later() });
      expect(res.created).toBe(1);
      expect(await RecoveryTask.countDocuments({ merchantId: m._id, sessionId: sid })).toBe(1);
    });
  }

  it("starter: events ARE collected and the session abandons (existing analytics policy), but NO recovery task", async () => {
    const m = await createMerchant({ tier: "starter" });
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const { sid } = await shopperAbandons(buildProductionOrderApp(), key, "+8801711000202");
    expect(await TrackingEvent.countDocuments({ merchantId: m._id, sessionId: sid })).toBe(3);
    expect((await TrackingSession.findOne({ merchantId: m._id, sessionId: sid }).lean())?.abandonedCart).toBe(true);
    await sweepCartRecovery({ now: later() });
    expect(await RecoveryTask.countDocuments({ merchantId: m._id })).toBe(0);
    expect(await Notification.countDocuments({ merchantId: m._id, kind: "recovery.cart_pending" })).toBe(0);
  });

  it("an entitled tier with a non-billable subscription gets no task (trial expired, suspended, grace over)", async () => {
    const cases = [
      await createMerchant({ tier: "growth", status: "trial", trialEndsAt: new Date(Date.now() - HOUR) }),
      await createMerchant({ tier: "scale", status: "suspended" }),
      await createMerchant({ tier: "enterprise", status: "cancelled" }),
    ];
    const app = buildProductionOrderApp();
    for (const [i, m] of cases.entries()) {
      await shopperAbandons(app, await ensureTrackingKey(m._id as Types.ObjectId), `+880171100030${i}`);
    }
    const res = await sweepCartRecovery({ now: later() });
    expect(res.created).toBe(0);
    expect(res.ineligible).toBe(3);
    expect(await RecoveryTask.countDocuments()).toBe(0);
  });

  it("past_due within grace keeps access (same as the API)", async () => {
    const m = await createMerchant({ tier: "growth", status: "past_due" });
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    await shopperAbandons(buildProductionOrderApp(), key, "+8801711000210");
    expect((await sweepCartRecovery({ now: later() })).created).toBe(1);
  });

  it("multiple sessions in one SDK request each reach their own session", async () => {
    const m = await createMerchant({ tier: "growth" });
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const a = randomUUID();
    const b = randomUUID();
    const res = await send(buildProductionOrderApp(), "/track/collect", sdkBody(key, [addToCart(a, "anon-a-0001"), addToCart(b, "anon-b-0001"), addToCart(a, "anon-a-0001")]));
    expect(res.status).toBe(200);
    expect((await TrackingSession.findOne({ merchantId: m._id, sessionId: a }).lean())?.addToCartCount).toBe(2);
    expect((await TrackingSession.findOne({ merchantId: m._id, sessionId: b }).lean())?.addToCartCount).toBe(1);
  });

  it("a retried SDK batch moves no counter and never yields a second task", async () => {
    const m = await createMerchant({ tier: "growth" });
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildProductionOrderApp();
    const sid = randomUUID();
    const anon = randomUUID();
    const batch = sdkBody(key, [sdkEvent("identify", sid, anon, {}, { phone: "+8801711000220" }), addToCart(sid, anon), addToCart(sid, anon)]);
    expect((await send(app, "/track/collect", batch)).status).toBe(200);
    __resetTrackingGuardForTests(); // the retry reaches the DB (another instance / after the 60s window)
    const retry = await send(app, "/track/collect", batch);
    expect(retry.body).toMatchObject({ ok: true, duplicates: 3 });
    expect((await TrackingSession.findOne({ merchantId: m._id, sessionId: sid }).lean())?.addToCartCount).toBe(2);
    await sweepCartRecovery({ now: later() });
    await sweepCartRecovery({ now: later() });
    expect(await RecoveryTask.countDocuments({ merchantId: m._id })).toBe(1);
  });

  it("a checkout clears the abandoned state, so no task is created", async () => {
    const m = await createMerchant({ tier: "growth" });
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildProductionOrderApp();
    const { sid, anon } = await shopperAbandons(app, key, "+8801711000230");
    await send(app, "/track/collect", sdkBody(key, [sdkEvent("checkout_submit", sid, anon)]));
    expect(await TrackingSession.findOne({ merchantId: m._id, sessionId: sid }).lean()).toMatchObject({ converted: true, abandonedCart: false });
    await sweepCartRecovery({ now: later() });
    expect(await RecoveryTask.countDocuments({ merchantId: m._id })).toBe(0);
  });

  it("tenant isolation: merchant A can neither see nor update merchant B's recovery tasks", async () => {
    const a = await createMerchant({ tier: "growth" });
    const b = await createMerchant({ tier: "growth" });
    const app = buildProductionOrderApp();
    await shopperAbandons(app, await ensureTrackingKey(a._id as Types.ObjectId), "+8801711000240");
    await shopperAbandons(app, await ensureTrackingKey(b._id as Types.ObjectId), "+8801711000241");
    await sweepCartRecovery({ now: later() });
    const listA = await callerFor(authUserFor(a)).recovery.list({ limit: 50 });
    expect(listA).toHaveLength(1);
    const bTask = await RecoveryTask.findOne({ merchantId: b._id }).lean();
    expect(listA.map((t) => t.id)).not.toContain(String(bTask!._id));
    await expect(callerFor(authUserFor(a)).recovery.update({ id: String(bTask!._id), status: "dismissed" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("no automatic outbound: the only side effects are tracking rows, tasks and one in-app notification", async () => {
    const m = await createMerchant({ tier: "growth" });
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    await shopperAbandons(buildProductionOrderApp(), key, "+8801711000250");
    await sweepCartRecovery({ now: later() });
    expect(await RecoveryTask.countDocuments({ merchantId: m._id })).toBe(1);
    const kinds = (await Notification.find({ merchantId: m._id }).lean()).map((n) => n.kind);
    expect(kinds).toEqual(["recovery.cart_pending"]);
    expect(await PendingJob.countDocuments()).toBe(0); // nothing queued (SMS / email / booking jobs dead-letter here)
    expect(await EmailEvent.countDocuments()).toBe(0);
    expect(await CallLog.countDocuments()).toBe(0);
    const task = await RecoveryTask.findOne({ merchantId: m._id }).lean();
    expect(task).toMatchObject({ status: "pending" });
    expect(task?.contactedAt).toBeUndefined();
  });
});
