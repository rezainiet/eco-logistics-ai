import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { TrackingEvent } from "@ecom/db";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import {
  captureException,
  captureMessage,
  isTelemetryEnabled,
} from "../src/lib/telemetry.js";
import { env } from "../src/env.js";

/**
 * Sprint C — production-readiness coverage.
 *
 * Tracker install verification + telemetry shape are critical to launch
 * trust signals. We don't actually hit Sentry; we mock fetch and assert the
 * envelope we'd ship.
 */

describe("Sprint C — tracker + telemetry + ops", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  describe("tracking.getInstallation", () => {
    it("reports not_installed for a fresh merchant", async () => {
      const m = await createMerchant({ email: `fresh-${Date.now()}@test.com` });
      const caller = callerFor(authUserFor(m));
      const result = await caller.tracking.getInstallation();
      expect(result.install.status).toBe("not_installed");
      expect(result.install.lastSeenAt).toBeNull();
      expect(result.install.firstSeenAt).toBeNull();
      expect(result.install.sessionCount).toBe(0);
      expect(result.snippet).toContain(result.key);
    });

    it("flips to healthy after a recent tracking event lands", async () => {
      const m = await createMerchant({ email: `live-${Date.now()}@test.com` });
      // Plant a recent event directly so we don't have to spin up the
      // collector router — we're verifying the read-side aggregation.
      await TrackingEvent.create({
        merchantId: m._id,
        sessionId: "sess-1",
        anonId: "anon-1",
        clientEventId: `evt-${Date.now()}`,
        type: "page_view",
        occurredAt: new Date(),
        receivedAt: new Date(),
      });
      const caller = callerFor(authUserFor(m));
      const result = await caller.tracking.getInstallation();
      expect(result.install.status).toBe("healthy");
      expect(result.install.lastSeenAt).toBeTruthy();
      expect(result.install.latestEventType).toBe("page_view");
    });

    it("flips to stale after 8 days of silence", async () => {
      const m = await createMerchant({ email: `stale-${Date.now()}@test.com` });
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await TrackingEvent.create({
        merchantId: m._id,
        sessionId: "sess-old",
        anonId: "anon-old",
        clientEventId: `evt-old-${Date.now()}`,
        type: "page_view",
        occurredAt: old,
        receivedAt: old,
      });
      const caller = callerFor(authUserFor(m));
      const result = await caller.tracking.getInstallation();
      expect(result.install.status).toBe("stale");
    });

    it("scopes counts to the requesting merchant", async () => {
      const m1 = await createMerchant({ email: `t1-${Date.now()}@test.com` });
      const m2 = await createMerchant({ email: `t2-${Date.now()}@test.com` });
      // Plant events under m1 — m2's view must remain not_installed.
      const now = new Date();
      await TrackingEvent.create({
        merchantId: m1._id,
        sessionId: "sess-x",
        anonId: "anon-x",
        clientEventId: `evt-${Date.now()}`,
        type: "page_view",
        occurredAt: now,
        receivedAt: now,
      });
      const c2 = callerFor(authUserFor(m2));
      const view = await c2.tracking.getInstallation();
      expect(view.install.status).toBe("not_installed");
      expect(view.install.sessionCount).toBe(0);
    });
  });

  describe("telemetry capture", () => {
    it("is a no-op when SENTRY_DSN is unset (no fetch fired)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      // env is loaded once at module import; ensure the field is empty for this run.
      const saved = env.SENTRY_DSN;
      (env as Record<string, unknown>).SENTRY_DSN = undefined;
      try {
        expect(isTelemetryEnabled()).toBe(false);
        captureException(new Error("boom"));
        captureMessage("hello");
        // Give the void promise a tick — fetch should still not fire.
        await Promise.resolve();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        (env as Record<string, unknown>).SENTRY_DSN = saved;
        fetchSpy.mockRestore();
      }
    });

    it("posts a Sentry envelope with the expected event shape when DSN is set", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      const saved = env.SENTRY_DSN;
      (env as Record<string, unknown>).SENTRY_DSN =
        "https://abc123def456@o1.ingest.sentry.io/4567";
      try {
        expect(isTelemetryEnabled()).toBe(true);
        captureException(new Error("kaboom"), {
          tags: { source: "test" },
          user: { id: "user-1", email: "t@t.com" },
        });
        // Allow the fire-and-forget Promise to resolve.
        await new Promise((r) => setTimeout(r, 10));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const call = fetchSpy.mock.calls[0]!;
        const url = String(call[0]);
        expect(url).toBe("https://o1.ingest.sentry.io/api/4567/envelope/");
        const init = call[1] as RequestInit;
        expect(init.method).toBe("POST");
        const headers = init.headers as Record<string, string>;
        expect(headers["X-Sentry-Auth"]).toContain("sentry_key=abc123def456");
        const body = init.body as string;
        // Envelope = headerJson \n itemHeaderJson \n itemBodyJson
        const lines = body.split("\n");
        expect(lines).toHaveLength(3);
        const event = JSON.parse(lines[2]!);
        expect(event.exception.values[0].type).toBe("Error");
        expect(event.exception.values[0].value).toBe("kaboom");
        expect(event.tags.source).toBe("test");
        expect(event.user.id).toBe("user-1");
      } finally {
        (env as Record<string, unknown>).SENTRY_DSN = saved;
        fetchSpy.mockRestore();
      }
    });

    it("malformed DSNs are quietly ignored", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const saved = env.SENTRY_DSN;
      (env as Record<string, unknown>).SENTRY_DSN = "not-a-valid-dsn";
      try {
        expect(isTelemetryEnabled()).toBe(false);
        captureException(new Error("boom"));
        await Promise.resolve();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        (env as Record<string, unknown>).SENTRY_DSN = saved;
        fetchSpy.mockRestore();
      }
    });
  });
});
