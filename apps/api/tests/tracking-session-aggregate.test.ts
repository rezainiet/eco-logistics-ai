import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { Types } from "mongoose";
import { TrackingEvent, TrackingSession } from "@ecom/db";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";
import {
  __resetCollectorCache,
  ensureTrackingKey,
  persistTrackingEvents,
  trackingRouter,
} from "../src/server/tracking/collector.js";
import { __resetTrackingGuardForTests } from "../src/lib/tracking-guard.js";

/**
 * Audit CR-1 / BA-1 — the collector used to fold a whole request into the
 * session of its FIRST event, decide "abandoned cart" from that one request's
 * counts, increment counters for retried (duplicate) events, and answer
 * `ok:true` even when the insert failed. These tests pin the corrected
 * behaviour: per-session attribution, cumulative abandonment, idempotent
 * counters, and honest failure responses.
 */

function buildApp() {
  const app = express();
  app.use("/track", trackingRouter);
  return app;
}

async function post(app: express.Express, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      fetch(`http://127.0.0.1:${port}/track/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (r) => {
          const json = await r.json().catch(() => ({}));
          server.close();
          resolve({ status: r.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

let seq = 0;
const eid = () => `evt_${Date.now().toString(36)}_${(seq++).toString(36)}`;
const add = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  type: "add_to_cart",
  sessionId,
  clientEventId: eid(),
  properties: { productId: `p-${seq}`, price: 500 },
  ...extra,
});
const ev = (type: string, sessionId: string, extra: Record<string, unknown> = {}) => ({
  type,
  sessionId,
  clientEventId: eid(),
  ...extra,
});

async function session(merchantId: Types.ObjectId, sessionId: string) {
  return TrackingSession.findOne({ merchantId, sessionId }).lean();
}

/** A retry that reaches the DB (another API instance, or after the 60s in-memory window). */
function forgetInMemoryGuards() {
  __resetTrackingGuardForTests();
}

describe("collector — session attribution & cumulative abandonment (CR-1)", () => {
  let merchantId: Types.ObjectId;
  let key: string;
  const app = buildApp();

  beforeEach(async () => {
    await resetDb();
    __resetCollectorCache();
    __resetTrackingGuardForTests();
    const m = await createMerchant();
    merchantId = m._id as Types.ObjectId;
    key = await ensureTrackingKey(merchantId);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(disconnectDb);

  it("two add_to_cart in one request (same session) → abandoned", async () => {
    const res = await post(app, { trackingKey: key, events: [add("sess-one-a"), add("sess-one-a")] });
    expect(res.status).toBe(200);
    const s = await session(merchantId, "sess-one-a");
    expect(s?.addToCartCount).toBe(2);
    expect(s?.abandonedCart).toBe(true);
  });

  it("a single add_to_cart is NOT abandoned (documented threshold is ≥2)", async () => {
    await post(app, { trackingKey: key, events: [add("sess-single")] });
    const s = await session(merchantId, "sess-single");
    expect(s?.addToCartCount).toBe(1);
    expect(s?.abandonedCart).toBe(false);
  });

  it("add_to_cart events spread across separate requests accumulate → abandoned", async () => {
    await post(app, { trackingKey: key, events: [add("sess-spread")] });
    expect((await session(merchantId, "sess-spread"))?.abandonedCart).toBe(false);
    await post(app, { trackingKey: key, events: [ev("page_view", "sess-spread"), add("sess-spread")] });
    const s = await session(merchantId, "sess-spread");
    expect(s?.addToCartCount).toBe(2);
    expect(s?.pageViews).toBe(1);
    expect(s?.abandonedCart).toBe(true);
  });

  it("multiple sessions in one request: each event updates only its own session", async () => {
    const res = await post(app, {
      trackingKey: key,
      events: [add("sess-mix-a"), add("sess-mix-b"), add("sess-mix-a"), ev("page_view", "sess-mix-b")],
    });
    expect(res.status).toBe(200);
    const a = await session(merchantId, "sess-mix-a");
    const b = await session(merchantId, "sess-mix-b");
    expect(a?.addToCartCount).toBe(2);
    expect(a?.pageViews).toBe(0);
    expect(a?.abandonedCart).toBe(true);
    expect(b?.addToCartCount).toBe(1);
    expect(b?.pageViews).toBe(1);
    expect(b?.abandonedCart).toBe(false);
  });

  it("identity on session B is not written onto session A", async () => {
    await post(app, {
      trackingKey: key,
      events: [add("sess-id-a"), ev("identify", "sess-id-b", { phone: "+8801711000111" })],
    });
    expect((await session(merchantId, "sess-id-a"))?.phone).toBeUndefined();
    expect((await session(merchantId, "sess-id-b"))?.phone).toBeTruthy();
  });

  it("a checkout after add_to_cart clears abandonment and marks converted", async () => {
    await post(app, { trackingKey: key, events: [add("sess-co"), add("sess-co")] });
    expect((await session(merchantId, "sess-co"))?.abandonedCart).toBe(true);
    await post(app, { trackingKey: key, events: [ev("checkout_submit", "sess-co")] });
    const s = await session(merchantId, "sess-co");
    expect(s?.converted).toBe(true);
    expect(s?.abandonedCart).toBe(false);
  });

  it("event ordering inside a request doesn't matter: first/last seen use the min/max occurredAt", async () => {
    const now = Date.now();
    await post(app, {
      trackingKey: key,
      events: [
        ev("page_view", "sess-order", { occurredAt: new Date(now - 60_000).toISOString() }),
        ev("page_view", "sess-order", { occurredAt: new Date(now - 180_000).toISOString() }),
        ev("page_view", "sess-order", { occurredAt: new Date(now - 120_000).toISOString() }),
      ],
    });
    const s = await session(merchantId, "sess-order");
    expect(new Date(s!.firstSeenAt as Date).getTime()).toBe(now - 180_000);
    expect(new Date(s!.lastSeenAt as Date).getTime()).toBe(now - 60_000);
    expect(s?.durationMs).toBe(120_000);
  });
});

describe("collector — idempotent counters & honest failures (BA-1)", () => {
  let merchantId: Types.ObjectId;
  let key: string;
  const app = buildApp();

  beforeEach(async () => {
    await resetDb();
    __resetCollectorCache();
    __resetTrackingGuardForTests();
    const m = await createMerchant();
    merchantId = m._id as Types.ObjectId;
    key = await ensureTrackingKey(merchantId);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(disconnectDb);

  it("a retried batch (same clientEventIds) stores nothing new and moves no counter", async () => {
    const batch = [add("sess-retry"), ev("page_view", "sess-retry")];
    const first = await post(app, { trackingKey: key, events: batch });
    expect(first.status).toBe(200);
    forgetInMemoryGuards();
    const retry = await post(app, { trackingKey: key, events: batch });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, accepted: 2, duplicates: 2 });
    expect(await TrackingEvent.countDocuments({ merchantId, sessionId: "sess-retry" })).toBe(2);
    const s = await session(merchantId, "sess-retry");
    expect(s?.addToCartCount).toBe(1);
    expect(s?.pageViews).toBe(1);
  });

  it("a duplicate add_to_cart can't push a session over the abandonment threshold", async () => {
    const once = add("sess-dup-abandon");
    await post(app, { trackingKey: key, events: [once] });
    forgetInMemoryGuards();
    await post(app, { trackingKey: key, events: [once] });
    const s = await session(merchantId, "sess-dup-abandon");
    expect(s?.addToCartCount).toBe(1);
    expect(s?.abandonedCart).toBe(false);
  });

  it("mixed valid + duplicate events: only the new ones are counted", async () => {
    const old1 = add("sess-mixdup");
    await post(app, { trackingKey: key, events: [old1] });
    forgetInMemoryGuards();
    const res = await post(app, {
      trackingKey: key,
      events: [old1, add("sess-mixdup"), ev("page_view", "sess-mixdup")],
    });
    expect(res.body).toMatchObject({ ok: true, accepted: 3, duplicates: 1 });
    const s = await session(merchantId, "sess-mixdup");
    expect(s?.addToCartCount).toBe(2);
    expect(s?.pageViews).toBe(1);
    expect(s?.abandonedCart).toBe(true);
  });

  it("a failed insert is NOT reported as accepted and moves no counter", async () => {
    vi.spyOn(TrackingEvent, "insertMany").mockRejectedValueOnce(new Error("connection reset"));
    const res = await post(app, { trackingKey: key, events: [add("sess-fail"), add("sess-fail")] });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: "persist_failed", accepted: 0, failed: 2 });
    expect(await session(merchantId, "sess-fail")).toBeNull();
  });

  it("partial batch failure: stored events are counted, failed ones are not, response is non-2xx; the retry completes it exactly", async () => {
    const original = TrackingEvent.insertMany.bind(TrackingEvent);
    // Store only the first document, then fail the rest with a non-duplicate error.
    vi.spyOn(TrackingEvent, "insertMany").mockImplementationOnce((async (docs: unknown[]) => {
      await original([docs[0]] as never, { ordered: false } as never);
      const err = Object.assign(new Error("write failed"), {
        writeErrors: docs.slice(1).map((_, i) => ({ index: i + 1, err: { code: 121 } })),
      });
      throw err;
    }) as never);
    const batch = [add("sess-partial"), add("sess-partial"), ev("page_view", "sess-partial")];
    const res = await post(app, { trackingKey: key, events: batch });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, accepted: 1, failed: 2 });
    let s = await session(merchantId, "sess-partial");
    expect(s?.addToCartCount).toBe(1);
    expect(s?.pageViews).toBe(0);
    expect(s?.abandonedCart).toBe(false);

    // SDK retries the same batch: the stored event is a duplicate, the rest land.
    forgetInMemoryGuards();
    const retry = await post(app, { trackingKey: key, events: batch });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, accepted: 3, duplicates: 1 });
    s = await session(merchantId, "sess-partial");
    expect(s?.addToCartCount).toBe(2);
    expect(s?.pageViews).toBe(1);
    expect(s?.abandonedCart).toBe(true);
    expect(await TrackingEvent.countDocuments({ merchantId, sessionId: "sess-partial" })).toBe(3);
  });

  it("persistTrackingEvents classifies stored / duplicate / failed exactly", async () => {
    const mk = (cid: string) => ({
      _id: new Types.ObjectId(),
      merchantId,
      sessionId: "sess-persist",
      type: "page_view",
      clientEventId: cid,
      occurredAt: new Date(),
      receivedAt: new Date(),
    });
    const first = await persistTrackingEvents([mk("cid_aaaaaaaa"), mk("cid_bbbbbbbb")]);
    expect(first.inserted.size).toBe(2);
    expect(first.duplicates + first.failed).toBe(0);
    const again = await persistTrackingEvents([mk("cid_aaaaaaaa"), mk("cid_cccccccc")]);
    expect(again.inserted.size).toBe(1);
    expect(again.duplicates).toBe(1);
    expect(again.failed).toBe(0);
  });

  it("tenant isolation: merchant B can't write into merchant A's session", async () => {
    await post(app, { trackingKey: key, events: [add("sess-tenant")] });
    const other = await createMerchant();
    const otherKey = await ensureTrackingKey(other._id as Types.ObjectId);
    const res = await post(app, { trackingKey: otherKey, events: [add("sess-tenant"), add("sess-tenant")] });
    expect(res.status).toBe(409);
    expect((await session(merchantId, "sess-tenant"))?.addToCartCount).toBe(1);
    expect(await session(other._id as Types.ObjectId, "sess-tenant")).toBeNull();
  });
});
