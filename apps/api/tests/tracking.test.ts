import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { Types } from "mongoose";
import {
  Merchant,
  TrackingEvent,
  TrackingSession,
} from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { trackingRouter, ensureTrackingKey } from "../src/server/tracking/collector.js";
import { resolveIdentityForOrder } from "../src/server/ingest.js";

function buildApp() {
  const app = express();
  app.use("/track", trackingRouter);
  return app;
}

async function postCollect(app: express.Express, body: unknown) {
  return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = { method: "POST", url: "/track/collect" };
    void req;
    // Use http via supertest-lite via fetch on a listening server.
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      fetch(`http://127.0.0.1:${port}/track/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (r) => {
          const json = await r.json().catch(() => ({}));
          resolve({ status: r.status, body: json });
          server.close();
        })
        .catch((e) => {
          server.close();
          reject(e);
        });
    });
  });
}

describe("behavior tracker collector", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("rejects unknown tracking key", async () => {
    const app = buildApp();
    const res = await postCollect(app, {
      trackingKey: "pub_unknown",
      events: [{ type: "page_view", sessionId: "sess-1" }],
    });
    expect(res.status).toBe(401);
  });

  it("ingests a batch and rolls up the session", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    const res = await postCollect(app, {
      trackingKey: key,
      events: [
        { type: "session_start", sessionId: "sess-A", anonId: "anon-1" },
        { type: "page_view", sessionId: "sess-A", path: "/", anonId: "anon-1" },
        {
          type: "product_view",
          sessionId: "sess-A",
          properties: { productId: "p-1", name: "Shirt" },
        },
        { type: "add_to_cart", sessionId: "sess-A", properties: { productId: "p-1" } },
      ],
    });
    expect(res.status).toBe(200);
    const events = await TrackingEvent.countDocuments({ merchantId: m._id });
    expect(events).toBe(4);
    const session = await TrackingSession.findOne({ sessionId: "sess-A" }).lean();
    expect(session).toBeTruthy();
    expect(session!.pageViews).toBe(1);
    expect(session!.productViews).toBe(1);
    expect(session!.addToCartCount).toBe(1);
  });

  it("identity-resolves a session to a previously-created order on phone match", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const caller = callerFor(authUserFor(m));
    const app = buildApp();

    // 1. SDK fires browse + checkout_submit with a phone we'll see in an order
    const phone = "+8801799999999";
    await postCollect(app, {
      trackingKey: key,
      events: [
        { type: "session_start", sessionId: "sess-X", anonId: "anon-X" },
        { type: "product_view", sessionId: "sess-X", properties: { productId: "p-2" } },
        { type: "add_to_cart", sessionId: "sess-X", properties: { productId: "p-2" } },
        { type: "checkout_submit", sessionId: "sess-X", phone },
      ],
    });

    const session = await TrackingSession.findOne({ sessionId: "sess-X" }).lean();
    expect(session?.phone).toBe(phone);
    expect(session?.converted).toBe(true);

    // 2. The merchant creates an order with that phone via the dashboard.
    const created = await caller.orders.createOrder({
      customer: { name: "Buyer", phone, address: "House 1, Road 2", district: "Dhaka" },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
    });

    // The createOrder mutation fires identity-resolution as a side effect.
    // Allow a tick for the async work, then assert the session is stitched.
    for (let i = 0; i < 30; i++) {
      const after = await TrackingSession.findOne({ sessionId: "sess-X" })
        .select("resolvedOrderId")
        .lean();
      if (after?.resolvedOrderId) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const after = await TrackingSession.findOne({ sessionId: "sess-X" }).lean();
    expect(String(after?.resolvedOrderId)).toBe(created.id);

    // Re-running identity resolution is a no-op (sessions already stitched).
    const replay = await resolveIdentityForOrder({
      merchantId: m._id as Types.ObjectId,
      orderId: new Types.ObjectId(created.id),
      phone,
    });
    expect(replay.stitchedSessions).toBe(0);
  });

  it("dedupes events sharing a clientEventId", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    const event = {
      type: "page_view" as const,
      sessionId: "sess-D",
      clientEventId: "stable-1",
    };
    await postCollect(app, { trackingKey: key, events: [event] });
    await postCollect(app, { trackingKey: key, events: [event] });
    const count = await TrackingEvent.countDocuments({ merchantId: m._id });
    expect(count).toBe(1);
  });

  it("ensures only one tracking key per merchant on race", async () => {
    const m = await createMerchant();
    const [a, b, c] = await Promise.all([
      ensureTrackingKey(m._id as Types.ObjectId),
      ensureTrackingKey(m._id as Types.ObjectId),
      ensureTrackingKey(m._id as Types.ObjectId),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    const m2 = await Merchant.findById(m._id).select("trackingKey").lean();
    expect(m2?.trackingKey).toBe(a);
  });
});

// ─── Sprint B — Behavior analytics plan gates ──────────────────────────

describe("behavior analytics plan gates", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("starter tier is blocked from behavior overview", async () => {
    const m = await createMerchant({ tier: "starter" });
    const caller = callerFor(authUserFor(m));
    await expect(caller.tracking.overview({ days: 30 })).rejects.toThrow(
      /entitlement_blocked:behavior_analytics_locked/,
    );
  });

  it("growth tier may query overview but is capped at 90-day retention", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    // Asking for 365 should not throw — clamped silently to 90.
    const r = await caller.tracking.overview({ days: 365 });
    expect(r).toBeDefined();
  });

  it("growth tier is blocked from advanced behavior tables (Scale+)", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.tracking.highIntentSessions({ days: 7, limit: 10 }),
    ).rejects.toThrow(/entitlement_blocked:advanced_behavior_tables_locked/);
    await expect(
      caller.tracking.suspiciousSessions({ days: 7, limit: 10 }),
    ).rejects.toThrow(/entitlement_blocked:advanced_behavior_tables_locked/);
  });

  it("scale tier can query advanced tables", async () => {
    const m = await createMerchant({ tier: "scale" });
    const caller = callerFor(authUserFor(m));
    const intent = await caller.tracking.highIntentSessions({ days: 7, limit: 10 });
    const susp = await caller.tracking.suspiciousSessions({ days: 7, limit: 10 });
    expect(Array.isArray(intent)).toBe(true);
    expect(Array.isArray(susp)).toBe(true);
  });

  it("scale tier is blocked from data exports (Enterprise-only)", async () => {
    const m = await createMerchant({ tier: "scale" });
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.tracking.exportData({ kind: "sessions", days: 30, limit: 100 }),
    ).rejects.toThrow(/entitlement_blocked:behavior_exports_locked/);
  });

  it("enterprise tier exports sessions with custom retention", async () => {
    const m = await createMerchant({ tier: "enterprise" });
    const caller = callerFor(authUserFor(m));
    const result = await caller.tracking.exportData({
      kind: "sessions",
      days: 365,
      limit: 100,
    });
    expect(result.kind).toBe("sessions");
    // Enterprise has unlimited retention — requested days flows through.
    expect(result.windowDays).toBe(365);
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("getEntitlements returns the merchant's behavior surface flags", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const ent = await caller.tracking.getEntitlements();
    expect(ent.tier).toBe("growth");
    expect(ent.behaviorAnalytics).toBe(true);
    expect(ent.advancedBehaviorTables).toBe(false);
    expect(ent.behaviorExports).toBe(false);
    expect(ent.behaviorRetentionDays).toBe(90);
    expect(ent.recommendedUpgradeTier).toBe("scale");
  });
});
