import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { Types } from "mongoose";
import { Merchant, Payment } from "@ecom/db";
import { stripeWebhookRouter } from "../src/server/webhooks/stripe.js";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import { verifyStripeWebhook } from "../src/lib/stripe.js";
import { env } from "../src/env.js";

const STRIPE_TEST_SECRET = "whsec_test_sprintB_secret";

interface JsonResponse {
  status: number;
  body: unknown;
}

async function postJson(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function withWebhookServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use("/webhook", stripeWebhookRouter);
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

function signStripePayload(rawBody: string, secret = STRIPE_TEST_SECRET): { header: string; timestampSec: number } {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return { header: `t=${t},v1=${sig}`, timestampSec: t };
}

describe("Sprint B — billing + payment trust", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  describe("verifyStripeWebhook", () => {
    it("accepts a fresh, correctly-signed payload", () => {
      const body = '{"type":"ping"}';
      const { header } = signStripePayload(body);
      const verdict = verifyStripeWebhook({
        rawBody: body,
        signatureHeader: header,
        secret: STRIPE_TEST_SECRET,
      });
      expect(verdict.ok).toBe(true);
    });

    it("rejects a tampered payload", () => {
      const body = '{"type":"ping"}';
      const { header } = signStripePayload(body);
      const verdict = verifyStripeWebhook({
        rawBody: body + "tampered",
        signatureHeader: header,
        secret: STRIPE_TEST_SECRET,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("signature_mismatch");
    });

    it("rejects a payload signed with the wrong secret", () => {
      const body = '{"type":"ping"}';
      const { header } = signStripePayload(body, "whsec_wrong");
      const verdict = verifyStripeWebhook({
        rawBody: body,
        signatureHeader: header,
        secret: STRIPE_TEST_SECRET,
      });
      expect(verdict.ok).toBe(false);
    });

    it("rejects a stale timestamp outside the tolerance", () => {
      const body = '{"type":"ping"}';
      const t = Math.floor(Date.now() / 1000) - 10_000;
      const sig = createHmac("sha256", STRIPE_TEST_SECRET).update(`${t}.${body}`).digest("hex");
      const verdict = verifyStripeWebhook({
        rawBody: body,
        signatureHeader: `t=${t},v1=${sig}`,
        secret: STRIPE_TEST_SECRET,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("timestamp_out_of_tolerance");
    });
  });

  describe("billing.createCheckoutSession (mock mode)", () => {
    it("creates a pending stripe-provider payment and returns a session url", async () => {
      const m = await createMerchant({ email: "checkout@test.com", status: "trial" });
      const caller = callerFor(authUserFor(m));
      const result = await caller.billing.createCheckoutSession({ plan: "growth" });
      expect(result.mocked).toBe(true);
      expect(result.url).toContain("stripe_mock=1");

      const payment = await Payment.findById(result.paymentId).lean();
      expect(payment?.provider).toBe("stripe");
      expect(payment?.status).toBe("pending");
      expect(payment?.providerSessionId).toBe(result.sessionId);
    });
  });

  describe("/api/webhooks/stripe", () => {
    it("returns 503 when STRIPE_WEBHOOK_SECRET is unset", async () => {
      const saved = env.STRIPE_WEBHOOK_SECRET;
      (env as Record<string, unknown>).STRIPE_WEBHOOK_SECRET = undefined;
      try {
        await withWebhookServer(async (base) => {
          const res = await postJson(`${base}/webhook/`, { type: "ping" }, {
            "stripe-signature": "t=1,v1=abc",
          });
          expect(res.status).toBe(503);
        });
      } finally {
        (env as Record<string, unknown>).STRIPE_WEBHOOK_SECRET = saved;
      }
    });

    it("rejects requests with a bad signature", async () => {
      await withWebhookServer(async (base) => {
        const body = JSON.stringify({ id: "evt_x", type: "checkout.session.completed", data: { object: {} } });
        const res = await postJson(`${base}/webhook/`, body, {
          "stripe-signature": "t=1,v1=deadbeef",
        });
        expect(res.status).toBe(401);
      });
    });

    it("activates the merchant subscription on a valid checkout.session.completed", async () => {
      const m = await createMerchant({
        email: "activate@test.com",
        status: "trial",
        trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const payment = await Payment.create({
        merchantId: m._id,
        plan: "growth",
        amount: 25,
        currency: "USD",
        method: "card",
        provider: "stripe",
        status: "pending",
        providerSessionId: "cs_test_activate",
      });

      const event = {
        id: "evt_test_activate_1",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_activate",
            payment_intent: "pi_test_activate_1",
            payment_status: "paid",
            amount_total: 2500,
            currency: "usd",
            metadata: {
              merchantId: String(m._id),
              plan: "growth",
              paymentId: String(payment._id),
              periodDays: "30",
            },
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = signStripePayload(body);
      await withWebhookServer(async (base) => {
        const res = await postJson(`${base}/webhook/`, body, { "stripe-signature": header });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true });
      });

      const fresh = await Merchant.findById(m._id);
      expect(fresh?.subscription?.status).toBe("active");
      expect(fresh?.subscription?.tier).toBe("growth");
      const refreshed = await Payment.findById(payment._id);
      expect(refreshed?.status).toBe("approved");
      expect(refreshed?.providerEventId).toBe("evt_test_activate_1");
      expect(refreshed?.providerChargeId).toBe("pi_test_activate_1");
      expect(refreshed?.amount).toBe(25);
    });

    it("is idempotent on duplicate event delivery", async () => {
      const m = await createMerchant({ email: "dedupe@test.com" });
      const payment = await Payment.create({
        merchantId: m._id,
        plan: "growth",
        amount: 25,
        currency: "USD",
        method: "card",
        provider: "stripe",
        status: "pending",
        providerSessionId: "cs_test_dedupe",
      });
      const event = {
        id: "evt_dedupe_1",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_dedupe",
            payment_intent: "pi_dedupe_1",
            payment_status: "paid",
            amount_total: 2500,
            currency: "usd",
            metadata: {
              merchantId: String(m._id),
              plan: "growth",
              paymentId: String(payment._id),
            },
          },
        },
      };
      const body = JSON.stringify(event);
      await withWebhookServer(async (base) => {
        const first = signStripePayload(body);
        const r1 = await postJson(`${base}/webhook/`, body, { "stripe-signature": first.header });
        expect(r1.status).toBe(200);
        // Re-sign with a fresh timestamp (Stripe replays use a new t but the
        // event id matches) and verify the second call is a no-op.
        const second = signStripePayload(body);
        const r2 = await postJson(`${base}/webhook/`, body, { "stripe-signature": second.header });
        expect(r2.status).toBe(200);
        expect((r2.body as { duplicate?: boolean }).duplicate).toBe(true);
      });

      const approved = await Payment.find({ status: "approved", merchantId: m._id });
      expect(approved).toHaveLength(1);
    });

    it("refuses to activate when metadata points at an unknown payment row", async () => {
      const m = await createMerchant({
        email: "forged@test.com",
        status: "trial",
        trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const event = {
        id: "evt_forged",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_forged",
            payment_status: "paid",
            amount_total: 2500,
            currency: "usd",
            metadata: {
              merchantId: String(m._id),
              plan: "growth",
              paymentId: String(new Types.ObjectId()),
            },
          },
        },
      };
      const body = JSON.stringify(event);
      const { header } = signStripePayload(body);
      await withWebhookServer(async (base) => {
        const res = await postJson(`${base}/webhook/`, body, { "stripe-signature": header });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: false, error: "payment_row_not_found" });
      });
      const fresh = await Merchant.findById(m._id);
      // Subscription must NOT have been touched.
      expect(fresh?.subscription?.status).not.toBe("active");
    });

    it("ignores unrelated event types without erroring", async () => {
      const event = {
        id: "evt_ignore",
        type: "charge.dispute.created",
        data: { object: {} },
      };
      const body = JSON.stringify(event);
      const { header } = signStripePayload(body);
      await withWebhookServer(async (base) => {
        const res = await postJson(`${base}/webhook/`, body, { "stripe-signature": header });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, ignored: true });
      });
    });
  });

  describe("billing.uploadPaymentProof", () => {
    it("stores an inline proof on the merchant's pending payment", async () => {
      const m = await createMerchant({ email: "proof@test.com" });
      const caller = callerFor(authUserFor(m));
      // 1x1 PNG (base64 of an actual transparent pixel)
      const tinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      const created = await caller.billing.submitPayment({
        plan: "growth",
        method: "bkash",
        amount: 2499,
      });
      const result = await caller.billing.uploadPaymentProof({
        paymentId: created.id,
        contentType: "image/png",
        filename: "proof.png",
        data: tinyPng,
      });
      expect(result.ok).toBe(true);
      expect(result.contentType).toBe("image/png");
      expect(result.sizeBytes).toBeGreaterThan(0);

      const fetched = await caller.billing.getPaymentProof({ paymentId: created.id });
      expect(fetched.kind).toBe("inline");
      expect(fetched.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    });

    it("rejects non-image / non-pdf content types", async () => {
      const m = await createMerchant({ email: "rejecttype@test.com" });
      const caller = callerFor(authUserFor(m));
      const created = await caller.billing.submitPayment({
        plan: "growth",
        method: "bkash",
        amount: 2499,
      });
      await expect(
        caller.billing.uploadPaymentProof({
          paymentId: created.id,
          contentType: "text/plain",
          data: "aGVsbG8=",
        }),
      ).rejects.toThrow();
    });

    it("refuses to leak proofs across tenants", async () => {
      const m1 = await createMerchant({ email: "owner@test.com" });
      const m2 = await createMerchant({ email: "snoop@test.com" });
      const c1 = callerFor(authUserFor(m1));
      const c2 = callerFor(authUserFor(m2));

      const created = await c1.billing.submitPayment({
        plan: "growth",
        method: "bkash",
        amount: 2499,
      });
      await c1.billing.uploadPaymentProof({
        paymentId: created.id,
        contentType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      });

      await expect(
        c2.billing.getPaymentProof({ paymentId: created.id }),
      ).rejects.toThrow(/no proof on file/i);
    });

    it("refuses to attach proof to an already-approved payment", async () => {
      const m = await createMerchant({ email: "approvedlock@test.com" });
      const caller = callerFor(authUserFor(m));
      const created = await caller.billing.submitPayment({
        plan: "growth",
        method: "bkash",
        amount: 2499,
      });
      await Payment.updateOne({ _id: created.id }, { $set: { status: "approved" } });
      await expect(
        caller.billing.uploadPaymentProof({
          paymentId: created.id,
          contentType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        }),
      ).rejects.toThrow(/pending/i);
    });
  });
});
