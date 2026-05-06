import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { env } from "./env.js";
import { connectDb } from "./lib/db.js";
import {
  captureException,
  installProcessHooks,
  isTelemetryEnabled,
} from "./lib/telemetry.js";
import { assertRedisOrExit } from "./lib/redis.js";
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
import { shopifyGdprWebhookRouter } from "./server/webhooks/shopify-gdpr.js";
import { stripeWebhookRouter } from "./server/webhooks/stripe.js";
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
  registerAwbReconcileWorker,
  scheduleAwbReconcile,
} from "./workers/awbReconcile.js";
import {
  startPendingJobReplayWorker,
  ensureRepeatableSweep,
} from "./workers/pendingJobReplay.js";

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
      const { Order, WebhookInbox, Integration, Merchant, ImportJob } = await import("@ecom/db");
      const models: ReadonlyArray<readonly [string, { syncIndexes: () => Promise<unknown> }]> = [
        ["Order", Order as unknown as { syncIndexes: () => Promise<unknown> }],
        ["WebhookInbox", WebhookInbox as unknown as { syncIndexes: () => Promise<unknown> }],
        ["Integration", Integration as unknown as { syncIndexes: () => Promise<unknown> }],
        ["Merchant", Merchant as unknown as { syncIndexes: () => Promise<unknown> }],
        ["ImportJob", ImportJob as unknown as { syncIndexes: () => Promise<unknown> }],
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
    registerAutomationStaleWorker();
    registerAutomationWatchdogWorker();
    registerCartRecoveryWorker();
    registerTrialReminderWorker();
    registerSubscriptionGraceWorker();
    registerAwbReconcileWorker();
    // Dead-letter replay sweeper. The worker is idempotent — registerWorker
    // returns the existing instance if one is already bound to this queue,
    // so a hot-reload or duplicate boot path can't double-register.
    startPendingJobReplayWorker();
    await scheduleTrackingSync();
    await scheduleWebhookRetry();
    await scheduleCartRecovery();
    await scheduleTrialReminder();
    await scheduleSubscriptionGrace();
    await scheduleAutomationStaleSweep();
    await scheduleAutomationWatchdog();
    await scheduleAwbReconcile();
    await scheduleFraudWeightTuning();
    // Repeatable sweep tick. BullMQ keys repeat jobs by hash of (name, repeat
    // opts), so calling this on every boot does NOT create duplicate cron
    // entries — the second call is a no-op against the same key.
    await ensureRepeatableSweep();
    console.log(
      "[boot] pending-job-replay armed (worker concurrency=1, sweep every 30s)",
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

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRouter);
  app.use("/admin", adminRouter);
  // Stripe webhook MUST mount before any JSON parser — verifyStripeWebhook
  // signs over raw bytes, so `express.raw` lives inside the router.
  app.use("/api/webhooks/stripe", webhookLimiter, stripeWebhookRouter);
  app.use("/api/webhooks/twilio", webhookLimiter, twilioWebhookRouter);
  // Shopify OAuth completion handler — install URLs from
  // `integrations.connect({provider:"shopify"})` redirect here. GET-only,
  // so it can sit after express.json without harm.
  app.use("/api/integrations", shopifyOauthRouter);
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

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} received, shutting down`);
    server.close();
    await shutdownQueues().catch((err) => console.error("[api] queue shutdown", err));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[api] fatal", err);
  process.exit(1);
});

