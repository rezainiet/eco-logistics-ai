import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  ImportJob,
  Integration,
  Order,
  RecoveryTask,
  TrackingEvent,
  TrackingSession,
  WebhookInbox,
} from "@ecom/db";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import { processCommerceImport } from "../src/workers/commerceImport.js";
import { sweepCartRecovery } from "../src/workers/cartRecovery.js";
import {
  registerShopifyWebhooks,
} from "../src/lib/integrations/shopify.js";
import { registerWooWebhooks } from "../src/lib/integrations/woocommerce.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { resolveIdentityForOrder } from "../src/server/ingest.js";
import { normalizePhone } from "../src/lib/phone.js";

describe("Sprint C — async import job", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("importOrders enqueues an ImportJob row and returns its id", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const result = await caller.integrations.importOrders({ id: created.id, limit: 5 });
    expect(result.jobId).toBeTruthy();
    const row = await ImportJob.findById(result.jobId).lean();
    expect(row?.status).toBe("queued");
    expect(row?.requestedLimit).toBe(5);
  });

  it("getImportJob returns the merchant's own job, 404s on cross-tenant access", async () => {
    const m1 = await createMerchant();
    const m2 = await createMerchant({ email: `t2-${Date.now()}@t.com` });
    const c1 = callerFor(authUserFor(m1));
    const c2 = callerFor(authUserFor(m2));
    const created = await c1.integrations.connect({ provider: "custom_api" });
    const job = await c1.integrations.importOrders({ id: created.id });
    const view = await c1.integrations.getImportJob({ id: job.jobId });
    expect(view.id).toBe(job.jobId);
    await expect(c2.integrations.getImportJob({ id: job.jobId })).rejects.toThrow(/not found/);
  });

  it("processCommerceImport runs the worker and updates ImportJob progress", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    // Use shopify so we have an adapter that fetchSampleOrders is callable on,
    // then mock the upstream fetch.
    const created = await caller.integrations.connect({
      provider: "shopify",
      shopDomain: "demo.myshopify.com",
      apiKey: "k",
      apiSecret: "s",
      accessToken: "shpat_test",
      scopes: ["read_orders"],
    });
    // Create the ImportJob row directly — `caller.integrations.importOrders`
    // would also fire `enqueueCommerceImport`, which without Redis falls back
    // to a fire-and-forget run that races with the synchronous one we await
    // below.
    const job = {
      jobId: String(
        (await ImportJob.create({
          merchantId: m._id,
          integrationId: new Types.ObjectId(created.id),
          provider: "shopify",
          status: "queued",
          requestedLimit: 3,
        }))._id,
      ),
    };

    const sample = (id: number) => ({
      id,
      total_price: "100",
      currency: "BDT",
      created_at: "2026-04-25T00:00:00Z",
      shipping_address: {
        name: `Buyer ${id}`,
        phone: `+88017${String(10000000 + id).padStart(9, "0")}`,
        address1: "Road 1",
        city: "Dhaka",
      },
      line_items: [{ id, name: "Shirt", quantity: 1, price: "100" }],
      payment_gateway_names: ["cash on delivery"],
    });
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ orders: [sample(1), sample(2), sample(3)] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    try {
      const result = await processCommerceImport({ importJobId: job.jobId });
      const view = await caller.integrations.getImportJob({ id: job.jobId });
      if (result.imported !== 3) {
        // eslint-disable-next-line no-console
        console.log("[debug] import failure", { result, lastError: view.lastError });
      }
      expect(result.imported).toBe(3);
      expect(result.failed).toBe(0);
      expect(view.status).toBe("succeeded");
      expect(view.processedRows).toBe(3);
      expect(view.progressPct).toBe(100);
      expect(view.importedRows).toBe(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("double-submit returns the active job id instead of starting a second", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const a = await caller.integrations.importOrders({ id: created.id });
    const b = await caller.integrations.importOrders({ id: created.id });
    expect(b.jobId).toBe(a.jobId);
    const count = await ImportJob.countDocuments({ integrationId: new Types.ObjectId(created.id) });
    expect(count).toBe(1);
  });
});

describe("Sprint C — abandoned-cart recovery worker", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  async function seedAbandonedSession(args: {
    merchantId: Types.ObjectId;
    sessionId: string;
    phone?: string;
    email?: string;
    cartProducts?: Array<{ name: string; price: number }>;
    abandonedAgoMs?: number;
  }) {
    const lastSeen = new Date(Date.now() - (args.abandonedAgoMs ?? 60 * 60_000));
    const productEvents = (args.cartProducts ?? []).map((p, i) => ({
      merchantId: args.merchantId,
      sessionId: args.sessionId,
      type: "add_to_cart" as const,
      properties: { name: p.name, price: p.price, quantity: 1 },
      occurredAt: new Date(lastSeen.getTime() - 60_000 - i * 1000),
      receivedAt: new Date(),
    }));
    if (productEvents.length) {
      await TrackingEvent.insertMany(productEvents);
    }
    return TrackingSession.create({
      merchantId: args.merchantId,
      sessionId: args.sessionId,
      anonId: `anon-${args.sessionId}`,
      firstSeenAt: new Date(lastSeen.getTime() - 5 * 60_000),
      lastSeenAt: lastSeen,
      pageViews: 3,
      productViews: 2,
      addToCartCount: 2,
      checkoutStartCount: 1,
      checkoutSubmitCount: 0,
      abandonedCart: true,
      converted: false,
      ...(args.phone ? { phone: args.phone } : {}),
      ...(args.email ? { email: args.email } : {}),
    });
  }

  it("creates a RecoveryTask for an identified abandoned session", async () => {
    const m = await createMerchant();
    await seedAbandonedSession({
      merchantId: m._id as Types.ObjectId,
      sessionId: "abandon-1",
      phone: "+8801799000001",
      cartProducts: [
        { name: "Sneakers", price: 1200 },
        { name: "Socks", price: 200 },
      ],
    });
    const result = await sweepCartRecovery();
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.created).toBe(1);
    const task = await RecoveryTask.findOne({ sessionId: "abandon-1" }).lean();
    expect(task?.phone).toBe("+8801799000001");
    expect(task?.cartValue).toBe(1400);
    expect(task?.topProducts).toEqual(expect.arrayContaining(["Sneakers", "Socks"]));
    expect(task?.status).toBe("pending");
  });

  it("skips anonymous (un-identified) sessions even when they abandoned", async () => {
    const m = await createMerchant();
    await seedAbandonedSession({
      merchantId: m._id as Types.ObjectId,
      sessionId: "abandon-anon",
      // no phone, no email
    });
    const result = await sweepCartRecovery();
    expect(result.created).toBe(0);
    const count = await RecoveryTask.countDocuments({ merchantId: m._id });
    expect(count).toBe(0);
  });

  it("skips sessions younger than the cool-down (ongoing flow)", async () => {
    const m = await createMerchant();
    await seedAbandonedSession({
      merchantId: m._id as Types.ObjectId,
      sessionId: "abandon-recent",
      phone: "+8801799000002",
      abandonedAgoMs: 5 * 60_000, // only 5 min ago
    });
    const result = await sweepCartRecovery();
    expect(result.created).toBe(0);
  });

  it("re-running the sweep is idempotent (no duplicate tasks)", async () => {
    const m = await createMerchant();
    await seedAbandonedSession({
      merchantId: m._id as Types.ObjectId,
      sessionId: "abandon-2",
      phone: "+8801799000003",
    });
    await sweepCartRecovery();
    await sweepCartRecovery();
    const count = await RecoveryTask.countDocuments({ sessionId: "abandon-2" });
    expect(count).toBe(1);
  });

  it("recovery.update marks contacted with a channel + audits", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const task = await RecoveryTask.create({
      merchantId: m._id,
      sessionId: "task-1",
      phone: "+8801711100000",
      cartValue: 500,
      topProducts: ["Item"],
      abandonedAt: new Date(),
      status: "pending",
    });
    const result = await caller.recovery.update({
      id: String(task._id),
      status: "contacted",
      channel: "call",
    });
    expect(result.status).toBe("contacted");
    const after = await RecoveryTask.findById(task._id).lean();
    expect(after?.lastChannel).toBe("call");
    expect(after?.contactedAt).toBeTruthy();
  });

  it("recovery.update auto-links a recovered order by phone", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const phone = "+8801712220000";
    const task = await RecoveryTask.create({
      merchantId: m._id,
      sessionId: "task-2",
      phone,
      cartValue: 700,
      topProducts: [],
      abandonedAt: new Date(Date.now() - 60 * 60_000),
      status: "contacted",
    });
    const order = await Order.create({
      merchantId: m._id,
      orderNumber: "RECOV-1",
      customer: { name: "Buyer", phone, address: "Road 1", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 700 }],
      order: { cod: 700, total: 700, status: "pending" },
      fraud: { detected: false, riskScore: 0, level: "low", reasons: [], signals: [], reviewStatus: "not_required", scoredAt: new Date() },
      source: { channel: "dashboard" },
    });
    const result = await caller.recovery.update({
      id: String(task._id),
      status: "recovered",
    });
    expect(result.recoveredOrderId).toBe(String(order._id));
    const after = await RecoveryTask.findById(task._id).lean();
    expect(after?.status).toBe("recovered");
    expect(after?.recoveredAt).toBeTruthy();
  });
});

describe("Sprint C — phone-aware identity resolution", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("stitches a session that recorded a non-canonical phone form", async () => {
    const m = await createMerchant();
    // Session recorded the leading-zero national form (typed before the
    // collector started normalizing).
    await TrackingSession.create({
      merchantId: m._id,
      sessionId: "legacy-1",
      anonId: "anon-legacy",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      phone: "01711333333",
      converted: false,
    });
    // Order arrives with the canonical form.
    const order = await Order.create({
      merchantId: m._id,
      orderNumber: "STITCH-1",
      customer: {
        name: "Buyer",
        phone: "+8801711333333",
        address: "Road 1",
        district: "Dhaka",
      },
      items: [{ name: "X", quantity: 1, price: 100 }],
      order: { cod: 100, total: 100, status: "pending" },
      fraud: { detected: false, riskScore: 0, level: "low", reasons: [], signals: [], reviewStatus: "not_required", scoredAt: new Date() },
      source: { channel: "dashboard" },
    });
    const result = await resolveIdentityForOrder({
      merchantId: m._id as Types.ObjectId,
      orderId: order._id,
      phone: "+8801711333333",
    });
    expect(result.stitchedSessions).toBe(1);
  });
});

describe("Sprint C — Shopify auto-webhook registration", () => {
  it("posts orders/create + orders/updated and skips already-registered", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // First call lists; pretend orders/create is already registered.
      if (init?.method === undefined || init.method === "GET") {
        return new Response(
          JSON.stringify({ webhooks: [{ topic: "orders/create" }] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 201 });
    });
    const result = await registerShopifyWebhooks({
      shopDomain: "demo.myshopify.com",
      accessToken: "tok",
      callbackUrl: "https://api.example.com/api/integrations/webhook/shopify/x",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.registered).toContain("orders/create");
    expect(result.registered).toContain("orders/updated");
    expect(result.errors).toEqual([]);
    // 1 list + 1 POST (orders/updated) — orders/create skipped.
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("/admin/api/2024-04/webhooks.json");
  });

  it("captures errors per topic instead of throwing", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return new Response(JSON.stringify({ webhooks: [] }), { status: 200 });
      return new Response("forbidden", { status: 403 });
    });
    const result = await registerShopifyWebhooks({
      shopDomain: "demo.myshopify.com",
      accessToken: "tok",
      callbackUrl: "https://example.com/x",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.registered).toEqual([]);
    expect(result.errors.length).toBe(2);
    expect(result.errors[0]!).toContain("403");
  });
});

describe("Sprint C — Woo auto-webhook registration", () => {
  it("posts order.created + order.updated to /wp-json/wc/v3/webhooks", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("{}", { status: 201 });
    });
    const result = await registerWooWebhooks({
      siteUrl: "https://store.example.com",
      consumerKey: "ck",
      consumerSecret: "cs",
      callbackUrl: "https://api.example.com/api/integrations/webhook/woocommerce/x",
      webhookSecret: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.registered).toEqual(
      expect.arrayContaining(["order.created", "order.updated"]),
    );
    expect(result.errors).toEqual([]);
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts.length).toBe(2);
    expect(posts[0]!.url).toContain("/wp-json/wc/v3/webhooks");
    const body = JSON.parse((posts[0]!.init!.body ?? "{}") as string);
    expect(body.delivery_url).toContain("/api/integrations/webhook/woocommerce/x");
    expect(body.secret).toBe("secret");
  });
});

describe("Sprint C — phone normalization at ingest seam", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("an order created with 01711… is stored as +8801711…", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const result = await caller.orders.createOrder({
      customer: { name: "Buyer", phone: "01711555555", address: "Rd 1", district: "Dhaka" },
      items: [{ name: "T", quantity: 1, price: 200 }],
      cod: 200,
    });
    const stored = await Order.findById(result.id).lean();
    expect(stored?.customer.phone).toBe("+8801711555555");
  });

  it("normalization is a no-op for already-canonical numbers", async () => {
    expect(normalizePhone("+8801711555555")).toBe("+8801711555555");
  });

  // Silence noisy unused-import warnings (encryptSecret, WebhookInbox used in
  // sibling test files).
  void encryptSecret;
  void WebhookInbox;
});
