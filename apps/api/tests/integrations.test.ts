import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Integration, Notification, Order, WebhookInbox } from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { customApiAdapter } from "../src/lib/integrations/customApi.js";
import {
  exchangeShopifyCode,
  shopifyAdapter,
  verifyShopifyOAuthHmac,
} from "../src/lib/integrations/shopify.js";
import { wooAdapter } from "../src/lib/integrations/woocommerce.js";
import {
  nextRetryDelayMs,
  processWebhookOnce,
  replayWebhookInbox,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
} from "../src/server/ingest.js";
import { sweepWebhookRetryQueue } from "../src/workers/webhookRetry.js";
import { Types } from "mongoose";
import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";

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

  it("connect(shopify) rejects a non-myshopify domain with an inline-friendly Zod error", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.integrations.connect({
        provider: "shopify",
        shopDomain: "mystore.com",
        apiKey: "k",
        apiSecret: "s",
        scopes: ["read_orders"],
      }),
    ).rejects.toThrow(/myshopify\.com/);
  });

  it("connect(shopify) with platform-level env credentials needs only the shop domain", async () => {
    const prevKey = process.env.SHOPIFY_APP_API_KEY;
    const prevSecret = process.env.SHOPIFY_APP_API_SECRET;
    process.env.SHOPIFY_APP_API_KEY = "platform-k";
    process.env.SHOPIFY_APP_API_SECRET = "platform-s";
    // Drop the env singleton's cached graph so the router picks up the
    // new process.env values on the fresh import.
    vi.resetModules();
    try {
      const { appRouter } = await import("../src/server/routers/index.js");
      const m = await createMerchant({
        email: `env-fallback-${Date.now()}@t.com`,
      });
      const fresh = appRouter.createCaller({
        user: { id: String(m._id), email: m.email, role: m.role as "merchant" },
        request: {
          ip: null,
          userAgent: null,
          cookieAuth: false,
          csrfHeader: null,
          csrfCookie: null,
        },
      });
      const result = await fresh.integrations.connect({
        provider: "shopify",
        shopDomain: "envshop.myshopify.com",
        scopes: ["read_orders"],
      });
      expect(result.status).toBe("pending");
      expect(result.installUrl).toContain("client_id=platform-k");
    } finally {
      process.env.SHOPIFY_APP_API_KEY = prevKey;
      process.env.SHOPIFY_APP_API_SECRET = prevSecret;
      vi.resetModules();
    }
  });

  it("connect(shopify) without env or merchant credentials surfaces a friendly error", async () => {
    const prevKey = process.env.SHOPIFY_APP_API_KEY;
    const prevSecret = process.env.SHOPIFY_APP_API_SECRET;
    delete process.env.SHOPIFY_APP_API_KEY;
    delete process.env.SHOPIFY_APP_API_SECRET;
    vi.resetModules();
    const { appRouter } = await import("../src/server/routers/index.js");
    try {
      const m = await createMerchant({
        email: `no-creds-${Date.now()}@t.com`,
      });
      const fresh = appRouter.createCaller({
        user: { id: String(m._id), email: m.email, role: m.role as "merchant" },
        request: {
          ip: null,
          userAgent: null,
          cookieAuth: false,
          csrfHeader: null,
          csrfCookie: null,
        },
      });
      await expect(
        fresh.integrations.connect({
          provider: "shopify",
          shopDomain: "naked.myshopify.com",
          scopes: ["read_orders"],
        }),
      ).rejects.toThrow(/shopify_credentials_required/);
    } finally {
      process.env.SHOPIFY_APP_API_KEY = prevKey;
      process.env.SHOPIFY_APP_API_SECRET = prevSecret;
      vi.resetModules();
    }
  });

  it("connect(shopify) refuses to clobber a connected store without confirmOverwrite", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    // Seed a fully-connected Shopify integration with a valid encrypted
    // accessToken so the reconnect-safety branch fires.
    const seeded = await Integration.create({
      merchantId: m._id,
      provider: "shopify",
      accountKey: "safe.myshopify.com",
      status: "connected",
      credentials: {
        apiKey: encryptSecret("k"),
        apiSecret: encryptSecret("s"),
        accessToken: encryptSecret("shpat_existing_token"),
        siteUrl: "safe.myshopify.com",
      },
      webhookSecret: encryptSecret("ws"),
    });
    // First call without the flag — should short-circuit to alreadyConnected.
    const guarded = await caller.integrations.connect({
      provider: "shopify",
      shopDomain: "safe.myshopify.com",
      apiKey: "new-k",
      apiSecret: "new-s",
      scopes: ["read_orders"],
    });
    expect(guarded.id).toBe(String(seeded._id));
    expect((guarded as { alreadyConnected?: boolean }).alreadyConnected).toBe(true);
    // The accessToken on disk MUST still be the old one.
    const after = await Integration.findById(seeded._id).lean();
    expect(after?.credentials?.accessToken).toBe(seeded.credentials!.accessToken);

    // Second call WITH the flag — proceeds and rebuilds the install URL.
    const confirmed = await caller.integrations.connect({
      provider: "shopify",
      shopDomain: "safe.myshopify.com",
      apiKey: "new-k",
      apiSecret: "new-s",
      scopes: ["read_orders"],
      confirmOverwrite: true,
    });
    expect(confirmed.installUrl).toMatch(/admin\/oauth\/authorize/);
    // accessToken preserved (we didn't pass a new one), credentials rotated.
    const rotated = await Integration.findById(seeded._id).lean();
    expect(rotated?.credentials?.accessToken).toBe(seeded.credentials!.accessToken);
    expect(decryptSecret(rotated!.credentials!.apiKey as string)).toBe("new-k");
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
    const rotated = await caller.integrations.rotateWebhookSecret({
      id: connected.id,
      password: "password123",
    });
    expect(rotated.secret).toBeTruthy();
    const row = await Integration.findById(connected.id).lean();
    const stored = row?.webhookSecret;
    expect(stored).toBeTruthy();
    expect(decryptSecret(stored as string)).toBe(rotated.secret);
  });

  // ─── Sprint A — Day 7.5 ────────────────────────────────────────────────

  it("custom_api signature verification rejects when no secret is configured", () => {
    const body = JSON.stringify({ externalId: "x" });
    expect(
      customApiAdapter.verifyWebhookSignature({
        rawBody: body,
        headers: {},
        secret: undefined,
      }),
    ).toBe(false);
  });

  it("verifyShopifyOAuthHmac validates Shopify-style query signatures", () => {
    const secret = "shop-app-secret";
    const params = { code: "abc", shop: "demo.myshopify.com", state: "nonce", timestamp: "1700000000" };
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k as keyof typeof params]}`)
      .join("&");
    const hmac = createHmac("sha256", secret).update(sorted).digest("hex");
    expect(verifyShopifyOAuthHmac({ ...params, hmac }, secret)).toBe(true);
    expect(verifyShopifyOAuthHmac({ ...params, hmac: "deadbeef" }, secret)).toBe(false);
  });

  it("exchangeShopifyCode posts code+credentials and returns token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "shpat_abcdef", scope: "read_orders,write_orders" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await exchangeShopifyCode({
      shopDomain: "demo.myshopify.com",
      apiKey: "k",
      apiSecret: "s",
      code: "auth-code",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.accessToken).toBe("shpat_abcdef");
    expect(result.scope).toBe("read_orders,write_orders");
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://demo.myshopify.com/admin/oauth/access_token");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body as string);
    expect(body).toMatchObject({ client_id: "k", client_secret: "s", code: "auth-code" });
  });

  it("exchangeShopifyCode throws on non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("bad code", { status: 400 }));
    await expect(
      exchangeShopifyCode({
        shopDomain: "demo.myshopify.com",
        apiKey: "k",
        apiSecret: "s",
        code: "bad",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/shopify oauth 400/);
  });

  it("processWebhookOnce stamps nextRetryAt on failure for the worker to pick up", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(created.id);

    // Normalized = null → ingestNormalizedOrder is skipped (treated as ignored).
    // Force a failure by supplying a normalized payload missing the phone.
    const result = await processWebhookOnce({
      merchantId: m._id as Types.ObjectId,
      integrationId,
      provider: "custom_api",
      topic: "order.created",
      externalId: "broken-1",
      rawPayload: { externalId: "broken-1" },
      payloadBytes: 50,
      normalized: {
        externalId: "broken-1",
        customer: { name: "x", phone: "", address: "y", district: "Dhaka" },
        items: [{ name: "Item", quantity: 1, price: 100 }],
        cod: 100,
        total: 100,
      },
      source: "custom_api",
    });
    expect(result.ok).toBe(false);
    const row = await WebhookInbox.findOne({ externalId: "broken-1" }).lean();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);
    expect(row?.nextRetryAt).toBeTruthy();
    expect(row?.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("retry worker re-runs failed webhooks once the payload is fixable", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(created.id);

    // Stamp a failed inbox row with a usable payload + nextRetryAt in the past.
    const inbox = await WebhookInbox.create({
      merchantId: m._id,
      integrationId,
      provider: "custom_api",
      topic: "order.created",
      externalId: "retry-1",
      payload: {
        externalId: "retry-1",
        customer: {
          name: "Retry Buyer",
          phone: "+8801712345678",
          address: "Road 1",
          district: "Dhaka",
        },
        items: [{ name: "Shirt", quantity: 1, price: 250 }],
        cod: 250,
        total: 250,
      },
      payloadBytes: 200,
      status: "failed",
      attempts: 1,
      nextRetryAt: new Date(Date.now() - 1000),
      lastError: "transient",
    });

    const sweep = await sweepWebhookRetryQueue();
    expect(sweep.picked).toBe(1);
    expect(sweep.succeeded).toBe(1);

    const after = await WebhookInbox.findById(inbox._id).lean();
    expect(after?.status).toBe("succeeded");
    expect(after?.resolvedOrderId).toBeTruthy();
    expect(after?.nextRetryAt).toBeFalsy();
    const orderCount = await Order.countDocuments({ merchantId: m._id });
    expect(orderCount).toBe(1);
  });

  it("retry worker dead-letters and alerts when attempts cap is reached", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(created.id);

    // Stage a row that normalizes cleanly, then nuke the merchant so every
    // retry attempt fails with "merchant not found" — drives the DLQ path
    // deterministically without depending on quota timing.
    const merchantId = m._id as Types.ObjectId;
    const inbox = await WebhookInbox.create({
      merchantId,
      integrationId,
      provider: "custom_api",
      topic: "order.created",
      externalId: "dlq-1",
      payload: {
        externalId: "dlq-1",
        customer: {
          name: "Buyer",
          phone: "+8801711000000",
          address: "Road 1",
          district: "Dhaka",
        },
        items: [{ name: "X", quantity: 1, price: 100 }],
        cod: 100,
        total: 100,
      },
      payloadBytes: 100,
      status: "failed",
      attempts: WEBHOOK_RETRY_MAX_ATTEMPTS - 1,
      nextRetryAt: new Date(Date.now() - 1000),
      lastError: "transient",
    });

    const { Merchant } = await import("@ecom/db");
    await Merchant.deleteOne({ _id: merchantId });

    const sweep = await sweepWebhookRetryQueue();
    expect(sweep.picked).toBe(1);
    expect(sweep.deadLettered).toBe(1);

    const after = await WebhookInbox.findById(inbox._id).lean();
    expect(after?.status).toBe("failed");
    expect(after?.attempts).toBe(WEBHOOK_RETRY_MAX_ATTEMPTS);
    expect(after?.deadLetteredAt).toBeTruthy();
    expect(after?.nextRetryAt).toBeFalsy();

    const note = await Notification.findOne({
      merchantId,
      kind: "integration.webhook_failed",
    }).lean();
    expect(note).toBeTruthy();
    expect(note?.severity).toBe("critical");
  });

  it("nextRetryDelayMs follows the documented backoff curve", () => {
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(5 * 60_000);
    expect(nextRetryDelayMs(3)).toBe(15 * 60_000);
    expect(nextRetryDelayMs(4)).toBe(30 * 60_000);
    expect(nextRetryDelayMs(99)).toBe(60 * 60_000);
  });

  it("replayWebhook (manual) succeeds for a fixable failed row and audits", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(created.id);

    const inbox = await WebhookInbox.create({
      merchantId: m._id,
      integrationId,
      provider: "custom_api",
      topic: "order.created",
      externalId: "replay-1",
      payload: {
        externalId: "replay-1",
        customer: {
          name: "Manual",
          phone: "+8801799887766",
          address: "Block A",
          district: "Dhaka",
        },
        items: [{ name: "T", quantity: 1, price: 300 }],
        cod: 300,
        total: 300,
      },
      payloadBytes: 200,
      status: "failed",
      attempts: 2,
      nextRetryAt: new Date(Date.now() + 3_600_000),
      lastError: "stale",
    });

    const result = await caller.integrations.replayWebhook({ id: String(inbox._id) });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(result.orderId).toBeTruthy();

    const after = await WebhookInbox.findById(inbox._id).lean();
    expect(after?.status).toBe("succeeded");
  });

  it("inspectWebhook returns the payload for the merchant's own row only", async () => {
    const m1 = await createMerchant();
    const m2 = await createMerchant({ email: `tenant2-${Date.now()}@t.com` });
    const c1 = callerFor(authUserFor(m1));
    const c2 = callerFor(authUserFor(m2));
    const created = await c1.integrations.connect({ provider: "custom_api" });
    const inbox = await WebhookInbox.create({
      merchantId: m1._id,
      integrationId: new Types.ObjectId(created.id),
      provider: "custom_api",
      topic: "order.created",
      externalId: "inspect-1",
      payload: { externalId: "inspect-1", secret: "should-be-visible-only-to-owner" },
      payloadBytes: 100,
      status: "failed",
      attempts: 1,
      lastError: "boom",
    });
    const detail = await c1.integrations.inspectWebhook({ id: String(inbox._id) });
    expect(detail.payload).toMatchObject({ secret: "should-be-visible-only-to-owner" });
    await expect(
      c2.integrations.inspectWebhook({ id: String(inbox._id) }),
    ).rejects.toThrow(/not found/i);
  });

  it("connect(shopify) stores installNonce on the credentials so the callback can validate", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({
      provider: "shopify",
      shopDomain: "demo.myshopify.com",
      apiKey: "key-123",
      apiSecret: "secret-456",
      scopes: ["read_orders"],
    });
    expect(created.status).toBe("pending");
    expect(created.installUrl).toBeTruthy();
    const row = await Integration.findById(created.id).lean();
    expect(row?.credentials?.installNonce).toBeTruthy();
    // The encrypted apiSecret must round-trip — the OAuth callback decrypts it
    // to validate the inbound HMAC.
    expect(decryptSecret(row!.credentials!.apiSecret as string)).toBe("secret-456");
  });

  it("replayWebhookInbox is a no-op for already-succeeded rows", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const inbox = await WebhookInbox.create({
      merchantId: m._id,
      integrationId: new Types.ObjectId(created.id),
      provider: "custom_api",
      topic: "order.created",
      externalId: "noop-1",
      payload: { externalId: "noop-1" },
      payloadBytes: 50,
      status: "succeeded",
      attempts: 1,
      processedAt: new Date(),
    });
    const result = await replayWebhookInbox({ inboxId: inbox._id });
    expect(result.status).toBe("skipped");
    expect(result.ok).toBe(true);
  });

  // ─── Sprint B — Plan gate enforcement ────────────────────────────────

  it("starter tier cannot connect Shopify (provider locked)", async () => {
    const m = await createMerchant({ tier: "starter" });
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.integrations.connect({
        provider: "shopify",
        shopDomain: "demo.myshopify.com",
        apiKey: "k",
        apiSecret: "s",
        scopes: ["read_orders"],
      }),
    ).rejects.toThrow(/entitlement_blocked:integration_provider_locked:shopify/);
  });

  it("starter tier can still connect CSV (universally allowed)", async () => {
    const m = await createMerchant({ tier: "starter" });
    const caller = callerFor(authUserFor(m));
    const r = await caller.integrations.connect({ provider: "csv" });
    expect(r.status).toBe("connected");
  });

  it("growth tier cannot connect custom_api (Scale+ feature)", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.integrations.connect({ provider: "custom_api" }),
    ).rejects.toThrow(/entitlement_blocked:integration_provider_locked:custom_api/);
  });

  it("growth tier caps active integrations at 1", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const first = await caller.integrations.connect({
      provider: "shopify",
      shopDomain: "shop1.myshopify.com",
      apiKey: "k1",
      apiSecret: "s1",
      scopes: ["read_orders"],
    });
    expect(first.status).toBe("pending");
    await expect(
      caller.integrations.connect({
        provider: "woocommerce",
        siteUrl: "https://store.example.com",
        consumerKey: "ck",
        consumerSecret: "cs",
      }),
    ).rejects.toThrow(/entitlement_blocked:integration_count_capped/);
  });

  it("scale tier connects multiple commerce integrations under the cap", async () => {
    const m = await createMerchant({ tier: "scale" });
    const caller = callerFor(authUserFor(m));
    await caller.integrations.connect({
      provider: "shopify",
      shopDomain: "shop1.myshopify.com",
      apiKey: "k1",
      apiSecret: "s1",
      scopes: ["read_orders"],
    });
    await caller.integrations.connect({ provider: "custom_api", label: "wholesale" });
    const list = await caller.integrations.list();
    expect(list).toHaveLength(2);
  });

  it("getEntitlements returns the plan-aware view + remaining slots", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    await caller.integrations.connect({
      provider: "shopify",
      shopDomain: "shop1.myshopify.com",
      apiKey: "k",
      apiSecret: "s",
      scopes: ["read_orders"],
    });
    const ent = await caller.integrations.getEntitlements();
    expect(ent.tier).toBe("growth");
    expect(ent.maxIntegrations).toBe(1);
    expect(ent.activeIntegrationCount).toBe(1);
    expect(ent.remainingIntegrationSlots).toBe(0);
    expect(ent.integrationProviders).toEqual(
      expect.arrayContaining(["csv", "shopify", "woocommerce"]),
    );
    expect(ent.integrationProviders).not.toContain("custom_api");
    expect(ent.recommendedUpgradeTier).toBe("scale");
  });

  // Silence retained references for lint.
  void encryptSecret;
  void afterEach;
});
