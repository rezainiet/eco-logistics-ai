import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cors from "cors";
import { Types } from "mongoose";
import { EmailEvent, EmailSuppression, Merchant, Payment, TrackingEvent } from "@ecom/db";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";
import {
  __resetCollectorCache,
  ensureTrackingKey,
  mountTrackingCollector,
} from "../src/server/tracking/collector.js";
import { __resetTrackingGuardForTests } from "../src/lib/tracking-guard.js";
import { stripeWebhookRouter } from "../src/server/webhooks/stripe.js";
import { resendWebhookRouter } from "../src/server/webhooks/resend.js";
import { readRawWebhookBody } from "../src/server/webhooks/raw-body.js";
import { env } from "../src/env.js";

/**
 * Phase 1B — the Stripe and Resend webhooks sign over the raw request
 * bytes but were mounted AFTER the global `express.json()`. Both providers
 * send `application/json`, so the global parser consumed every body and
 * each correctly-signed event failed verification (401 signature_mismatch).
 * These tests drive the real middleware order with locally signed fixtures
 * (no call ever leaves 127.0.0.1).
 */

const DASHBOARD_ORIGIN = "http://app.example.test";
const STOREFRONT_ORIGIN = "https://shop.example.test";
const RESEND_SECRET = `whsec_${Buffer.from("phase1b-local-resend-secret").toString("base64")}`;

/** Production middleware order (index.ts) for the routes under test. */
function buildProductionOrderApp() {
  const app = express();
  mountTrackingCollector(app);
  app.use(cors({ origin: DASHBOARD_ORIGIN, credentials: true }));
  app.use("/api/webhooks/stripe", stripeWebhookRouter);
  app.use("/api/webhooks/resend", resendWebhookRouter);
  app.use(express.json({ limit: "1mb" }));
  // Any other route keeps receiving parsed JSON exactly as before.
  app.post("/api/echo", (req, res) => res.json({ parsed: req.body }));
  return app;
}

/** The broken pre-1B order, kept as a control. */
function buildOldOrderApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/webhooks/stripe", stripeWebhookRouter);
  app.use("/api/webhooks/resend", resendWebhookRouter);
  return app;
}

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function request(
  app: express.Express,
  method: "POST" | "OPTIONS",
  path: string,
  body: string | undefined,
  headers: Record<string, string>,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body })
        .then(async (r) => {
          const json = await r.json().catch(() => ({}));
          server.close();
          resolve({ status: r.status, body: json, headers: r.headers });
        })
        .catch((e) => {
          server.close();
          reject(e);
        });
    });
  });
}

const post = (app: express.Express, path: string, body: string, headers: Record<string, string>) =>
  request(app, "POST", path, body, { "content-type": "application/json", ...headers });

/** Stripe-Signature for `raw`, exactly as Stripe builds it. */
function stripeSignature(raw: string, secret = env.STRIPE_WEBHOOK_SECRET!): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
}

/** Svix headers for `raw`, exactly as Resend (Svix) builds them. */
function svixHeaders(raw: string, id = `msg_${randomUUID()}`, secret = RESEND_SECRET): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}

async function pendingStripePayment(sessionId: string) {
  const m = await createMerchant();
  const payment = await Payment.create({
    merchantId: m._id,
    plan: "growth",
    amount: 25,
    currency: "USD",
    method: "card",
    provider: "stripe",
    status: "pending",
    providerSessionId: sessionId,
  });
  return { m, payment };
}

function checkoutCompleted(eventId: string, sessionId: string, merchantId: unknown, paymentId: unknown) {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_intent: `pi_${eventId}`,
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        metadata: { merchantId: String(merchantId), plan: "growth", paymentId: String(paymentId) },
      },
    },
  });
}

const resendEvent = (type: string, to = "buyer@example.test", extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: `re_${randomUUID()}`, to: [to], subject: "Your order", tags: [{ name: "type", value: "order" }], ...extra },
  });

// Every outbound fetch must stay on the loopback test servers — no real
// Stripe / Resend call can happen from these tests.
const realFetch = globalThis.fetch;
let fetched: string[] = [];
let savedResendSecret: string | undefined;

beforeEach(async () => {
  await resetDb();
  __resetCollectorCache();
  __resetTrackingGuardForTests();
  fetched = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input: any, init?: any) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return realFetch(input, init);
  });
  savedResendSecret = env.RESEND_WEBHOOK_SECRET;
  (env as Record<string, unknown>).RESEND_WEBHOOK_SECRET = RESEND_SECRET;
});
afterEach(() => {
  (env as Record<string, unknown>).RESEND_WEBHOOK_SECRET = savedResendSecret;
  vi.restoreAllMocks();
  expect(fetched.every((u) => u.startsWith("http://127.0.0.1:"))).toBe(true);
});
afterAll(disconnectDb);

describe("Stripe webhook receives the raw application/json body", () => {
  it("a valid signed checkout.session.completed is accepted and activates the payment (downstream unchanged)", async () => {
    const { m, payment } = await pendingStripePayment("cs_1b_ok");
    const raw = checkoutCompleted("evt_1b_ok", "cs_1b_ok", m._id, payment._id);
    const res = await post(buildProductionOrderApp(), "/api/webhooks/stripe", raw, { "stripe-signature": stripeSignature(raw) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, paymentId: String(payment._id) });
    const after = await Payment.findById(payment._id).lean();
    expect(after?.status).toBe("approved");
    expect(after?.providerEventId).toBe("evt_1b_ok");
    expect(after?.providerChargeId).toBe("pi_evt_1b_ok");
    const merchant = await Merchant.findById(m._id).lean();
    expect(merchant?.subscription?.tier).toBe("growth");
    expect(merchant?.subscription?.status).toBe("active");
  });

  it("also with a charset parameter", async () => {
    const raw = JSON.stringify({ id: "evt_1b_charset", type: "customer.created", data: { object: {} } });
    const res = await post(buildProductionOrderApp(), "/api/webhooks/stripe", raw, {
      "content-type": "application/json; charset=utf-8",
      "stripe-signature": stripeSignature(raw),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true });
  });

  it("a duplicate delivery stays idempotent (one approval)", async () => {
    const { m, payment } = await pendingStripePayment("cs_1b_dup");
    const raw = checkoutCompleted("evt_1b_dup", "cs_1b_dup", m._id, payment._id);
    const app = buildProductionOrderApp();
    const r1 = await post(app, "/api/webhooks/stripe", raw, { "stripe-signature": stripeSignature(raw) });
    const r2 = await post(app, "/api/webhooks/stripe", raw, { "stripe-signature": stripeSignature(raw) });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ ok: true, duplicate: true });
    expect(await Payment.countDocuments({ merchantId: m._id, status: "approved" })).toBe(1);
  });

  it("an invalid signature is rejected (401) and nothing changes", async () => {
    const { m, payment } = await pendingStripePayment("cs_1b_badsig");
    const raw = checkoutCompleted("evt_1b_badsig", "cs_1b_badsig", m._id, payment._id);
    const res = await post(buildProductionOrderApp(), "/api/webhooks/stripe", raw, {
      "stripe-signature": stripeSignature(raw, "whsec_not_the_real_secret"),
    });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: "signature_mismatch" });
    expect((await Payment.findById(payment._id).lean())?.status).toBe("pending");
  });

  it("a missing signature is rejected (401)", async () => {
    const raw = JSON.stringify({ id: "evt_1b_nosig", type: "customer.created", data: { object: {} } });
    const res = await post(buildProductionOrderApp(), "/api/webhooks/stripe", raw, {});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: "missing_signature" });
  });

  it("a tampered body is rejected (401) and nothing changes", async () => {
    const { m, payment } = await pendingStripePayment("cs_1b_tamper");
    const signed = checkoutCompleted("evt_1b_tamper", "cs_1b_tamper", m._id, payment._id);
    const tampered = signed.replace('"amount_total":2500', '"amount_total":1');
    expect(tampered).not.toBe(signed);
    const res = await post(buildProductionOrderApp(), "/api/webhooks/stripe", tampered, { "stripe-signature": stripeSignature(signed) });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: "signature_mismatch" });
    expect((await Payment.findById(payment._id).lean())?.status).toBe("pending");
  });

  it("re-serialised JSON (different whitespace) does not verify — the exact bytes are signed", async () => {
    const raw = JSON.stringify({ id: "evt_1b_ws", type: "customer.created", data: { object: {} } }, null, 2);
    const res = await post(buildProductionOrderApp(), "/api/webhooks/stripe", JSON.stringify(JSON.parse(raw)), {
      "stripe-signature": stripeSignature(raw),
    });
    expect(res.status).toBe(401);
  });

  it("malformed JSON is rejected safely: unsigned → 401, signed → 400 invalid_json", async () => {
    const raw = '{"id":"evt_1b_bad","type":';
    const app = buildProductionOrderApp();
    const unsigned = await post(app, "/api/webhooks/stripe", raw, { "stripe-signature": "t=1,v1=00" });
    expect(unsigned.status).toBe(401);
    const signed = await post(app, "/api/webhooks/stripe", raw, { "stripe-signature": stripeSignature(raw) });
    expect(signed.status).toBe(400);
    expect(signed.body).toMatchObject({ ok: false, error: "invalid_json" });
  });

  it("control: behind the global JSON parser (old order) the router reports a wiring fault, never accepts", async () => {
    const { m, payment } = await pendingStripePayment("cs_1b_old");
    const raw = checkoutCompleted("evt_1b_old", "cs_1b_old", m._id, payment._id);
    const res = await post(buildOldOrderApp(), "/api/webhooks/stripe", raw, { "stripe-signature": stripeSignature(raw) });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: "webhook_misconfigured" });
    expect((await Payment.findById(payment._id).lean())?.status).toBe("pending");
  });
});

describe("Resend webhook receives the raw application/json body", () => {
  it("a valid signed event is accepted and persisted once", async () => {
    const raw = resendEvent("email.delivered");
    const headers = svixHeaders(raw);
    const res = await post(buildProductionOrderApp(), "/api/webhooks/resend", raw, headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, type: "email.delivered", suppressed: false });
    const rows = await EmailEvent.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: headers["svix-id"], type: "email.delivered", to: "buyer@example.test", tag: "order" });
  });

  it("a hard bounce still drives the suppression list (downstream unchanged)", async () => {
    const raw = resendEvent("email.bounced", "Bounce@Example.test", { bounce: { type: "hard", message: "mailbox does not exist" } });
    const res = await post(buildProductionOrderApp(), "/api/webhooks/resend", raw, svixHeaders(raw));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, suppressed: true });
    const sup = await EmailSuppression.find({}).lean();
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ address: "bounce@example.test", reason: "bounce_hard" });
  });

  it("a duplicate delivery (same svix-id) stays idempotent", async () => {
    const raw = resendEvent("email.bounced", "dup@example.test", { bounce: { type: "hard" } });
    const id = `msg_${randomUUID()}`;
    const app = buildProductionOrderApp();
    const r1 = await post(app, "/api/webhooks/resend", raw, svixHeaders(raw, id));
    const r2 = await post(app, "/api/webhooks/resend", raw, svixHeaders(raw, id));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ ok: true, duplicate: true });
    expect(await EmailEvent.countDocuments({ eventId: id })).toBe(1);
    expect(await EmailSuppression.countDocuments({ address: "dup@example.test" })).toBe(1);
  });

  it("an invalid signature is rejected (401) and nothing is stored", async () => {
    const raw = resendEvent("email.delivered");
    const bad = svixHeaders(raw, undefined, `whsec_${Buffer.from("some-other-secret").toString("base64")}`);
    const res = await post(buildProductionOrderApp(), "/api/webhooks/resend", raw, bad);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: "signature_mismatch" });
    expect(await EmailEvent.countDocuments()).toBe(0);
  });

  it("missing svix headers are rejected (401)", async () => {
    const res = await post(buildProductionOrderApp(), "/api/webhooks/resend", resendEvent("email.delivered"), {});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: "missing_svix_id" });
  });

  it("a tampered body is rejected (401) and nothing is stored", async () => {
    const signed = resendEvent("email.complained", "victim@example.test");
    const tampered = signed.replace("victim@example.test", "other@example.test");
    const res = await post(buildProductionOrderApp(), "/api/webhooks/resend", tampered, svixHeaders(signed));
    expect(res.status).toBe(401);
    expect(await EmailEvent.countDocuments()).toBe(0);
    expect(await EmailSuppression.countDocuments()).toBe(0);
  });

  it("malformed JSON is rejected safely: unsigned → 401, signed → 400 invalid_json, nothing stored", async () => {
    const raw = '{"type":"email.delivered","data":';
    const app = buildProductionOrderApp();
    const unsigned = await post(app, "/api/webhooks/resend", raw, { "svix-id": "msg_x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,AAAA" });
    expect(unsigned.status).toBe(401);
    const signed = await post(app, "/api/webhooks/resend", raw, svixHeaders(raw));
    expect(signed.status).toBe(400);
    expect(signed.body).toMatchObject({ ok: false, error: "invalid_json" });
    expect(await EmailEvent.countDocuments()).toBe(0);
  });

  it("control: behind the global JSON parser (old order) the router reports a wiring fault, never accepts", async () => {
    const raw = resendEvent("email.delivered");
    const res = await post(buildOldOrderApp(), "/api/webhooks/resend", raw, svixHeaders(raw));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: "webhook_misconfigured" });
    expect(await EmailEvent.countDocuments()).toBe(0);
  });
});

describe("the rest of the app is unchanged by the reorder", () => {
  it("normal JSON API routes still receive parsed objects", async () => {
    const res = await post(buildProductionOrderApp(), "/api/echo", JSON.stringify({ a: 1, nested: { b: [2] } }), {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parsed: { a: 1, nested: { b: [2] } } });
  });

  it("/track still receives the SDK's raw application/json body", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const sid = randomUUID();
    const event = {
      type: "page_view",
      clientEventId: randomUUID(),
      sessionId: sid,
      anonId: randomUUID(),
      url: "https://shop.example.test/",
      path: "/",
      referrer: null,
      campaign: {},
      device: { type: "desktop" },
      properties: {},
      occurredAt: new Date().toISOString(),
      repeatVisitor: false,
    };
    const res = await post(buildProductionOrderApp(), "/track/collect", JSON.stringify({ trackingKey: key, events: [event] }), {
      Origin: STOREFRONT_ORIGIN,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 1 });
    expect(res.headers.get("access-control-allow-origin")).toBe(STOREFRONT_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await TrackingEvent.countDocuments({ merchantId: m._id, sessionId: sid })).toBe(1);
  });

  it("storefront CORS on /track is unchanged (any origin, no credentials)", async () => {
    const res = await request(buildProductionOrderApp(), "OPTIONS", "/track/collect", undefined, {
      Origin: STOREFRONT_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(STOREFRONT_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("dashboard CORS is unchanged — and also still applies to the webhook routes", async () => {
    const app = buildProductionOrderApp();
    for (const path of ["/api/echo", "/api/webhooks/stripe", "/api/webhooks/resend"]) {
      for (const origin of [DASHBOARD_ORIGIN, STOREFRONT_ORIGIN]) {
        const res = await request(app, "OPTIONS", path, undefined, { Origin: origin, "Access-Control-Request-Method": "POST" });
        expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD_ORIGIN);
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      }
    }
  });
});

describe("readRawWebhookBody", () => {
  const req = (body: unknown) => ({ body }) as express.Request;
  it("returns the raw bytes of a Buffer body", () => {
    expect(readRawWebhookBody(req(Buffer.from('{"a": 1}')))).toEqual({ ok: true, raw: '{"a": 1}' });
  });
  it("treats an absent / empty body as empty (signature check then fails normally)", () => {
    expect(readRawWebhookBody(req(undefined))).toEqual({ ok: true, raw: "" });
    expect(readRawWebhookBody(req({}))).toEqual({ ok: true, raw: "" });
  });
  it("flags a body that was already parsed upstream", () => {
    expect(readRawWebhookBody(req({ id: "evt_1" }))).toEqual({ ok: false, error: "webhook_misconfigured" });
  });
});

describe("index.ts mount order", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const at = (needle: string) => {
    const first = src.indexOf(needle);
    expect(first, needle).toBeGreaterThan(-1);
    expect(src.indexOf(needle, first + 1), `${needle} mounted once`).toBe(-1);
    return first;
  };
  const json = () => at("app.use(express.json(");

  it("every raw-body router mounts after the global CORS and before the global JSON parser", () => {
    const globalCors = at("app.use(cors({ origin: env.CORS_ORIGIN");
    for (const mount of [
      'app.use("/api/webhooks/stripe", webhookLimiter, stripeWebhookRouter);',
      'app.use("/api/webhooks/resend", webhookLimiter, resendWebhookRouter);',
      'app.use("/api/webhooks/courier", webhookLimiter, courierWebhookRouter);',
      'app.use("/api/webhooks/sms-inbound", webhookLimiter, smsInboundWebhookRouter);',
      'app.use("/api/webhooks/sms-dlr", webhookLimiter, smsDlrWebhookRouter);',
      'app.use("/api/integrations/webhook", webhookLimiter, integrationsWebhookRouter);',
      'app.use("/api/webhooks/shopify/gdpr", webhookLimiter, shopifyGdprWebhookRouter);',
    ]) {
      const i = at(mount);
      expect(i, mount).toBeGreaterThan(globalCors);
      expect(i, mount).toBeLessThan(json());
    }
  });

  it("/track still mounts before the global CORS and JSON parser", () => {
    const track = at("mountTrackingCollector(app);");
    expect(track).toBeLessThan(at("app.use(cors({ origin: env.CORS_ORIGIN"));
    expect(track).toBeLessThan(json());
  });

  it("Twilio (form-encoded, signs parsed params) stays after the JSON parser", () => {
    expect(at('app.use("/api/webhooks/twilio", webhookLimiter, twilioWebhookRouter);')).toBeGreaterThan(json());
  });
});
