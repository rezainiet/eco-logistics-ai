import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "node:http";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Merchant } from "@ecom/db";
import { authRouter } from "../src/server/auth.js";
import {
  __resetSessionsForTests,
  listSessions,
  sessionExists,
} from "../src/lib/sessionStore.js";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";

/**
 * Tests for the server-side session ledger that closes the long-lived-JWT
 * hijack window. Runs against the auth router directly over HTTP so the
 * Set-Cookie path is exercised end-to-end.
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
  cookies: string[];
}

async function fetchWithCookies(
  url: string,
  init: RequestInit & { cookies?: string[] } = {},
): Promise<JsonResponse> {
  const headers = new Headers(init.headers as Record<string, string> | undefined);
  if (init.cookies?.length) headers.set("cookie", init.cookies.join("; "));
  const res = await fetch(url, { ...init, headers });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return {
    status: res.status,
    body: await res.json().catch(() => ({})),
    cookies: setCookie,
  };
}

function pickCookie(setCookie: string[], name: string): string | null {
  for (const c of setCookie) {
    const eq = c.indexOf("=");
    if (eq < 0) continue;
    if (c.slice(0, eq).trim() === name) {
      // Take the first segment up to the first ';'.
      const semi = c.indexOf(";");
      return c.slice(eq + 1, semi > 0 ? semi : undefined);
    }
  }
  return null;
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

async function loginAs(
  base: string,
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshCookie: string; sid: string }> {
  const res = await fetchWithCookies(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const access = pickCookie(res.cookies, "access_token");
  const refresh = pickCookie(res.cookies, "refresh_token");
  if (!access || !refresh) throw new Error("no auth cookies returned");
  const decoded = jwt.decode(access) as { sid?: string } | null;
  if (!decoded?.sid) throw new Error("access token missing sid claim");
  return {
    accessToken: access,
    refreshCookie: `refresh_token=${refresh}`,
    sid: decoded.sid,
  };
}

describe("session store + auth integration", () => {
  beforeEach(async () => {
    await resetDb();
    __resetSessionsForTests();
  });
  afterAll(disconnectDb);

  it("login creates a server-side session and stamps sid into both cookies", async () => {
    const m = await createMerchant({ email: "sid-login@test.com" });
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { passwordHash: await bcrypt.hash("pw-correct-1", 10) } },
    );
    await withServer(async (base) => {
      const session = await loginAs(base, "sid-login@test.com", "pw-correct-1");
      expect(await sessionExists(String(m._id), session.sid)).toBe(true);
      const sessions = await listSessions(String(m._id));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.sid).toBe(session.sid);
    });
  });

  it("refresh rotates the sid — old sid no longer valid, new one is", async () => {
    const m = await createMerchant({ email: "sid-rotate@test.com" });
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { passwordHash: await bcrypt.hash("pw-correct-1", 10) } },
    );
    await withServer(async (base) => {
      const first = await loginAs(base, "sid-rotate@test.com", "pw-correct-1");
      const refreshRes = await fetchWithCookies(`${base}/auth/refresh`, {
        method: "POST",
        cookies: [first.refreshCookie],
      });
      expect(refreshRes.status).toBe(200);
      const newAccess = pickCookie(refreshRes.cookies, "access_token");
      const decoded = jwt.decode(newAccess!) as { sid?: string } | null;
      expect(decoded?.sid).toBeTruthy();
      expect(decoded?.sid).not.toBe(first.sid);
      // Old sid is gone, new one is live.
      expect(await sessionExists(String(m._id), first.sid)).toBe(false);
      expect(await sessionExists(String(m._id), decoded!.sid!)).toBe(true);
    });
  });

  it("refresh refuses a sid that has been revoked (replay defense)", async () => {
    const m = await createMerchant({ email: "sid-replay@test.com" });
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { passwordHash: await bcrypt.hash("pw-correct-1", 10) } },
    );
    await withServer(async (base) => {
      const first = await loginAs(base, "sid-replay@test.com", "pw-correct-1");
      // First refresh succeeds and rotates.
      await fetchWithCookies(`${base}/auth/refresh`, {
        method: "POST",
        cookies: [first.refreshCookie],
      });
      // Replaying the original (now-rotated) refresh cookie must fail.
      const replay = await fetchWithCookies(`${base}/auth/refresh`, {
        method: "POST",
        cookies: [first.refreshCookie],
      });
      expect(replay.status).toBe(401);
      expect((replay.body as { error?: string }).error).toMatch(/session/i);
    });
  });

  it("logout revokes only the current session, leaves siblings intact", async () => {
    const m = await createMerchant({ email: "sid-logout@test.com" });
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { passwordHash: await bcrypt.hash("pw-correct-1", 10) } },
    );
    await withServer(async (base) => {
      const a = await loginAs(base, "sid-logout@test.com", "pw-correct-1");
      const b = await loginAs(base, "sid-logout@test.com", "pw-correct-1");
      expect(a.sid).not.toBe(b.sid);
      // Logout from session A — session B should still exist.
      const out = await fetchWithCookies(`${base}/auth/logout`, {
        method: "POST",
        cookies: [a.refreshCookie],
      });
      expect(out.status).toBe(200);
      expect(await sessionExists(String(m._id), a.sid)).toBe(false);
      expect(await sessionExists(String(m._id), b.sid)).toBe(true);
    });
  });

  it("logout-all revokes every session for the merchant", async () => {
    const m = await createMerchant({ email: "sid-logout-all@test.com" });
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { passwordHash: await bcrypt.hash("pw-correct-1", 10) } },
    );
    await withServer(async (base) => {
      const a = await loginAs(base, "sid-logout-all@test.com", "pw-correct-1");
      const b = await loginAs(base, "sid-logout-all@test.com", "pw-correct-1");
      const c = await loginAs(base, "sid-logout-all@test.com", "pw-correct-1");
      expect(await listSessions(String(m._id))).toHaveLength(3);

      const out = await fetchWithCookies(`${base}/auth/logout-all`, {
        method: "POST",
        cookies: [`access_token=${a.accessToken}`],
      });
      expect(out.status).toBe(200);
      expect((out.body as { revoked?: number }).revoked).toBe(3);
      // Every session is gone, not just A's.
      expect(await sessionExists(String(m._id), a.sid)).toBe(false);
      expect(await sessionExists(String(m._id), b.sid)).toBe(false);
      expect(await sessionExists(String(m._id), c.sid)).toBe(false);
      // Refresh on any of them should fail.
      const refresh = await fetchWithCookies(`${base}/auth/refresh`, {
        method: "POST",
        cookies: [b.refreshCookie],
      });
      expect(refresh.status).toBe(401);
    });
  });

  it("password reset revokes every existing session", async () => {
    const m = await createMerchant({ email: "sid-pwreset@test.com" });
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { passwordHash: await bcrypt.hash("pw-correct-1", 10) } },
    );
    const { createHash } = await import("node:crypto");
    const plaintext = "test-reset-token-abcdefghij";
    const hash = createHash("sha256").update(plaintext).digest("hex");
    await Merchant.updateOne(
      { _id: m._id },
      {
        $set: {
          passwordReset: {
            hash,
            expiresAt: new Date(Date.now() + 60_000),
            requestedAt: new Date(),
          },
        },
      },
    );

    await withServer(async (base) => {
      const a = await loginAs(base, "sid-pwreset@test.com", "pw-correct-1");
      const b = await loginAs(base, "sid-pwreset@test.com", "pw-correct-1");
      expect(await listSessions(String(m._id))).toHaveLength(2);

      const reset = await fetchWithCookies(`${base}/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: plaintext, password: "new-pw-9999999" }),
      });
      expect(reset.status).toBe(200);
      // Both pre-existing sessions must be dead — an attacker who already
      // had a refresh token cannot ride past the password change.
      expect(await sessionExists(String(m._id), a.sid)).toBe(false);
      expect(await sessionExists(String(m._id), b.sid)).toBe(false);
    });
  });

  it("logout-all without a valid access token returns 401", async () => {
    await withServer(async (base) => {
      const out = await fetchWithCookies(`${base}/auth/logout-all`, {
        method: "POST",
      });
      expect(out.status).toBe(401);
    });
  });
});
