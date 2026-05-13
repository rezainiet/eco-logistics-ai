import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { env } from "./env.js";
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "./lib/db.js";
import {
  captureException,
  installProcessHooks,
  isTelemetryEnabled,
} from "./lib/telemetry.js";
import { assertRedisOrExit, getRedis } from "./lib/redis.js";
import { initQueues, shutdownQueues } from "./lib/queue.js";
import { appRouter } from "./server/routers/index.js";
import { createContext } from "./server/trpc.js";
import { authRouter } from "./server/auth.js";
import { adminRouter } from "./server/admin.js";
import { twilioWebhookRouter } from "./server/webhooks/twilio.js";
import {
  integrationsWebhookRouter,
  shopifyOauthRouter,
} from "./server/webhooks/integrations.js";
import { shopifyInstallRouter } from "./server/webhooks/shopify-install.js";
import { shopifyGdprWebhookRouter } from "./server/webhooks/shopify-gdpr.js";
import { stripeWebhookRouter } from "./server/webhooks/stripe.js";
import { resendWebhookRouter } from "./server/webhooks/resend.js";
import { courierWebhookRouter } from "./server/webhooks/courier.js";
import { smsInboundWebhookRouter } from "./server/webhooks/sms-inbound.js";
import { smsDlrWebhookRouter } from "./server/webhooks/sms-dlr.js";
import { trackingRouter as trackingCollectorRouter } from "./server/tracking/collector.js";
import { webhookLimiter } from "./middleware/rateLimit.js";
import { registerTrackingSyncWorker, scheduleTrackingSync } from "./workers/trackingSync.js";
import { registerRiskRecomputeWorker } from "./workers/riskRecompute.js";
import {
  registerWebhookRetryWorker,
  scheduleWebhookRetry,
} from "./workers/webhookRetry.js";
import { registerWebhookProcessWorker } from "./workers/webhookProcess.js";
import {
  registerFraudWeightTuningWorker,
  scheduleFraudWeightTuning,
} from "./workers/fraudWeightTuning.js";
import { registerCommerceImportWorker } from "./workers/commerceImport.js";
import { registerAutomationBookWorker } from "./workers/automationBook.js";
import { registerAutomationSmsWorker } from "./workers/automationSms.js";
import {
  registerAutomationStaleWorker,
  scheduleAutomationStaleSweep,
} from "./workers/automationStale.js";
import {
  registerAutomationWatchdogWorker,
  scheduleAutomationWatchdog,
} from "./workers/automationWatchdog.js";
import {
  registerCartRecoveryWorker,
  scheduleCartRecovery,
} from "./workers/cartRecovery.js";
import {
  registerTrialReminderWorker,
  scheduleTrialReminder,
} from "./workers/trialReminder.js";
import {
  registerSubscriptionGraceWorker,
  scheduleSubscriptionGrace,
} from "./workers/subscriptionGrace.js";
import {
  registerShopifyReconnectNudgeWorker,
  scheduleShopifyReconnectNudge,
} from "./workers/shopifyReconnectNudge.js";
import {
  registerAwbReconcileWorker,
  scheduleAwbReconcile,
} from "./workers/awbReconcile.js";
import {
  registerOrderSyncWorker,
  scheduleOrderSync,
} from "./workers/orderSync.worker.js";
import {
  registerCustomerDataRetentionWorker,
  scheduleCustomerDataRetention,
} from "./workers/customerDataRetention.worker.js";
import {
  startPendingJobReplayWorker,
  ensureRepeatableSweep,
} from "./workers/pendingJobReplay.js";
import { registerEmailWorker } from "./workers/email.worker.js";

/**
 * Parse the `TRUSTED_PROXIES` env into the value Express's `trust proxy`
 * setting expects. Returns `false` when nothing's configured so we never
 * silently honour a header an attacker might send.
 */
function parseTrustProxyValue(raw: string | undefined): boolean | number | string[] {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed === "false" || trimmed === "0") return false;
  if (trimmed === "true") return true;
  const asInt = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asInt) && String(asInt) === trimmed) return asInt;
  // Comma-separated CIDR / keyword list — Express accepts this shape directly.
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  // Eagerly validate env before any I/O — fail fast with a readable error.
  console.log(
    `[boot] env=${env.NODE_ENV} port=${env.API_PORT} telemetry=${
      isTelemetryEnabled() ? "on" : "off"
    }`,
  );
  installProcessHooks();

  await connectDb();
  await assertRedisOrExit();

  // Seed the singleton SaaS branding row so the admin Branding Panel has
  // something to update without racing the first writer. Idempotent —
  // re-running is a no-op if the row already exists. Failure here is
  // non-fatal: the resolver falls back to defaults if the row is missing.
  try {
    const { seedBranding } = await import("./scripts/seedBranding.js");
    const r = await seedBranding();
    if (r.created) console.log("[boot] branding singleton seeded");
  } catch (err) {
    console.warn(
      `[boot] branding seed failed (non-fatal): ${(err as Error).message}`,
    );
  }

  // Phase 2 BD address gazetteer — idempotent seed + prime the in-memory
  // lookup. Both steps are non-fatal: the canonicaliser degrades to
  // confidence:"low" when the gazetteer is empty, and ingest is never
  // blocked by either step. We run the seed unconditionally (cheap upserts;
  // bumps the alias set on every redeploy that ships a new lexicon) and
  // prime the loader so the first ingest doesn't pay a Mongo round-trip.
  try {
    const { seedGazetteer } = await import("./scripts/seedGazetteer.js");
    await seedGazetteer();
  } catch (err) {
    console.warn(
      `[boot] gazetteer seed failed (non-fatal): ${(err as Error).message}`,
    );
  }
  try {
    const { awaitLoad } = await import("./lib/gazetteer.js");
    const snap = await awaitLoad();
    console.log(
      `[boot] gazetteer primed size=${snap.size} version=${snap.pipelineVersion} empty=${snap.empty}`,
    );
  } catch (err) {
    console.warn(
      `[boot] gazetteer prime failed (non-fatal): ${(err as Error).message}`,
    );
  }

  // Fire-and-forget index sync. autoIndex is OFF in production (lib/db.ts)
  // so a fresh Atlas DB starts with no model indexes — including the
  // partial-unique on (merchantId, source.externalId) the ingest race fix
  // relies on. Running syncIndexes() at boot makes every deploy self-heal:
  // the api binds to its port and starts serving immediately, while index
  // builds happen in the background. Builds on a fresh DB take ~milliseconds
  // since collections are tiny; on a large DB they take longer but never
  // block the port-bind handshake the Railway healthcheck depends on.
  void (async () => {
    try {
      const {
        Order,
        WebhookInbox,
        Integration,
        Merchant,
        ImportJob,
        CustomerReliability,
        AddressReliability,
        EmailEvent,
        EmailSuppression,
      } = await import("@ecom/db");
      const models: ReadonlyArray<readonly [string, { syncIndexes: () => Promise<unknown> }]> = [
        ["Order", Order as unknown as { syncIndexes: () => Promise<unknown> }],
        ["WebhookInbox", WebhookInbox as unknown as { syncIndexes: () => Promise<unknown> }],
        ["Integration", Integration as unknown as { syncIndexes: () => Promise<unknown> }],
        ["Merchant", Merchant as unknown as { syncIndexes: () => Promise<unknown> }],
        ["ImportJob", ImportJob as unknown as { syncIndexes: () => Promise<unknown> }],
        // Delivery Reliability v1 — unique compound indexes on
        // (merchantId, phoneHash) / (merchantId, addressHash) are the upsert
        // race-safety guarantee. autoIndex=false in production means these
        // MUST be synced explicitly. See
        // `docs/audits/final-production-readiness-report.md §3.2`.
        ["CustomerReliability", CustomerReliability as unknown as { syncIndexes: () => Promise<unknown> }],
        ["AddressReliability", AddressReliability as unknown as { syncIndexes: () => Promise<unknown> }],
        // Email observability — unique index on EmailEvent.eventId is the
        // Svix-idempotency boundary; unique on EmailSuppression.address is
        // the suppression dedupe. TTL on EmailEvent.createdAt requires
        // syncIndexes to actually materialize the expireAfterSeconds.
        ["EmailEvent", EmailEvent as unknown as { syncIndexes: () => Promise<unknown> }],
        ["EmailSuppression", EmailSuppression as unknown as { syncIndexes: () => Promise<unknown> }],
      ];
      for (const [name, model] of models) {
        try {
          const t0 = Date.now();
          await model.syncIndexes();
          console.log(`[boot/syncIndexes] ${name} ok in ${Date.now() - t0}ms`);
        } catch (err) {
          console.error(`[boot/syncIndexes] ${name} failed:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.error("[boot/syncIndexes] outer failure:", (err as Error).message);
    }
  })();

  await initQueues();
  if (env.REDIS_URL) {
    registerTrackingSyncWorker();
    registerRiskRecomputeWorker();
    registerWebhookRetryWorker();
    registerWebhookProcessWorker();
    registerFraudWeightTuningWorker();
    registerCommerceImportWorker();
    registerAutomationBookWorker();
    registerAutomationSmsWorker();
    // Transactional email outbound. Event-driven (no schedule). Auth,
    // billing, and admin-alert callsites enqueue via `enqueueEmail()`;
    // BullMQ retries with exponential backoff and the generic replay
    // sweeper picks up any Redis-outage dead-letters.
    registerEmailWorker();
    registerAutomationStaleWorker();
    registerAutomationWatchdogWorker();
    registerCartRecoveryWorker();
    registerTrialReminderWorker();
    registerSubscriptionGraceWorker();
    // Nudges merchants whose Shopify integration still carries
    // legacy non-expiring tokens to reconnect. Daily sweep, 7-day
    // per-integration cooldown.
    registerShopifyReconnectNudgeWorker();
    registerAwbReconcileWorker();
    // Polling fallback for upstream order sync — runs alongside webhooks
    // so a merchant whose webhook delivery silently breaks (uninstall +
    // reinstall, scope drop, platform outage) still gets their orders
    // pulled in. Absence of this worker is the canonical "silent revenue
    // hole" failure mode; it was previously declared but not wired.
    registerOrderSyncWorker();
    // GDPR / Shopify Protected Customer Data retention sweep. Daily by
    // default; pseudonymises Order + CallLog PII older than the
    // configured window, hard-deletes identity-pivoted scratch rows.
    registerCustomerDataRetentionWorker();
    // Dead-letter replay sweeper. The worker is idempotent — registerWorker
    // returns the existing instance if one is already bound to this queue,
    // so a hot-reload or duplicate boot path can't double-register.
    startPendingJobReplayWorker();
    await scheduleTrackingSync();
    await scheduleWebhookRetry();
    await scheduleCartRecovery();
    await scheduleTrialReminder();
    await scheduleSubscriptionGrace();
    await scheduleShopifyReconnectNudge();
    await scheduleAutomationStaleSweep();
    await scheduleAutomationWatchdog();
    await scheduleAwbReconcile();
    await scheduleFraudWeightTuning();
    // Order-sync repeatable. Like ensureRepeatableSweep below, idempotent
    // on re-boot — the function clears prior repeatables matching the
    // job name before re-adding, so multi-instance deploys don't double
    // schedule. Default cadence is 5 min (DEFAULT_INTERVAL_MS in the
    // worker file).
    await scheduleOrderSync();
    // Customer-PII retention sweep. Idempotent re-schedule like the rest.
    await scheduleCustomerDataRetention();
    // Repeatable sweep tick. BullMQ keys repeat jobs by hash of (name, repeat
    // opts), so calling this on every boot does NOT create duplicate cron
    // entries — the second call is a no-op against the same key.
    await ensureRepeatableSweep();
    console.log(
      "[boot] pending-job-replay armed (worker concurrency=1, sweep every 30s)",
    );
    console.log(
      "[boot] order-sync polling fallback armed (worker concurrency=1, sweep every 5m)",
    );
  }

  const app = express();
  // Configurable trust-proxy. Defaults to OFF — we'd rather see the socket
  // address than blindly trust whatever a direct caller put in
  // X-Forwarded-For. Behind a known edge proxy (load balancer, CDN), set
  // TRUSTED_PROXIES to its IP/CIDR or to a hop count.
  const trustValue = parseTrustProxyValue(env.TRUSTED_PROXIES);
  app.set("trust proxy", trustValue);
  if (env.NODE_ENV === "production" && trustValue === false) {
    console.warn(
      "[boot] TRUSTED_PROXIES is unset — req.ip will be the socket peer. " +
        "If this API is behind a load balancer, set TRUSTED_PROXIES so " +
        "X-Forwarded-For is honoured.",
    );
  }
  // Soft warn when Shopify platform credentials are missing in production.
  // The /api/shopify/install handler refuses to redirect without them, and
  // the GDPR webhooks would fail HMAC verification - both are hard
  // blockers for App Store / Public Distribution review. Non-fatal so a
  // custom-app-only deployment can still boot.
  if (
    env.NODE_ENV === "production" &&
    (!env.SHOPIFY_APP_API_KEY || !env.SHOPIFY_APP_API_SECRET)
  ) {
    console.warn(
      "[boot] SHOPIFY_APP_API_KEY/SHOPIFY_APP_API_SECRET are not set - " +
        "the /api/shopify/install entry-point will refuse to redirect, " +
        "Shopify GDPR webhooks will fail HMAC verification, and Public " +
        "Distribution review WILL reject the listing. Set both on the " +
        "Railway prod env if this deployment is the public one.",
    );
  }
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  // Courier webhooks must mount BEFORE the global JSON parser so HMAC
  // verification sees the raw, unmutated request body. Per-IP rate limit
  // sits in front so a captured payload cannot be replayed at line speed.
  app.use("/api/webhooks/courier", webhookLimiter, courierWebhookRouter);
  app.use("/api/webhooks/sms-inbound", webhookLimiter, smsInboundWebhookRouter);
  app.use("/api/webhooks/sms-dlr", webhookLimiter, smsDlrWebhookRouter);
  // Commerce-platform webhooks (Shopify, Woo, custom_api) sign over raw
  // bytes, so the router MUST mount before the global JSON parser. The
  // route-internal `express.raw` would otherwise be a no-op once
  // `express.json` has already consumed the stream.
  app.use("/api/integrations/webhook", webhookLimiter, integrationsWebhookRouter);
  // Shopify mandatory privacy webhooks (customers/data_request,
  // customers/redact, shop/redact). MUST mount BEFORE the global JSON
  // parser — these are signed over raw bytes with the platform secret
  // and are a hard gate for App Store / Public Distribution review.
  app.use("/api/webhooks/shopify/gdpr", webhookLimiter, shopifyGdprWebhookRouter);
  app.use(express.json({ limit: "1mb" }));

  // Liveness — process is up and the event loop is responsive. Cheap
  // check used by Railway's container probe; never depends on Mongo
  // or Redis (a transient blip there must not restart the pod).
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Readiness — process is healthy AND its critical dependencies are
  // reachable. Use this for the Railway readiness probe and for any
  // load-balancer-managed cutover. Returns 200 with per-dependency
  // state on green, 503 on red. Pings only — never holds connections.
  // Failure here NEVER restarts the pod (that's `/health`'s job); it
  // just removes the pod from rotation until deps recover.
  app.get("/ready", async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let allOk = true;

    // Mongo: readyState===1 means connected. We avoid a round-trip
    // ping because Mongoose already reports an authoritative state
    // from the driver. A stale-but-connected handle still counts as
    // ready; if it's truly broken the next request would surface it.
    const mongoState = mongoose.connection.readyState;
    const mongoOk = mongoState === 1;
    checks.mongo = mongoOk
      ? { ok: true }
      : { ok: false, detail: `readyState=${mongoState}` };
    if (!mongoOk) allOk = false;

    // Redis: PING with a short hard timeout. ioredis's
    // `maxRetriesPerRequest=3` means a fully-down Redis would still
    // resolve fast (rejected after retries). The race here exists in
    // case the client is mid-reconnect and the promise hangs; we'd
    // rather report 503 than block the probe.
    if (env.REDIS_URL) {
      try {
        const client = getRedis();
        const pingResult = await Promise.race([
          client.ping(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("redis_ping_timeout")), 1500),
          ),
        ]);
        checks.redis = { ok: pingResult === "PONG" };
        if (pingResult !== "PONG") allOk = false;
      } catch (err) {
        checks.redis = { ok: false, detail: (err as Error).message.slice(0, 80) };
        allOk = false;
      }
    } else {
      // Dev-only path — Redis is optional. Reflect that honestly so a
      // local probe doesn't mistake "not configured" for "unhealthy".
      checks.redis = { ok: true, detail: "not configured (dev)" };
    }

    res.status(allOk ? 200 : 503).json({ ok: allOk, checks });
  });
  app.use("/auth", authRouter);
  app.use("/admin", adminRouter);
  // Stripe webhook MUST mount before any JSON parser — verifyStripeWebhook
  // signs over raw bytes, so `express.raw` lives inside the router.
  app.use("/api/webhooks/stripe", webhookLimiter, stripeWebhookRouter);
  // Resend transactional-email event ingestion. Svix-signed payloads,
  // idempotent on `svix-id`, persists `EmailEvent` rows and drives the
  // `EmailSuppression` list.
  app.use("/api/webhooks/resend", webhookLimiter, resendWebhookRouter);
  app.use("/api/webhooks/twilio", webhookLimiter, twilioWebhookRouter);
  // Shopify OAuth completion handler — install URLs from
  // `integrations.connect({provider:"shopify"})` redirect here. GET-only,
  // so it can sit after express.json without harm.
  app.use("/api/integrations", shopifyOauthRouter);
  // Public Shopify install entry-point. Mounted at `/api/shopify/install`
  // so Shopify (App Store, Partners test-install, referral links) and
  // direct-to-storefront merchants have a stable URL that kicks off OAuth
  // without requiring a ConfirmX login first. Completion lands on
  // `/api/integrations/oauth/shopify/callback` (above) which has been
  // extended to recognise public install nonces stored in Redis.
  app.use("/api/shopify/install", shopifyInstallRouter);
  // Behavior tracker collector. CORS is wide-open so storefronts on any
  // origin can post events; they prove ownership via the merchant's
  // public tracking key.
  app.use(
    "/track",
    cors({ origin: true, credentials: false, methods: ["POST", "OPTIONS"] }),
    trackingCollectorRouter,
  );

  // /trpc is the data plane — order create, webhook callback ingest, dashboard
  // reads, all live here. There is NO global IP limiter on it: a single
  // merchant pulling 1M orders/day legitimately burns ~12 req/sec from one
  // egress. Fairness and abuse protection come from two layers that DO
  // discriminate by tenant: (1) auth-gated procedures via the per-merchant
  // token bucket in safeEnqueue / mutation paths, and (2) the dedicated
  // login/signup/passwordReset/webhook/publicTracking limiters mounted on
  // their own routes above. A single global counter would cap the entire
  // platform at one tenant's worth of traffic.
  app.use(
    "/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Final error handler — anything that propagates out of a non-tRPC route
  // (raw webhook handlers, ingest collector, etc.) ends up here. We log,
  // capture to telemetry, and respond with a generic 500 so we never leak
  // internals.
  app.use(
    (
      err: Error,
      req: import("express").Request,
      res: import("express").Response,
      _next: import("express").NextFunction,
    ) => {
      console.error(`[api] unhandled ${req.method} ${req.path}:`, err.message);
      captureException(err, {
        tags: { source: "express", method: req.method, path: req.path },
      });
      if (res.headersSent) return;
      res.status(500).json({ ok: false, error: "internal_error" });
    },
  );

  const server = app.listen(env.API_PORT, () => {
    console.log(`[api] listening on http://localhost:${env.API_PORT}`);
  });

  /**
   * Graceful shutdown sequence. Order matters:
   *
   *   1. Stop accepting NEW connections, but let in-flight ones finish.
   *      `server.close(cb)` resolves only when the last live socket
   *      closes — without the await, `process.exit` in step 4 would
   *      race the response.
   *   2. Drain BullMQ workers and queues. `shutdownQueues` calls
   *      `worker.close()` on each worker, which lets the current job
   *      finish before disposing — so a webhook mid-process is not
   *      torn. The shared Redis connection is `quit`'d at the end.
   *   3. Close the Mongo connection. Out-of-band script paths already
   *      do this; the api server skipped it before, so a SIGTERM left
   *      in-flight queries to be force-closed by `process.exit`.
   *   4. `process.exit(0)` only after 1–3 have resolved.
   *
   * Idempotent: a second SIGTERM during the shutdown does not restart
   * the chain. A 25 s watchdog force-exits if any step deadlocks; this
   * sits comfortably inside Railway's default 30 s drain window.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`[shutdown] ${signal} ignored — shutdown already in progress`);
      return;
    }
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — draining`);

    // Watchdog: if any step deadlocks (a stuck Mongo socket, a runaway
    // worker job that never yields), force-exit before the platform
    // SIGKILLs us. `unref()` so this timer never on-its-own keeps the
    // process alive after a clean shutdown.
    const watchdog = setTimeout(() => {
      console.error("[shutdown] watchdog tripped at 25s — forcing exit(1)");
      process.exit(1);
    }, 25_000);
    watchdog.unref();

    try {
      await new Promise<void>((resolve) => {
        server.close((err?: Error) => {
          if (err) console.error("[shutdown] http close error", err.message);
          else console.log("[shutdown] http server closed");
          resolve();
        });
      });

      await shutdownQueues().catch((err) =>
        console.error("[shutdown] queue shutdown error", (err as Error).message),
      );
      console.log("[shutdown] queues drained");

      await disconnectDb().catch((err) =>
        console.error("[shutdown] db disconnect error", (err as Error).message),
      );
      console.log("[shutdown] mongo disconnected");

      console.log("[shutdown] complete");
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] unexpected error", (err as Error).message);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[api] fatal", err);
  process.exit(1);
});
