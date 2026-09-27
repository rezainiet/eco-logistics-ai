import type { AddressInfo } from "node:net";
import express from "express";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryMovement, Merchant, Order, PendingAwb, Product } from "@ecom/db";
import { encryptSecret } from "../src/lib/crypto.js";
import { inTransaction, reserveOrderStock } from "../src/lib/inventory.js";
import { parsePathaoWebhook, PATHAO_EVENT_STATUS } from "../src/lib/couriers/pathao.js";
import { parseRedxWebhook, RedxAdapter, type RedxTransport } from "../src/lib/couriers/redx.js";
import {
  MockSteadfastTransport,
  parseSteadfastWebhook,
  SteadfastAdapter,
  type SteadfastTransport,
} from "../src/lib/couriers/steadfast.js";
import { CourierError } from "../src/lib/couriers/types.js";
import { syncOrderTracking } from "../src/server/tracking.js";
import { courierWebhookRouter } from "../src/server/webhooks/courier.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Phase 1.2 — courier integration plumbing, per each courier's official
 * integration (Phase 1.1 sources):
 *   RedX      redx.com.bd/developer-api — webhook body {tracking_number,
 *             timestamp, status, message_en, …}, credentials in the callback
 *             URL query; /parcel/info carries the status, /parcel/track only
 *             message_en/message_bn/time; base path /v1.0.0-beta.
 *   Pathao    pathao-eng/courier-woocommerce-plugin — X-PATHAO-Signature is
 *             the webhook secret itself; body carries `event`, `order_status`
 *             optional; test ping `webhook_integration` answered 202.
 *   Steadfast its WordPress plugin — Authorization: Bearer <token>; body
 *             {consignment_id, status, …} (tracking_code as fallback);
 *             status_by_cid/<consignment_id>.
 */

const SECRETS = { redx: "rx-webhook-secret-123", pathao: "ph_secret", steadfast: "sf-webhook-token-456" };

async function merchantWithCouriers() {
  const m = await createMerchant();
  await Merchant.updateOne(
    { _id: m._id },
    {
      $set: {
        couriers: [
          { name: "steadfast", accountId: "acc-sf", apiKey: encryptSecret("sk_sf"), apiSecret: encryptSecret(SECRETS.steadfast) },
          { name: "pathao", accountId: "acc-ph", apiKey: encryptSecret("sk_ph"), apiSecret: encryptSecret(SECRETS.pathao) },
          { name: "redx", accountId: "acc-rx", apiKey: encryptSecret("sk_rx"), apiSecret: encryptSecret(SECRETS.redx) },
        ],
      },
    },
  );
  return m._id as Types.ObjectId;
}

async function shippedOrder(merchantId: Types.ObjectId, courier: string, trackingNumber: string, providerOrderId?: string) {
  const product = await Product.create({ merchantId, name: "Premium Achar", price: 1250, inventory: { onHand: 10, reserved: 0 } });
  const orderId = new Types.ObjectId();
  await Order.create({
    _id: orderId,
    merchantId,
    orderNumber: `ORD-${orderId.toHexString().slice(-8)}`,
    customer: { name: "Customer", phone: "+8801711111111", address: "House 1", district: "Dhaka" },
    items: [{ name: "Premium Achar", quantity: 1, price: 1250, productId: product._id }],
    order: { cod: 1330, total: 1330, status: "shipped" },
    inventory: { state: "reserved", cycle: 1, reservedAt: new Date() },
    logistics: { courier, trackingNumber, ...(providerOrderId ? { providerOrderId } : {}) },
  });
  await inTransaction((s) => reserveOrderStock(s, { merchantId, orderId, items: [{ productId: product._id as Types.ObjectId, quantity: 1 }] }));
  return { orderId, productId: product._id as Types.ObjectId };
}

async function state(orderId: Types.ObjectId, productId: Types.ObjectId) {
  const o = await Order.findById(orderId).lean();
  const p = await Product.findById(productId).lean();
  return {
    status: o!.order.status,
    events: o!.logistics?.trackingEvents?.length ?? 0,
    onHand: p!.inventory.onHand,
    reserved: p!.inventory.reserved,
    moves: (await InventoryMovement.find({ orderId }).sort({ createdAt: 1, _id: 1 }).lean()).map((m) => m.type),
  };
}

let base = "";
let server: ReturnType<express.Express["listen"]>;
const logs: string[] = [];

beforeAll(async () => {
  await ensureDb();
  await Product.syncIndexes();
  await InventoryMovement.syncIndexes();
  await Order.syncIndexes();
  const app = express();
  app.use("/api/webhooks/courier", courierWebhookRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/courier`;
  for (const k of ["log", "info", "warn", "error"] as const) {
    const orig = console[k].bind(console);
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      void orig;
    });
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => server.close(() => r()));
  await disconnectDb();
});
beforeEach(resetDb);

const post = (path: string, body: string | object, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/* ------------------------------------------------------------------------ */
/* RedX                                                                      */
/* ------------------------------------------------------------------------ */

describe("RedX — official webhook payload and URL-token auth (D1, D2)", () => {
  const official = (tracking: string, status: string) => ({
    tracking_number: tracking,
    timestamp: "2026-09-27T10:00:00.000Z",
    status,
    message_en: "Parcels delivered by rider",
    message_bn: "",
    invoice_number: "ORD-1",
    delivery_type: "regular",
  });

  it("parses the official fields (and keeps the legacy aliases)", () => {
    const r = parseRedxWebhook(official("RX-1", "delivered"))!;
    expect(r).toMatchObject({ trackingCode: "RX-1", providerStatus: "delivered", normalizedStatus: "delivered", description: "Parcels delivered by rider" });
    expect(r.at.toISOString()).toBe("2026-09-27T10:00:00.000Z");
    expect(parseRedxWebhook({ tracking_id: "RX-2", status: "delivered" })!.trackingCode).toBe("RX-2");
  });

  it("valid token → the official payload reaches the state machine; duplicate is a no-op", async () => {
    const m = await merchantWithCouriers();
    const { orderId, productId } = await shippedOrder(m, "redx", "RX-DEL-1");
    const url = `/redx/${m}?token=${encodeURIComponent(SECRETS.redx)}`;
    const r1 = await post(url, official("RX-DEL-1", "delivered"));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ statusTransition: { from: "shipped", to: "delivered" } });
    const r2 = await post(url, official("RX-DEL-1", "delivered"));
    expect(await r2.json()).toMatchObject({ duplicate: true });
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "delivered", onHand: 9, reserved: 0, events: 1 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
  });

  it("agent-returning (return in progress) keeps stock reserved; returned releases it once", async () => {
    const m = await merchantWithCouriers();
    const { orderId, productId } = await shippedOrder(m, "redx", "RX-RET-1");
    const url = `/redx/${m}?token=${SECRETS.redx}`;
    await post(url, { ...official("RX-RET-1", "agent-returning"), timestamp: "2026-09-27T09:00:00Z" });
    expect(await state(orderId, productId)).toMatchObject({ status: "shipped", reserved: 1, onHand: 10 });
    await post(url, { ...official("RX-RET-1", "returned"), timestamp: "2026-09-27T11:00:00Z" });
    await post(url, { ...official("RX-RET-1", "returned"), timestamp: "2026-09-27T11:00:00Z" });
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "rto", reserved: 0, onHand: 10 });
    expect(s.moves).toEqual(["ORDER_RESERVED", "RETURNED"]);
  });

  it("invalid, missing or header-only credentials → 401 and nothing changes", async () => {
    const m = await merchantWithCouriers();
    const { orderId, productId } = await shippedOrder(m, "redx", "RX-AUTH-1");
    const body = official("RX-AUTH-1", "delivered");
    expect((await post(`/redx/${m}?token=wrong`, body)).status).toBe(401);
    expect((await post(`/redx/${m}`, body)).status).toBe(401);
    expect((await post(`/redx/${m}`, body, { authorization: `Bearer ${SECRETS.redx}` })).status).toBe(401);
    expect(await state(orderId, productId)).toMatchObject({ status: "shipped", events: 0 });
  });

  it("malformed requests are rejected or ignored safely", async () => {
    const m = await merchantWithCouriers();
    const url = `/redx/${m}?token=${SECRETS.redx}`;
    expect((await post(url, "{not json")).status).toBe(400);
    expect(await (await post(url, { status: "delivered" })).json()).toMatchObject({ ignored: true });
    expect((await post(`/redx/not-an-id?token=${SECRETS.redx}`, official("X", "delivered"))).status).toBe(400);
  });

  it("cross-merchant: merchant B's valid token cannot touch merchant A's parcel", async () => {
    const a = await merchantWithCouriers();
    const b = await merchantWithCouriers();
    const { orderId, productId } = await shippedOrder(a, "redx", "RX-X-1");
    const res = await post(`/redx/${b}?token=${SECRETS.redx}`, official("RX-X-1", "delivered"));
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(await state(orderId, productId)).toMatchObject({ status: "shipped", reserved: 1, events: 0 });
  });
});

describe("RedX — polling reads status from /parcel/info on /v1.0.0-beta (D3, D3b)", () => {
  function recordingTransport(status: string) {
    const calls: string[] = [];
    const t: RedxTransport = {
      async request<T>(path: string) {
        calls.push(path);
        if (path.includes("/parcel/info/")) {
          return { status: 200, ok: true, data: { parcel: { tracking_id: "RX-P-1", status } } as unknown as T };
        }
        if (path.includes("/parcel/track/")) {
          return {
            status: 200,
            ok: true,
            data: {
              tracking: [
                { message_en: "Package is created successfully", message_bn: "", time: "2020-02-04T21:19:41.000Z" },
                { message_en: "Package is picked up", message_bn: "", time: "2020-02-05T11:41:03.000Z" },
              ],
            } as unknown as T,
          };
        }
        return { status: 404, ok: false, data: null as unknown as T };
      },
    };
    return { t, calls };
  }

  it("status comes from /parcel/info; the timeline from /parcel/track", async () => {
    const { t, calls } = recordingTransport("agent-returning");
    const info = await new RedxAdapter({ credentials: { accountId: "a", apiKey: "k" }, transport: t }).getTracking("RX-P-1");
    expect(calls).toEqual(["/v1.0.0-beta/parcel/info/RX-P-1", "/v1.0.0-beta/parcel/track/RX-P-1"]);
    expect(info).toMatchObject({ providerStatus: "agent-returning", normalizedStatus: "failed" });
    expect(info.events.map((e) => e.description)).toEqual(["Package is created successfully", "Package is picked up"]);
    expect(info.events[1]!.at.toISOString()).toBe("2020-02-05T11:41:03.000Z");
  });

  it("a failing /parcel/track does not block the status", async () => {
    const calls: string[] = [];
    const t: RedxTransport = {
      async request<T>(path: string) {
        calls.push(path);
        if (path.includes("/parcel/info/")) return { status: 200, ok: true, data: { parcel: { status: "delivered" } } as unknown as T };
        return { status: 500, ok: false, data: null as unknown as T };
      },
    };
    const info = await new RedxAdapter({ credentials: { accountId: "a", apiKey: "k" }, transport: t }).getTracking("RX-P-2");
    expect(info.normalizedStatus).toBe("delivered");
    expect(info.events).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* Pathao                                                                    */
/* ------------------------------------------------------------------------ */

describe("Pathao — event field and raw-secret auth (D4, D5)", () => {
  const event = (consignment: string, ev: string, extra: object = {}) => ({
    consignment_id: consignment,
    merchant_order_id: "ORD-1",
    event: ev,
    updated_at: "2026-09-27T10:00:00Z",
    ...extra,
  });

  it("event-only payloads map through the official event map", () => {
    const n = (ev: string) => parsePathaoWebhook(event("P-1", ev))!.normalizedStatus;
    expect(n("order.delivery-failed")).toBe("failed");
    expect(n("order.picked")).toBe("picked_up");
    expect(n("order.assigned-for-delivery")).toBe("out_for_delivery");
    expect(n("order.returned")).toBe("rto");
    expect(n("order.teleported")).toBe("unknown");
    expect(Object.keys(PATHAO_EVENT_STATUS)).toHaveLength(19);
  });

  it("order_status, when present, wins over the event", () => {
    expect(parsePathaoWebhook(event("P-1", "order.picked", { order_status: "Delivered" }))!.normalizedStatus).toBe("delivered");
  });

  it("raw secret → applied; wrong / missing → 401; every response carries Pathao's integration header", async () => {
    const m = await merchantWithCouriers();
    const { orderId, productId } = await shippedOrder(m, "pathao", "P-DEL-1");
    const bad = await post(`/pathao/${m}`, event("P-DEL-1", "order.delivered"), { "x-pathao-signature": "wrong" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("x-pathao-merchant-webhook-integration-secret")).toBe("f3992ecc-59da-4cbe-a049-a13da2018d51");
    expect((await post(`/pathao/${m}`, event("P-DEL-1", "order.delivered"))).status).toBe(401);
    const ok = await post(`/pathao/${m}`, event("P-DEL-1", "order.delivered"), { "x-pathao-signature": SECRETS.pathao });
    expect(ok.status).toBe(200);
    const dup = await post(`/pathao/${m}`, event("P-DEL-1", "order.delivered"), { "x-pathao-signature": SECRETS.pathao });
    expect(await dup.json()).toMatchObject({ duplicate: true });
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "delivered", onHand: 9, reserved: 0, events: 1 });
  });

  it("event-only order.delivery-failed keeps stock reserved; unknown events change nothing", async () => {
    const m = await merchantWithCouriers();
    const { orderId, productId } = await shippedOrder(m, "pathao", "P-FAIL-1");
    const h = { "x-pathao-signature": SECRETS.pathao };
    await post(`/pathao/${m}`, event("P-FAIL-1", "order.delivery-failed"), h);
    await post(`/pathao/${m}`, event("P-FAIL-1", "order.teleported", { updated_at: "2026-09-27T11:00:00Z" }), h);
    const s = await state(orderId, productId);
    expect(s).toMatchObject({ status: "shipped", reserved: 1, onHand: 10, events: 2 });
    expect(s.moves).toEqual(["ORDER_RESERVED"]);
  });

  it("the portal's webhook_integration ping is acknowledged with 202 after auth", async () => {
    const m = await merchantWithCouriers();
    const ping = await post(`/pathao/${m}`, { event: "webhook_integration" }, { "x-pathao-signature": SECRETS.pathao });
    expect(ping.status).toBe(202);
    expect(ping.headers.get("x-pathao-merchant-webhook-integration-secret")).toBe("f3992ecc-59da-4cbe-a049-a13da2018d51");
    expect((await post(`/pathao/${m}`, { event: "webhook_integration" })).status).toBe(401);
  });
});

/* ------------------------------------------------------------------------ */
/* Steadfast                                                                 */
/* ------------------------------------------------------------------------ */

describe("Steadfast — Bearer auth and consignment_id (D6, D7)", () => {
  it("parses consignment_id as the provider reference", () => {
    expect(parseSteadfastWebhook({ consignment_id: 1424107, status: "delivered" })).toMatchObject({ trackingCode: "1424107", providerRef: "1424107" });
    expect(parseSteadfastWebhook({ consignment_id: 1424107, tracking_code: "SFR1", status: "delivered" })).toMatchObject({ trackingCode: "SFR1", providerRef: "1424107" });
  });

  it("Bearer token → applied via consignment_id; query token / wrong / missing → 401; duplicate no-op", async () => {
    const m = await merchantWithCouriers();
    const { orderId, productId } = await shippedOrder(m, "steadfast", "SFR-TRACK-1", "1424107");
    const body = { consignment_id: 1424107, invoice: "ORD-1", status: "delivered", cod_amount: 1330, updated_at: "2026-09-27 10:00:00" };
    expect((await post(`/steadfast/${m}?token=${SECRETS.steadfast}`, body)).status).toBe(401);
    expect((await post(`/steadfast/${m}`, body, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(`/steadfast/${m}`, body)).status).toBe(401);
    const ok = await post(`/steadfast/${m}`, body, { authorization: `Bearer ${SECRETS.steadfast}` });
    expect(await ok.json()).toMatchObject({ statusTransition: { from: "shipped", to: "delivered" } });
    const dup = await post(`/steadfast/${m}`, body, { authorization: `Bearer ${SECRETS.steadfast}` });
    expect(await dup.json()).toMatchObject({ duplicate: true });
    expect(await state(orderId, productId)).toMatchObject({ status: "delivered", onHand: 9, reserved: 0, events: 1 });
  });

  it("cross-merchant: a consignment_id of merchant A sent to merchant B is ignored", async () => {
    const a = await merchantWithCouriers();
    const b = await merchantWithCouriers();
    const { orderId, productId } = await shippedOrder(a, "steadfast", "SFR-X-1", "777");
    const res = await post(`/steadfast/${b}`, { consignment_id: 777, status: "delivered" }, { authorization: `Bearer ${SECRETS.steadfast}` });
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(await state(orderId, productId)).toMatchObject({ status: "shipped", reserved: 1 });
  });

  it("polling calls status_by_cid with the consignment_id, never the tracking_code", async () => {
    const calls: string[] = [];
    const t: SteadfastTransport = {
      async request<T>(path: string) {
        calls.push(path);
        return { status: 200, ok: true, data: { status: 200, delivery_status: "cancelled_approval_pending" } as unknown as T };
      },
    };
    const adapter = new SteadfastAdapter({ credentials: { accountId: "a", apiKey: "k", apiSecret: "s" }, transport: t });
    const info = await adapter.getTracking("SFR-TRACK-9", { providerOrderId: "1424109" });
    expect(calls).toEqual(["/api/v1/status_by_cid/1424109"]);
    expect(info.normalizedStatus).toBe("failed");
    await expect(adapter.getTracking("SFR-TRACK-9")).rejects.toBeInstanceOf(CourierError);
    expect(calls).toHaveLength(1);
  });

  it("booking stores the consignment_id; polling works for it and for pre-existing orders via the ledger", async () => {
    MockSteadfastTransport.reset();
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder({
      customer: { name: "Jane", phone: "+8801712345678", address: "House 5", district: "Dhaka" },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
    });
    await caller.orders.bookShipment({ orderId: created.id, courier: "steadfast" });
    const booked = await Order.findById(created.id).lean();
    expect(booked!.logistics?.providerOrderId).toMatch(/^\d+$/);
    expect(booked!.logistics?.providerOrderId).not.toBe(booked!.logistics?.trackingNumber);

    const polled = await syncOrderTracking(booked as never);
    expect(polled).not.toHaveProperty("error");

    // A pre-existing order (no providerOrderId on the order) resolves it from its PendingAwb row.
    await Order.updateOne({ _id: created.id }, { $unset: { "logistics.providerOrderId": 1 } });
    expect(await PendingAwb.countDocuments({ orderId: new Types.ObjectId(created.id), status: "succeeded" })).toBe(1);
    const legacy = await Order.findById(created.id).lean();
    expect(await syncOrderTracking(legacy as never)).not.toHaveProperty("error");
  });
});

describe("secrets never reach the logs", () => {
  it("none of the webhook secrets appears in any console output of this suite", () => {
    const all = logs.join("\n");
    for (const s of [SECRETS.redx, SECRETS.steadfast]) expect(all).not.toContain(s);
    expect(all).not.toMatch(/token=rx-webhook/);
  });
});
