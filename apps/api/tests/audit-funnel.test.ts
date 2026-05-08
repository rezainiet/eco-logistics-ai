import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createHmac } from "node:crypto";
import http from "node:http";
import { createServer } from "node:http";
import { AuditLog, Integration, WebhookInbox } from "@ecom/db";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { authRouter } from "../src/server/auth.js";
import { integrationsWebhookRouter } from "../src/server/webhooks/integrations.js";

/**
 * Audit funnel tests — locks in the activation signals introduced in
 * the production-readiness milestone:
 *
 *   - `auth.signup`            written exactly once per successful signup
 *   - `integration.first_event` written exactly once per integration,
 *                                even if more webhooks arrive afterwards
 *
 * These rows are how ops measures the activation funnel without poking
 * at order tables or merchant docs. They MUST stay exactly-once or the
 * funnel numbers double-count and trust in the metric collapses.
 *
 * Both tests boot a minimal express app rather than going through the
 * full router stack — same pattern as `sprintA.test.ts` /
 * `shopifyWebhookHttp.test.ts`. Keeps regressions cheap to detect
 * without dragging in the full production startup.
 */

// ─────────────────────────────────────────────────────────────────────
// Helpers — small mirrors of the rigs in sprintA + shopifyWebhookHttp.

function makeAuthApp(): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/auth", authRouter);
  return app;
}

function makeWebhookApp(): express.Express {
  const app = express();
  // Production-equivalent order: webhook router first, json parser
  // second — the integrations router uses express.raw internally, which
  // a global json parser would pre-empt.
  app.use("/api/integrations/webhook", integrationsWebhookRouter);
  app.use(express.json({ limit: "1mb" }));
  return app;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

function fetchJson(url: string, init: RequestInit = {}): Promise<JsonResponse> {
  return fetch(url, init).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => ({})),
  }));
}

async function withServer<T>(
  app: express.Express,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to bind test server");
  }
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postShopifyWebhook(
  app: express.Express,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = {};
            try {
              parsed = raw ? JSON.parse(raw) : {};
            } catch {
              parsed = raw;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
            server.close();
          });
        },
      );
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
      req.write(body);
      req.end();
    });
  });
}

function buildShopifyOrderPayload(externalId: number) {
  return {
    id: externalId,
    name: `#${externalId}`,
    email: "buyer@example.com",
    total_price: "500",
    currency: "BDT",
    created_at: new Date().toISOString(),
    customer: { first_name: "A", last_name: "B", phone: "+8801711111111" },
    shipping_address: {
      name: "A B",
      phone: "+8801711111111",
      address1: "Road 1",
      city: "Dhaka",
    },
    line_items: [{ id: 1, title: "Shirt", quantity: 1, price: "500" }],
  };
}

// ─────────────────────────────────────────────────────────────────────

describe("audit funnel — auth.signup", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("writes exactly one auth.signup row per successful signup", async () => {
    const app = makeAuthApp();
    const email = `funnel-${Date.now()}@test.com`;

    const res = await withServer(app, (base) =>
      fetchJson(`${base}/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: "passwordOK1!",
          businessName: "Funnel Co",
          country: "BD",
          language: "en",
        }),
      }),
    );

    expect(res.status).toBe(200);

    // The audit write is fire-and-forget (`void writeAudit(...)`) so the
    // signup response can return before AuditLog.create() resolves. A
    // short tick lets the chained write land before we observe.
    await new Promise((r) => setTimeout(r, 100));

    const rows = await AuditLog.find({ action: "auth.signup" }).lean();
    expect(rows.length).toBe(1);

    const row = rows[0]!;
    expect(row.actorEmail).toBe(email);
    expect(row.actorType).toBe("merchant");
    expect(row.subjectType).toBe("merchant");
    expect(row.merchantId).toBeTruthy();
    expect(String(row.merchantId)).toBe(String(row.subjectId));
    // Meta fields used for funnel slicing (country, language, plan tier
    // at start, has-phone). Pin the contract so a later refactor can't
    // silently drop a slice without flipping this assertion.
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    expect(meta.country).toBe("BD");
    expect(meta.language).toBe("en");
    expect(meta.tier).toBe("starter");
    expect(meta.hasPhone).toBe(false);
    expect(meta.trialEndsAt).toBeTruthy();
  });

  it("does NOT write a second auth.signup row when the email is already taken", async () => {
    const app = makeAuthApp();
    const email = `funnel-dup-${Date.now()}@test.com`;
    const payload = JSON.stringify({
      email,
      password: "passwordOK1!",
      businessName: "Funnel Co",
    });

    const first = await withServer(app, (base) =>
      fetchJson(`${base}/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );
    expect(first.status).toBe(200);

    const second = await withServer(app, (base) =>
      fetchJson(`${base}/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );
    expect(second.status).toBe(409);

    // Allow the first signup's audit write to land before we count.
    await new Promise((r) => setTimeout(r, 100));

    // The 409 path returns BEFORE the audit write — exactly one row total.
    const rows = await AuditLog.find({ action: "auth.signup" }).lean();
    expect(rows.length).toBe(1);
  });
});

describe("audit funnel — integration.first_event", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  async function seedShopifyIntegration(apiSecret: string) {
    const merchant = await createMerchant();
    const integration = await Integration.create({
      merchantId: merchant._id,
      provider: "shopify",
      accountKey: "demo.myshopify.com",
      status: "connected",
      connectedAt: new Date(Date.now() - 30_000),
      credentials: {
        apiKey: encryptSecret("k"),
        apiSecret: encryptSecret(apiSecret),
        accessToken: encryptSecret("shpat_test"),
        siteUrl: "demo.myshopify.com",
      },
      webhookSecret: encryptSecret("local-secret-not-used-by-shopify"),
    });
    return { merchant, integration };
  }

  function signedShopifyDelivery(
    apiSecret: string,
    deliveryId: string,
    externalId: number,
  ) {
    const payload = buildShopifyOrderPayload(externalId);
    const rawBody = JSON.stringify(payload);
    const hmac = createHmac("sha256", apiSecret).update(rawBody).digest("base64");
    return {
      rawBody,
      headers: {
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Webhook-Id": deliveryId,
        "X-Shopify-Triggered-At": new Date().toISOString(),
      },
    };
  }

  it("writes exactly one integration.first_event row on the first verified webhook", async () => {
    const apiSecret = "shop-app-secret-funnel-1";
    const { integration } = await seedShopifyIntegration(apiSecret);

    const app = makeWebhookApp();
    const delivery = signedShopifyDelivery(apiSecret, "delivery-first", 99001);
    const res = await postShopifyWebhook(
      app,
      `/api/integrations/webhook/shopify/${String(integration._id)}`,
      delivery.rawBody,
      delivery.headers,
    );
    expect(res.status).toBe(202);

    // The first-event audit happens via fire-and-forget — wait for the
    // microtask + a short tick so the inner async block lands.
    await new Promise((r) => setTimeout(r, 80));

    const inboxRows = await WebhookInbox.find({
      integrationId: integration._id,
    }).lean();
    expect(inboxRows.length).toBe(1);

    const auditRows = await AuditLog.find({
      action: "integration.first_event",
      subjectId: integration._id,
    }).lean();
    expect(auditRows.length).toBe(1);
    const row = auditRows[0]!;
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    expect(meta.provider).toBe("shopify");
    expect(meta.accountKey).toBe("demo.myshopify.com");
    expect(typeof meta.elapsedMsSinceConnect).toBe("number");
    // Sanity-check: integration was seeded 30s ago, the elapsed should
    // be in the same ballpark (≥ 0, < 10 minutes — no clock skew weirdness).
    const elapsed = meta.elapsedMsSinceConnect as number;
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(10 * 60_000);
  });

  it("does NOT emit a duplicate first_event when subsequent webhooks arrive", async () => {
    const apiSecret = "shop-app-secret-funnel-2";
    const { integration } = await seedShopifyIntegration(apiSecret);

    const app = makeWebhookApp();

    // Three legit deliveries with distinct ids — only the FIRST should
    // produce an `integration.first_event` audit row. The other two
    // are normal traffic.
    for (let i = 0; i < 3; i++) {
      const delivery = signedShopifyDelivery(
        apiSecret,
        `delivery-${i}`,
        100_000 + i,
      );
      const res = await postShopifyWebhook(
        app,
        `/api/integrations/webhook/shopify/${String(integration._id)}`,
        delivery.rawBody,
        delivery.headers,
      );
      expect(res.status).toBe(202);
    }

    // Allow the fire-and-forget audit chain to drain.
    await new Promise((r) => setTimeout(r, 200));

    const inboxRows = await WebhookInbox.find({
      integrationId: integration._id,
    }).lean();
    expect(inboxRows.length).toBe(3);

    const firstEventRows = await AuditLog.find({
      action: "integration.first_event",
      subjectId: integration._id,
    }).lean();
    expect(firstEventRows.length).toBe(1);

    // Subsequent events must still bump webhookStatus.lastEventAt so the
    // dashboard "last seen" pill stays fresh — the claim path covers
    // first event, the unclaimed path covers everything after.
    const refreshed = await Integration.findById(integration._id).lean();
    expect(refreshed?.webhookStatus?.lastEventAt).toBeTruthy();
  });

  it("does NOT emit first_event for a delivery rejected at HMAC verification", async () => {
    const apiSecret = "shop-app-secret-funnel-3";
    const { integration } = await seedShopifyIntegration(apiSecret);

    const app = makeWebhookApp();
    const payload = JSON.stringify({ id: 1 });
    // Sign with the WRONG key — this delivery must be rejected with
    // 401 before the inbox is touched, so no first_event row should
    // ever land.
    const badHmac = createHmac("sha256", "definitely-wrong")
      .update(payload)
      .digest("base64");
    const res = await postShopifyWebhook(
      app,
      `/api/integrations/webhook/shopify/${String(integration._id)}`,
      payload,
      {
        "X-Shopify-Hmac-Sha256": badHmac,
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Webhook-Id": "should-not-stamp",
      },
    );
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 80));

    const auditRows = await AuditLog.find({
      action: "integration.first_event",
    }).lean();
    expect(auditRows.length).toBe(0);
  });
});
