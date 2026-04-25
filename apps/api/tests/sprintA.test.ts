import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { Merchant } from "@ecom/db";
import { authRouter } from "../src/server/auth.js";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import {
  buildPasswordResetEmail,
  buildPaymentApprovedEmail,
  buildTrialEndingEmail,
  buildVerifyEmail,
  webUrl,
} from "../src/lib/email.js";
import { sweepTrialReminders } from "../src/workers/trialReminder.js";

/**
 * Spin up a minimal express app over the auth router so we can exercise the
 * raw HTTP surface. We don't mount rate limiters here — those are covered by
 * existing integration tests and this file is focused on the new flows.
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
  body: unknown;
}

function fetchJson(url: string, init: RequestInit = {}): Promise<JsonResponse> {
  return fetch(url, init).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => ({})),
  }));
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = makeApp();
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

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

describe("Sprint A — auth flows + email", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  describe("email templates", () => {
    it("renderverify-email links to /verify-email with token", () => {
      const tpl = buildVerifyEmail({
        businessName: "Acme",
        verifyUrl: webUrl("/verify-email?token=abc"),
      });
      expect(tpl.subject).toMatch(/verify your email/i);
      expect(tpl.html).toContain("Acme");
      expect(tpl.text).toContain("/verify-email?token=abc");
    });

    it("password reset template references the reset url and ip", () => {
      const tpl = buildPasswordResetEmail({
        businessName: "Acme",
        resetUrl: "https://example.test/reset-password?token=t",
        ip: "203.0.113.10",
      });
      expect(tpl.subject).toMatch(/reset your.*password/i);
      expect(tpl.html).toContain("203.0.113.10");
      expect(tpl.text).toContain("https://example.test/reset-password?token=t");
    });

    it("trial-ending template pluralizes days correctly", () => {
      const single = buildTrialEndingEmail({
        businessName: "Acme",
        daysLeft: 1,
        pricingUrl: "/pricing",
        billingUrl: "/dashboard/billing",
      });
      expect(single.subject).toMatch(/1 day\b/);
      const many = buildTrialEndingEmail({
        businessName: "Acme",
        daysLeft: 3,
        pricingUrl: "/pricing",
        billingUrl: "/dashboard/billing",
      });
      expect(many.subject).toMatch(/3 days/);
    });

    it("payment-approved template includes plan name + amount", () => {
      const tpl = buildPaymentApprovedEmail({
        businessName: "Acme",
        planName: "Growth",
        amount: 2499,
        currency: "BDT",
        periodEnd: new Date("2026-01-15T00:00:00Z"),
        dashboardUrl: "/dashboard",
      });
      expect(tpl.subject).toContain("Growth");
      expect(tpl.text).toContain("2,499");
    });
  });

  describe("/auth/request-reset", () => {
    it("issues a reset token for a known email and returns 200", async () => {
      const m = await createMerchant({ email: "reset-known@test.com" });
      await withServer(async (base) => {
        const res = await fetchJson(`${base}/auth/request-reset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: m.email }),
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true });
      });
      const fresh = await Merchant.findById(m._id);
      expect(fresh?.passwordReset?.hash).toBeTruthy();
      expect(fresh?.passwordReset?.expiresAt).toBeTruthy();
      expect((fresh?.passwordReset?.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it("returns 200 for unknown emails (no user enumeration) and writes nothing", async () => {
      const before = await Merchant.countDocuments();
      await withServer(async (base) => {
        const res = await fetchJson(`${base}/auth/request-reset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "nobody@test.com" }),
        });
        expect(res.status).toBe(200);
      });
      expect(await Merchant.countDocuments()).toBe(before);
    });
  });

  describe("/auth/reset-password", () => {
    it("rotates the password hash with a valid token and marks token consumed", async () => {
      const m = await createMerchant({ email: "rotate@test.com" });
      // Mint a fake reset token directly to skip email plumbing in the test.
      const plaintext = "test-plain-token-1234567890";
      await Merchant.updateOne(
        { _id: m._id },
        {
          $set: {
            passwordReset: {
              hash: hashToken(plaintext),
              expiresAt: new Date(Date.now() + 60_000),
              requestedAt: new Date(),
            },
          },
        },
      );

      await withServer(async (base) => {
        const res = await fetchJson(`${base}/auth/reset-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: plaintext, password: "newpassword42" }),
        });
        expect(res.status).toBe(200);
      });

      const fresh = await Merchant.findById(m._id);
      expect(fresh?.passwordReset?.consumedAt).toBeTruthy();
      // Old password must NOT match.
      const oldOk = await bcrypt.compare("password123", fresh!.passwordHash);
      expect(oldOk).toBe(false);
      // New password DOES match.
      const newOk = await bcrypt.compare("newpassword42", fresh!.passwordHash);
      expect(newOk).toBe(true);
    });

    it("rejects expired tokens", async () => {
      const m = await createMerchant({ email: "expired@test.com" });
      const plaintext = "expired-token-abc12345";
      await Merchant.updateOne(
        { _id: m._id },
        {
          $set: {
            passwordReset: {
              hash: hashToken(plaintext),
              expiresAt: new Date(Date.now() - 60_000),
              requestedAt: new Date(Date.now() - 120_000),
            },
          },
        },
      );

      await withServer(async (base) => {
        const res = await fetchJson(`${base}/auth/reset-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: plaintext, password: "newpass1234" }),
        });
        expect(res.status).toBe(400);
      });
    });

    it("rejects reuse of a single-use token", async () => {
      const m = await createMerchant({ email: "reuse@test.com" });
      const plaintext = "reuse-token-abc12345";
      await Merchant.updateOne(
        { _id: m._id },
        {
          $set: {
            passwordReset: {
              hash: hashToken(plaintext),
              expiresAt: new Date(Date.now() + 60_000),
              requestedAt: new Date(),
            },
          },
        },
      );

      await withServer(async (base) => {
        const ok = await fetchJson(`${base}/auth/reset-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: plaintext, password: "firstpassword" }),
        });
        expect(ok.status).toBe(200);

        const replay = await fetchJson(`${base}/auth/reset-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: plaintext, password: "secondpassword" }),
        });
        expect(replay.status).toBe(400);
      });
    });
  });

  describe("/auth/verify-email", () => {
    it("flips emailVerified to true on a fresh token", async () => {
      const m = await createMerchant({ email: "verify@test.com" });
      const plaintext = "verify-token-xyz9876543";
      await Merchant.updateOne(
        { _id: m._id },
        {
          $set: {
            emailVerified: false,
            emailVerification: {
              hash: hashToken(plaintext),
              expiresAt: new Date(Date.now() + 60_000),
              requestedAt: new Date(),
            },
          },
        },
      );

      await withServer(async (base) => {
        const res = await fetchJson(`${base}/auth/verify-email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: plaintext }),
        });
        expect(res.status).toBe(200);
      });

      const fresh = await Merchant.findById(m._id);
      expect(fresh?.emailVerified).toBe(true);
      expect(fresh?.emailVerification?.consumedAt).toBeTruthy();
    });
  });

  describe("merchants.changePassword", () => {
    it("requires the current password to match", async () => {
      const m = await createMerchant({ email: "change@test.com" });
      const caller = callerFor(authUserFor(m));
      await expect(
        caller.merchants.changePassword({
          currentPassword: "wrongpassword",
          newPassword: "newpassword99",
        }),
      ).rejects.toThrow(/current password/i);
    });

    it("rotates the hash and invalidates any pending reset link", async () => {
      const m = await createMerchant({ email: "rotate2@test.com" });
      // Plant a pending reset token so we can assert it gets cleared.
      await Merchant.updateOne(
        { _id: m._id },
        {
          $set: {
            passwordReset: {
              hash: "deadbeef",
              expiresAt: new Date(Date.now() + 60_000),
              requestedAt: new Date(),
            },
          },
        },
      );
      const caller = callerFor(authUserFor(m));
      const result = await caller.merchants.changePassword({
        currentPassword: "password123",
        newPassword: "betterpass99",
      });
      expect(result.ok).toBe(true);

      const fresh = await Merchant.findById(m._id);
      const ok = await bcrypt.compare("betterpass99", fresh!.passwordHash);
      expect(ok).toBe(true);
      // Pending reset must be cleared.
      expect(fresh?.passwordReset).toBeFalsy();
    });

    it("rejects when new password equals the current one", async () => {
      const m = await createMerchant({ email: "same@test.com" });
      const caller = callerFor(authUserFor(m));
      await expect(
        caller.merchants.changePassword({
          currentPassword: "password123",
          newPassword: "password123",
        }),
      ).rejects.toThrow(/different/i);
    });

    it("getProfile exposes the emailVerified flag", async () => {
      const m = await createMerchant({ email: "profile@test.com" });
      const caller = callerFor(authUserFor(m));
      const profile = await caller.merchants.getProfile();
      expect(profile.emailVerified).toBe(false);
    });
  });

  describe("trial-reminder sweep", () => {
    it("sends one warning per trial cycle and is idempotent on a second sweep", async () => {
      // Trial ending in ~2 days falls inside the default 3-day warning window.
      const trialEndsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      await createMerchant({
        email: `trial-${Date.now()}@test.com`,
        status: "trial",
        trialEndsAt,
      });

      const first = await sweepTrialReminders();
      expect(first.scanned).toBeGreaterThanOrEqual(1);
      expect(first.sent).toBe(1);

      const second = await sweepTrialReminders();
      expect(second.sent).toBe(0);
    });

    it("skips merchants whose trial is outside the warning window", async () => {
      // 10 days out — well beyond TRIAL_WARNING_DAYS=3
      const trialEndsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      await createMerchant({
        email: `far-${Date.now()}@test.com`,
        status: "trial",
        trialEndsAt,
      });
      const result = await sweepTrialReminders();
      expect(result.sent).toBe(0);
    });
  });
});
