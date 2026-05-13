import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import { Integration, Merchant } from "@ecom/db";

import { authRouter } from "../src/server/auth.js";
import { env } from "../src/env.js";
import { __resetSessionsForTests } from "../src/lib/sessionStore.js";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";

/**
 * Integration tests for POST /auth/shopify/exchange — Phase B B3.
 *
 * Goal: verify the embedded-auth bridge endpoint never accepts a forged
 * session token, never returns a JWT for a shop that has no Integration
 * row, and DOES return a usable JWT (in /auth/login response shape) when
 * the shop is correctly attached.
 *
 * The endpoint runs over the real express handler — we mount the
 * authRouter on a stub app and hit it with `fetch()`. Shopify session
 * tokens are HS256 JWTs signed with the app's API secret, so we mint
 * fakes by calling jwt.sign() with the same secret the verifier reads
 * from env.
 */

function makeApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/auth", authRouter);
  return app;
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  url: string,
  body: unknown,
): Promise<JsonResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

/**
 * Mint a Shopify-compatible session token with the same shape App Bridge
 * issues. Used to drive the verifier through both happy and failure paths
 * without touching the real Shopify network.
 */
function mintSessionToken(opts: {
  shop: string;
  apiKey: string;
  apiSecret: string;
  exp?: number;
  audOverride?: string;
  destOverride?: string;
  issOverride?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const dest = opts.destOverride ?? `https://${opts.shop}`;
  const iss = opts.issOverride ?? `https://${opts.shop}/admin`;
  return jwt.sign(
    {
      iss,
      dest,
      aud: opts.audOverride ?? opts.apiKey,
      sub: "user-123",
      exp: opts.exp ?? now + 60,
      nbf: now - 5,
      iat: now,
      jti: "jti-fixture-1",
      sid: "sid-fixture-1",
    },
    opts.apiSecret,
    { algorithm: "HS256" },
  );
}

let server: ReturnType<ReturnType<typeof makeApp>["listen"]> | null = null;
let baseUrl = "";

describe("POST /auth/shopify/exchange", () => {
  beforeEach(async () => {
    await resetDb();
    __resetSessionsForTests?.();
    if (!server) {
      const app = makeApp();
      server = app.listen(0);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
    }
  });

  afterAll(async () => {
    server?.close();
    await disconnectDb();
  });

  it("rejects malformed bodies with 400", async () => {
    const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_session_token_request");
  });

  it("returns 503 when SHOPIFY_APP_API_KEY/SECRET env are unset", async () => {
    if (!env.SHOPIFY_APP_API_KEY || !env.SHOPIFY_APP_API_SECRET) {
      // Env-driven check — when the test fixture lacks the env, the
      // endpoint must surface the misconfiguration explicitly rather
      // than crashing with a verifier error.
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: "anything-non-empty-and-long-enough-to-pass-zod-min",
      });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("embedded_auth_not_configured");
    } else {
      // Env IS set — skip this branch, the negative cases below cover
      // the verifier paths.
      expect(true).toBe(true);
    }
  });

  // The remaining tests need both env values to be set. The integration
  // tests' globalSetup handles env loading; we guard with conditional
  // execution so the suite gracefully reports "skipped" rather than
  // false-failing in a misconfigured environment.
  const hasShopifyEnv = !!env.SHOPIFY_APP_API_KEY && !!env.SHOPIFY_APP_API_SECRET;
  const conditional = hasShopifyEnv ? it : it.skip;

  conditional(
    "rejects a session token signed with a wrong secret (401)",
    async () => {
      const token = mintSessionToken({
        shop: "test-shop.myshopify.com",
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: "wrong-secret-not-the-real-one",
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("invalid_session_token");
    },
  );

  conditional(
    "rejects a session token whose aud is for a different app (401)",
    async () => {
      const token = mintSessionToken({
        shop: "test-shop.myshopify.com",
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: env.SHOPIFY_APP_API_SECRET!,
        audOverride: "some-other-apps-api-key",
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("invalid_session_token");
    },
  );

  conditional(
    "rejects a session token whose dest is not a myshopify.com shop (401)",
    async () => {
      const token = mintSessionToken({
        shop: "test-shop.myshopify.com",
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: env.SHOPIFY_APP_API_SECRET!,
        destOverride: "https://attacker.example.com",
        issOverride: "https://attacker.example.com/admin",
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("invalid_session_token");
    },
  );

  conditional(
    "rejects a session token whose dest and iss disagree (401)",
    async () => {
      const token = mintSessionToken({
        shop: "test-shop.myshopify.com",
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: env.SHOPIFY_APP_API_SECRET!,
        destOverride: "https://shop-a.myshopify.com",
        issOverride: "https://shop-b.myshopify.com/admin",
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("invalid_session_token");
    },
  );

  conditional(
    "rejects an expired session token (401)",
    async () => {
      const token = mintSessionToken({
        shop: "test-shop.myshopify.com",
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: env.SHOPIFY_APP_API_SECRET!,
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("invalid_session_token");
    },
  );

  conditional(
    "attempts auto-provision (Token Exchange) when no Integration row matches the verified shop",
    async () => {
      // Phase C C7 swapped the old Phase-B 404 contract for an
      // auto-provision branch: when no Integration is found for the
      // verified shop, the endpoint POSTs to Shopify's Token
      // Exchange endpoint (accounts.shopify.com/.../access_token) to
      // mint an offline token and provision a fresh
      // Merchant+Integration on the fly.
      //
      // In this test environment we can't mock Shopify's network,
      // so the Token Exchange fails and the handler returns 502
      // `token_exchange_failed` with the verified shop in the body.
      // What we're asserting here is the contract:
      //   - the no-integration branch DID NOT short-circuit with 404,
      //   - the verifier passed (otherwise we'd see 401),
      //   - the shop made it through to the auto-provision attempt.
      const shop = "phase-b-no-integration.myshopify.com";
      const token = mintSessionToken({
        shop,
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: env.SHOPIFY_APP_API_SECRET!,
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("token_exchange_failed");
      expect(r.body.shop).toBe(shop);
    },
  );

  conditional(
    "returns the /auth/login JSON shape when the shop has a connected Integration",
    async () => {
      const shop = "phase-b-happy.myshopify.com";
      // Seed a merchant + a connected Shopify integration pointing at
      // it. The endpoint should resolve the merchant via the
      // Integration's merchantId and mint our JWT.
      const merchant = await createMerchant({
        email: "phase-b@confirmx.test",
        businessName: "Phase B Test Shop",
      });
      await Integration.create({
        merchantId: merchant._id,
        provider: "shopify",
        accountKey: shop,
        status: "connected",
        label: `Shopify · ${shop}`,
        permissions: ["read_orders", "read_customers"],
        connectedAt: new Date(),
        health: { ok: true, lastCheckedAt: new Date() },
      });

      const token = mintSessionToken({
        shop,
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: env.SHOPIFY_APP_API_SECRET!,
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(200);
      // Body parity with /auth/login + extra embed metadata.
      expect(r.body.id).toBe(String(merchant._id));
      expect(r.body.email).toBe("phase-b@confirmx.test");
      expect(r.body.name).toBe("Phase B Test Shop");
      expect(r.body.role).toBe("merchant");
      expect(typeof r.body.token).toBe("string");
      expect((r.body.token as string).length).toBeGreaterThan(40);
      expect(typeof r.body.csrfToken).toBe("string");
      expect(r.body.shop).toBe(shop);
      // The minted JWT should be a valid HS256 signed by JWT_SECRET
      // and carry the merchant's id in the `id` claim — same shape
      // as /auth/login emits.
      const decoded = jwt.verify(r.body.token as string, env.JWT_SECRET, {
        algorithms: ["HS256"],
      }) as Record<string, unknown>;
      expect(decoded.id).toBe(String(merchant._id));
      expect(decoded.email).toBe("phase-b@confirmx.test");
      expect(decoded.typ).toBe("access");
    },
  );

  conditional(
    "matches Integration rows in pending or error status, not just connected",
    async () => {
      const shop = "phase-b-error-status.myshopify.com";
      const merchant = await createMerchant({
        email: "phase-b-err@confirmx.test",
        businessName: "Phase B Err Shop",
      });
      await Integration.create({
        merchantId: merchant._id,
        provider: "shopify",
        accountKey: shop,
        // Today's broken integrations sit in `error` (admin API 403'd)
        // — the embedded-auth path must still surface them so the
        // merchant can land in the dashboard and see the issue.
        status: "error",
        label: `Shopify · ${shop}`,
        connectedAt: new Date(),
        lastError: "shopify 403: non-expiring access tokens (test fixture)",
      });

      const token = mintSessionToken({
        shop,
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: env.SHOPIFY_APP_API_SECRET!,
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(String(merchant._id));
    },
  );

  conditional(
    "skips integrations whose status is disconnected and re-attempts auto-provision",
    async () => {
      const shop = "phase-b-disconnected.myshopify.com";
      const merchant = await createMerchant({
        email: "phase-b-dc@confirmx.test",
        businessName: "Phase B DC Shop",
      });
      await Integration.create({
        merchantId: merchant._id,
        provider: "shopify",
        accountKey: shop,
        // Disconnected = merchant explicitly tore down the connection.
        // Phase C re-evaluated this: a disconnected row should NOT
        // short-circuit the embedded-auth path either — instead, the
        // handler ignores it (the lookup filters disconnected out)
        // and falls through to the auto-provision branch. In tests
        // that branch can't reach Shopify, so we see 502
        // token_exchange_failed; in production it mints a fresh
        // offline token and a new Integration row.
        status: "disconnected",
        label: `Shopify · ${shop}`,
        disconnectedAt: new Date(),
      });

      const token = mintSessionToken({
        shop,
        apiKey: env.SHOPIFY_APP_API_KEY!,
        apiSecret: env.SHOPIFY_APP_API_SECRET!,
      });
      const r = await postJson(`${baseUrl}/auth/shopify/exchange`, {
        sessionToken: token,
      });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("token_exchange_failed");
      expect(r.body.shop).toBe(shop);
    },
  );
});
