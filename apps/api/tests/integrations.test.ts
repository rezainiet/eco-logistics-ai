import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Integration, Order, WebhookInbox } from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { customApiAdapter } from "../src/lib/integrations/customApi.js";
import { shopifyAdapter } from "../src/lib/integrations/shopify.js";
import { wooAdapter } from "../src/lib/integrations/woocommerce.js";
import { processWebhookOnce } from "../src/server/ingest.js";
import { Types } from "mongoose";
import { decryptSecret } from "../src/lib/crypto.js";

describe("integrations router + connectors", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("connect(custom_api) mints a signing key + webhook secret", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const result = await caller.integrations.connect({
      provider: "custom_api",
      label: "primary",
    });
    expect(result.status).toBe("connected");
    expect(result.plaintextApiKey).toBeTruthy();
    expect(result.webhookSecret).toBeTruthy();
    const list = await caller.integrations.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.provider).toBe("custom_api");
    expect(list[0]!.permissions).toContain("ingest_orders");
  });

  it("connect(shopify) without access token surfaces an install URL", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const result = await caller.integrations.connect({
      provider: "shopify",
      shopDomain: "demo.myshopify.com",
      apiKey: "k",
      apiSecret: "s",
      scopes: ["read_orders"],
    });
    expect(result.status).toBe("pending");
    expect(result.installUrl).toMatch(/admin\/oauth\/authorize/);
  });

  it("disconnect flips status and stamps disconnectedAt", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({
      provider: "custom_api",
    });
    const res = await caller.integrations.disconnect({ id: created.id });
    expect(res.disconnected).toBe(true);
    const row = await Integration.findById(created.id).lean();
    expect(row?.status).toBe("disconnected");
    expect(row?.disconnectedAt).toBeTruthy();
  });

  it("custom_api signature verification round-trips", () => {
    const secret = "hunter2";
    const body = JSON.stringify({ externalId: "abc" });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(
      customApiAdapter.verifyWebhookSignature({
        rawBody: body,
        headers: { "x-ecom-signature": `sha256=${sig}` },
        secret,
      }),
    ).toBe(true);
    expect(
      customApiAdapter.verifyWebhookSignature({
        rawBody: body,
        headers: { "x-ecom-signature": "sha256=deadbeef" },
        secret,
      }),
    ).toBe(false);
  });

  it("shopify HMAC verification matches base64 expected", () => {
    const secret = "shop-secret";
    const body = JSON.stringify({ id: 12345 });
    const sig = createHmac("sha256", secret).update(body).digest("base64");
    expect(
      shopifyAdapter.verifyWebhookSignature({
        rawBody: body,
        headers: { "x-shopify-hmac-sha256": sig },
        secret,
      }),
    ).toBe(true);
  });

  it("woo HMAC verification rejects mismatched payload", () => {
    const secret = "woo-secret";
    const body = JSON.stringify({ id: 99 });
    const otherBody = JSON.stringify({ id: 100 });
    const sig = createHmac("sha256", secret).update(body).digest("base64");
    expect(
      wooAdapter.verifyWebhookSignature({
        rawBody: otherBody,
        headers: { "x-wc-webhook-signature": sig },
        secret,
      }),
    ).toBe(false);
  });

  it("processWebhookOnce is idempotent for duplicate externalIds", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(created.id);

    const normalized = customApiAdapter.normalizeWebhookPayload("order.created", {
      externalId: "ext-1",
      orderNumber: "EXT-1",
      customer: {
        name: "Sajib",
        phone: "+8801711111111",
        address: "House 12, Road 4",
        district: "Dhaka",
      },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
      total: 500,
    });
    expect(normalized).toBeTruthy();

    const args = {
      merchantId: m._id as Types.ObjectId,
      integrationId,
      provider: "custom_api",
      topic: "order.created",
      externalId: "ext-1",
      rawPayload: { externalId: "ext-1" },
      payloadBytes: 100,
      normalized,
      source: "custom_api" as const,
    };

    const first = await processWebhookOnce(args);
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBeFalsy();
    expect(first.orderId).toBeTruthy();

    const second = await processWebhookOnce(args);
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);

    const orderCount = await Order.countDocuments({ merchantId: m._id });
    expect(orderCount).toBe(1);
    const inboxCount = await WebhookInbox.countDocuments({ merchantId: m._id });
    expect(inboxCount).toBe(1);
  });

  it("rotateWebhookSecret returns a fresh secret stored encrypted", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const connected = await caller.integrations.connect({ provider: "custom_api" });
    const rotated = await caller.integrations.rotateWebhookSecret({ id: connected.id });
    expect(rotated.secret).toBeTruthy();
    const row = await Integration.findById(connected.id).lean();
    const stored = row?.webhookSecret;
    expect(stored).toBeTruthy();
    expect(decryptSecret(stored as string)).toBe(rotated.secret);
  });
});
