import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createHmac } from "node:crypto";
import http from "node:http";
import { Integration, WebhookInbox } from "@ecom/db";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { integrationsWebhookRouter } from "../src/server/webhooks/integrations.js";

/**
 * End-to-end HTTP test that pins down the two production blockers we just
 * fixed:
 *
 *   1. The integrations webhook router must mount BEFORE `express.json` so
 *      the route's own `express.raw` actually receives the unparsed bytes.
 *      We mirror the production order here — json() goes after the router.
 *
 *   2. Shopify HMAC-signs webhooks with the app's `client_secret`
 *      (== `credentials.apiSecret`), not with any secret we mint locally.
 *      The signed payload below is built with apiSecret; the route must
 *      accept it.
 */
function buildApp() {
  const app = express();
  // Production-equivalent order: webhook router first, json parser second.
  app.use("/api/integrations/webhook", integrationsWebhookRouter);
  app.use(express.json({ limit: "1mb" }));
  return app;
}

/**
 * POST via the raw `http` module instead of global `fetch`. Other test
 * files in this repo (e.g. `sms.test.ts`) install vi.spy mocks on
 * globalThis.fetch and the cleanup ordering between files isn't tight
 * enough to guarantee restoration before this suite runs. The raw
 * http.request path is immune to those mocks.
 */
async function postWebhook(
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

describe("Shopify webhook — HTTP integration", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("accepts a webhook signed with the app's apiSecret (Shopify spec)", async () => {
    const apiSecret = "shop-app-secret-XYZ";
    const merchant = await createMerchant();
    const integration = await Integration.create({
      merchantId: merchant._id,
      provider: "shopify",
      accountKey: "demo.myshopify.com",
      status: "connected",
      credentials: {
        apiKey: encryptSecret("k_test"),
        apiSecret: encryptSecret(apiSecret),
        accessToken: encryptSecret("shpat_test"),
        siteUrl: "demo.myshopify.com",
      },
      // Intentionally mint a webhookSecret with a DIFFERENT value — proves
      // the Shopify path uses apiSecret and not this field.
      webhookSecret: encryptSecret("not-the-secret-shopify-uses"),
    });

    const payload = {
      id: 99001,
      name: "#1001",
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
    const rawBody = JSON.stringify(payload);
    const hmac = createHmac("sha256", apiSecret).update(rawBody).digest("base64");

    const app = buildApp();
    const res = await postWebhook(
      app,
      `/api/integrations/webhook/shopify/${String(integration._id)}`,
      rawBody,
      {
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Webhook-Id": "delivery-1",
        "X-Shopify-Triggered-At": new Date().toISOString(),
      },
    );

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true });

    const stamped = await WebhookInbox.findOne({
      integrationId: integration._id,
      externalId: "delivery-1",
    }).lean();
    expect(stamped).toBeTruthy();
    expect(stamped?.payloadBytes).toBe(Buffer.byteLength(rawBody));
    // payload was JSON-parsed AFTER signature verification — confirms the
    // route saw raw bytes, not a re-serialized object.
    expect(stamped?.payload).toMatchObject({ id: 99001, name: "#1001" });
  });

  it("rejects a webhook signed with the wrong key (e.g. webhookSecret)", async () => {
    const apiSecret = "real-shopify-secret";
    const wrongKey = "locally-minted-webhook-secret";
    const merchant = await createMerchant();
    const integration = await Integration.create({
      merchantId: merchant._id,
      provider: "shopify",
      accountKey: "demo.myshopify.com",
      status: "connected",
      credentials: {
        apiKey: encryptSecret("k"),
        apiSecret: encryptSecret(apiSecret),
        accessToken: encryptSecret("shpat_test"),
        siteUrl: "demo.myshopify.com",
      },
      webhookSecret: encryptSecret(wrongKey),
    });

    const rawBody = JSON.stringify({ id: 42 });
    // Sign with the wrong key on purpose — Shopify never uses webhookSecret.
    const badHmac = createHmac("sha256", wrongKey).update(rawBody).digest("base64");

    const app = buildApp();
    const res = await postWebhook(
      app,
      `/api/integrations/webhook/shopify/${String(integration._id)}`,
      rawBody,
      {
        "X-Shopify-Hmac-Sha256": badHmac,
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Webhook-Id": "should-not-stamp",
      },
    );
    expect(res.status).toBe(401);
    const stamped = await WebhookInbox.findOne({
      integrationId: integration._id,
    }).lean();
    expect(stamped).toBeNull();
  });

  it("delivers raw bytes to the handler (req.body is a Buffer)", async () => {
    // Direct middleware probe — confirms that with the production-equivalent
    // mount order, the route handler observes a Buffer rather than a parsed
    // object. This is the contract the HMAC verifier depends on.
    let observedType: string | null = null;
    let observedIsBuffer = false;
    let observedString: string | null = null;

    const app = express();
    const probe = express.Router();
    probe.post(
      "/probe",
      express.raw({ type: "*/*", limit: "1mb" }),
      (req, res) => {
        observedType = typeof req.body;
        observedIsBuffer = Buffer.isBuffer(req.body);
        observedString = Buffer.isBuffer(req.body)
          ? req.body.toString("utf8")
          : null;
        res.status(204).end();
      },
    );
    // Same ordering invariant as production after the fix: raw router first,
    // json second.
    app.use("/raw", probe);
    app.use(express.json({ limit: "1mb" }));

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = (server.address() as { port: number }).port;
        const body = '{"hello":"world"}';
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/raw/probe",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => {
              server.close();
              resolve();
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

    expect(observedType).toBe("object");
    expect(observedIsBuffer).toBe(true);
    expect(observedString).toBe('{"hello":"world"}');
  });
});
