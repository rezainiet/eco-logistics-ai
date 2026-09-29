import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { env } from "../src/env.js";
import { authRouter } from "../src/server/auth.js";
import {
  EMAIL_NOT_CONFIGURED,
  emailDeliveryStatus,
  isEmailDeliveryConfigured,
  sendEmail,
} from "../src/lib/email.js";
import { __resetSmsTransport, __setSmsTransport } from "../src/lib/sms/index.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

/**
 * Production with no email provider (live finding: signup verification
 * failed with email_provider_not_configured while the dashboard said
 * "Sent — check your inbox"). The API must report delivery as unavailable
 * so the UI can say so — without faking a provider and without leaking
 * anything account-specific.
 */

type Mutable = { NODE_ENV: string; RESEND_API_KEY?: string };
const saved = { NODE_ENV: env.NODE_ENV, RESEND_API_KEY: env.RESEND_API_KEY };

function setEmailEnv(nodeEnv: string, key: string | undefined) {
  (env as unknown as Mutable).NODE_ENV = nodeEnv;
  (env as unknown as Mutable).RESEND_API_KEY = key;
}

afterEach(() => setEmailEnv(saved.NODE_ENV, saved.RESEND_API_KEY));

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("isEmailDeliveryConfigured", () => {
  it("production without RESEND_API_KEY is unavailable — the same condition sendEmail refuses on", async () => {
    setEmailEnv("production", undefined);
    expect(isEmailDeliveryConfigured()).toBe(false);
    expect(emailDeliveryStatus()).toBe("unavailable");
    const r = await sendEmail({ to: "nobody@test.invalid", subject: "s", html: "<p>h</p>" });
    expect(r).toMatchObject({ ok: false, error: EMAIL_NOT_CONFIGURED });
  });

  it("production with a key is available", () => {
    setEmailEnv("production", "re_test_placeholder_not_a_real_key");
    expect(emailDeliveryStatus()).toBe("available");
  });

  it("development/test without a key is available (stdout fallback)", () => {
    setEmailEnv("development", undefined);
    expect(emailDeliveryStatus()).toBe("available");
    setEmailEnv("test", undefined);
    expect(emailDeliveryStatus()).toBe("available");
  });
});

describe("email delivery status on the API surface", () => {
  const realFetch = globalThis.fetch;
  const resendCalls: string[] = [];
  beforeEach(async () => {
    await resetDb();
    // Never let a password-reset SMS alert reach a real gateway.
    __setSmsTransport({
      async send() {
        return { ok: true, providerMessageId: "test", providerStatus: "ok" };
      },
    });
    // With a placeholder key, sendEmail would call Resend — intercept it.
    resendCalls.length = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.resend.com/")) {
        resendCalls.push(url);
        return new Response(JSON.stringify({ id: "test-email" }), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });
  afterEach(() => {
    __resetSmsTransport();
    globalThis.fetch = realFetch;
  });
  afterAll(disconnectDb);

  it("merchants.getProfile reports emailDelivery", async () => {
    const m = await createMerchant({ email: "delivery-profile@test.com" });
    const caller = callerFor(authUserFor(m));
    setEmailEnv("production", undefined);
    expect((await caller.merchants.getProfile()).emailDelivery).toBe("unavailable");
    setEmailEnv("production", "re_test_placeholder_not_a_real_key");
    expect((await caller.merchants.getProfile()).emailDelivery).toBe("available");
  });

  it("/auth/resend-verification says unavailable instead of implying a send", async () => {
    await createMerchant({ email: "resend-unverified@test.com" });
    setEmailEnv("production", undefined);
    await withServer(async (base) => {
      const r = await post(base, "/auth/resend-verification", { email: "resend-unverified@test.com" });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, delivery: "unavailable" });
    });
  });

  it("/auth/request-reset: identical body for known and unknown emails (no enumeration)", async () => {
    await createMerchant({ email: "reset-known-delivery@test.com" });
    for (const [mode, key, expected] of [
      ["production", undefined, "unavailable"],
      ["production", "re_test_placeholder_not_a_real_key", "available"],
    ] as const) {
      setEmailEnv(mode, key);
      await withServer(async (base) => {
        const known = await post(base, "/auth/request-reset", { email: "reset-known-delivery@test.com" });
        const unknown = await post(base, "/auth/request-reset", { email: "nobody-delivery@test.com" });
        expect(known.status).toBe(200);
        expect(known.body).toEqual({ ok: true, delivery: expected });
        expect(unknown.body).toEqual(known.body);
      });
    }
  });

  it("/auth/resend-verification: identical body for unknown emails too", async () => {
    setEmailEnv("production", undefined);
    await withServer(async (base) => {
      const r = await post(base, "/auth/resend-verification", { email: "nobody-resend@test.com" });
      expect(r.body).toEqual({ ok: true, delivery: "unavailable" });
    });
  });
});
