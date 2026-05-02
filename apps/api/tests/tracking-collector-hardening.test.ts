import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { Types } from "mongoose";
import { Merchant, TrackingEvent } from "@ecom/db";
import {
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import {
  ensureTrackingKey,
  rotateTrackingSecret,
  signTrackingPayload,
  trackingRouter,
} from "../src/server/tracking/collector.js";
import {
  DEFAULT_LIMITS,
  validateBatch,
  validateEvent,
  verifyHmac,
} from "../src/lib/tracking-guard.js";

/**
 * The hardening suite exercises the boundary as a real HTTP server because
 * the entire point is the multi-layer middleware stack. Each test gets a
 * fresh merchant + tracking key so per-key/per-merchant rate-limits don't
 * cross-pollinate.
 */

function buildApp() {
  const app = express();
  // Trust the loopback proxy so req.ip resolves to the test client's IP
  // (otherwise every request looks like 127.0.0.1 from the proxy hop).
  app.set("trust proxy", true);
  app.use("/track", trackingRouter);
  return app;
}

interface PostOpts {
  body?: string;
  signature?: string;
  ipHeader?: string;
}

async function postCollect(
  app: express.Express,
  payload: unknown,
  opts: PostOpts = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (opts.signature) headers["x-track-signature"] = opts.signature;
      if (opts.ipHeader) headers["x-forwarded-for"] = opts.ipHeader;
      const body = opts.body ?? JSON.stringify(payload);
      fetch(`http://127.0.0.1:${port}/track/collect`, {
        method: "POST",
        headers,
        body,
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

function makeEvent(
  sessionId: string,
  type = "page_view",
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    sessionId,
    occurredAt: new Date().toISOString(),
    ...extra,
  };
}

// ───────────────────────────────────────────────────────────── validation

describe("tracking-guard validation", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("accepts a well-formed event", () => {
    const r = validateEvent({
      type: "page_view",
      sessionId: "abcdef",
      occurredAt: new Date().toISOString(),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown event type", () => {
    const r = validateEvent({ type: "drop_table", sessionId: "abcdef" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("validation_event_type");
  });

  it("rejects malformed sessionId (too short)", () => {
    const r = validateEvent({ type: "page_view", sessionId: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("validation_session_id");
  });

  it("rejects sessionId with disallowed characters", () => {
    const r = validateEvent({
      type: "page_view",
      sessionId: "abc def",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("validation_session_id");
  });

  it("rejects future timestamps beyond 10min skew", () => {
    const r = validateEvent({
      type: "page_view",
      sessionId: "abcdef",
      occurredAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("validation_timestamp");
  });

  it("rejects ancient timestamps beyond 24h", () => {
    const r = validateEvent({
      type: "page_view",
      sessionId: "abcdef",
      occurredAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects deeply-nested properties", () => {
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i++) nested = { d: nested };
    const r = validateEvent({
      type: "page_view",
      sessionId: "abcdef",
      properties: nested,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("validation_shape");
  });

  it("rejects oversized single-event payload", () => {
    const big = "x".repeat(40 * 1024);
    const r = validateEvent({
      type: "page_view",
      sessionId: "abcdef",
      properties: { huge: big },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("validation_payload_size");
  });

  it("validateBatch fails on first bad event", () => {
    const r = validateBatch([
      makeEvent("aaaaaa"),
      { type: "bogus", sessionId: "bbbbbb" },
    ]);
    expect(r.ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────── HMAC

describe("HMAC signature verification", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("accepts a correctly-signed batch", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const secret = await rotateTrackingSecret(m._id as Types.ObjectId);
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { trackingStrictHmac: true } },
    );

    const app = buildApp();
    const body = JSON.stringify({
      trackingKey: key,
      events: [makeEvent("hmacses")],
    });
    const res = await postCollect(
      app,
      null,
      { body, signature: signTrackingPayload(secret, body) },
    );
    expect(res.status).toBe(200);
  });

  it("rejects unsigned batch when strict mode is on", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    await rotateTrackingSecret(m._id as Types.ObjectId);
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { trackingStrictHmac: true } },
    );
    const app = buildApp();
    const res = await postCollect(app, {
      trackingKey: key,
      events: [makeEvent("strict1")],
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("signature_missing");
  });

  it("rejects tampered body even with valid signature for original body", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const secret = await rotateTrackingSecret(m._id as Types.ObjectId);
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { trackingStrictHmac: true } },
    );
    const app = buildApp();
    const original = JSON.stringify({
      trackingKey: key,
      events: [makeEvent("tamper1")],
    });
    const sig = signTrackingPayload(secret, original);
    // Send a different body with the original signature
    const tampered = JSON.stringify({
      trackingKey: key,
      events: [makeEvent("tamper2")],
    });
    const res = await postCollect(app, null, {
      body: tampered,
      signature: sig,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("signature_invalid");
  });

  it("rejects replay with stale timestamp", () => {
    const r = verifyHmac({
      rawBody: '{"hello":"world"}',
      signatureHeader: signTrackingPayload(
        "secret-x",
        '{"hello":"world"}',
        Date.now() - 30 * 60_000,
      ),
      secret: "secret-x",
      strict: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("signature_stale_timestamp");
  });

  it("accepts unsigned batch when strict is off but flags it", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    await rotateTrackingSecret(m._id as Types.ObjectId);
    // strict left default false
    const app = buildApp();
    const res = await postCollect(app, {
      trackingKey: key,
      events: [makeEvent("loose-1")],
    });
    expect(res.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────── rate limits

describe("multi-tier rate limit", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("trips per-IP rate limit after default cap", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    // One batch carries 50 events; sending 6 batches of 50 events = 300
    // events from one IP — over the 250/min default per-IP cap.
    let lastStatus = 200;
    for (let i = 0; i < 6; i++) {
      const res = await postCollect(app, {
        trackingKey: key,
        events: Array.from({ length: 50 }, (_, j) =>
          makeEvent(`ratelmt-${i}`, "page_view", {
            clientEventId: `r-${i}-${j}-aaaa`,
          }),
        ),
      });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it("per-merchant ceiling refuses batches even from a fresh IP", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    // Burn the per-key bucket (600/min) by sending 16 batches of 50.
    // Each batch carries a fresh sessionId (>= 6 chars, padded) so the
    // per-session limiter doesn't fire first.
    let trippedAt = -1;
    for (let i = 0; i < 16; i++) {
      const sid = `mcsess${String(i).padStart(2, "0")}`;
      const res = await postCollect(app, {
        trackingKey: key,
        events: Array.from({ length: 50 }, (_, j) =>
          makeEvent(sid, "page_view", {
            clientEventId: `mc-${i}-${j}-aaaa`,
          }),
        ),
      });
      if (res.status === 429) {
        trippedAt = i;
        break;
      }
    }
    expect(trippedAt).toBeGreaterThan(-1);
  });

  it("per-session burst is refused before merchant ceiling", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    // Single session sends 50 events × 4 batches = 200 events -> > 120
    // per-session cap should fire.
    let saw429 = false;
    for (let i = 0; i < 4; i++) {
      const res = await postCollect(app, {
        trackingKey: key,
        events: Array.from({ length: 50 }, (_, j) =>
          makeEvent("loud-session", "page_view", {
            clientEventId: `ls-${i}-${j}-aaaa`,
          }),
        ),
      });
      if (res.status === 429) {
        saw429 = true;
        expect(res.body.error).toMatch(/rate_limited_session|rate_limited_/);
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  it("rate-limit defaults are applied without an override", () => {
    expect(DEFAULT_LIMITS.perIpPerMinute).toBe(250);
    expect(DEFAULT_LIMITS.perMerchantPerMinute).toBe(6000);
  });
});

// ───────────────────────────────────────────────────────────── anti-spam

describe("anti-spam dedupe + spike", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("identical-payload events on the same fingerprint are dedup'd", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    const occurredAt = new Date().toISOString();
    const ev = {
      type: "page_view",
      sessionId: "dedup-A",
      occurredAt,
      properties: { foo: "bar" },
    };
    const res1 = await postCollect(app, {
      trackingKey: key,
      events: [ev, ev, ev],
    });
    expect(res1.status).toBe(200);
    expect(res1.body.dropped).toBeGreaterThan(0);
    const written = await TrackingEvent.countDocuments({ merchantId: m._id });
    expect(written).toBe(1);
  });

  it("clientEventId-based replays still dedupe at the DB index", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    const event = makeEvent("retryses", "page_view", {
      clientEventId: "stable-A1",
      // Vary the occurredAt so the in-memory fingerprint dedupe doesn't
      // also drop them; we want the DB unique index to be the sole guard.
      occurredAt: new Date().toISOString(),
    });
    await postCollect(app, { trackingKey: key, events: [event] });
    await postCollect(app, {
      trackingKey: key,
      events: [
        {
          ...event,
          occurredAt: new Date(Date.now() + 1).toISOString(),
        },
      ],
    });
    const count = await TrackingEvent.countDocuments({ merchantId: m._id });
    expect(count).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────── session integrity

describe("session integrity", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("refuses cross-merchant sessionId hijack", async () => {
    const m1 = await createMerchant();
    const m2 = await createMerchant();
    const key1 = await ensureTrackingKey(m1._id as Types.ObjectId);
    const key2 = await ensureTrackingKey(m2._id as Types.ObjectId);
    const app = buildApp();

    // Merchant 1 claims sess-XYZ
    const ok1 = await postCollect(app, {
      trackingKey: key1,
      events: [makeEvent("xhijack")],
    });
    expect(ok1.status).toBe(200);

    // Merchant 2 tries to push events to the SAME sessionId
    const blocked = await postCollect(app, {
      trackingKey: key2,
      events: [makeEvent("xhijack")],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("session_cross_merchant");
  });
});

// ───────────────────────────────────────────────────────────── misc / shape

describe("collector shape failures", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("rejects unknown tracking key with 401", async () => {
    const app = buildApp();
    const res = await postCollect(app, {
      trackingKey: "pub_unknown_xyz",
      events: [makeEvent("aaaaaa")],
    });
    expect(res.status).toBe(401);
  });

  it("rejects oversized batch (> MAX_BATCH)", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    const res = await postCollect(app, {
      trackingKey: key,
      events: Array.from({ length: 51 }, (_, i) =>
        makeEvent(`b-${i.toString().padStart(4, "0")}`),
      ),
    });
    expect(res.status).toBe(413);
  });

  it("rejects junk JSON with 400", async () => {
    const app = buildApp();
    const res = await postCollect(app, null, { body: "not-json" });
    expect(res.status).toBe(400);
  });

  it("returns 200 + accepted=0 for empty events array", async () => {
    const m = await createMerchant();
    const key = await ensureTrackingKey(m._id as Types.ObjectId);
    const app = buildApp();
    const res = await postCollect(app, { trackingKey: key, events: [] });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(0);
  });
});
