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
import { stripeWebhookRouter } from "./server/webhooks/stripe.js";
import { trackingRouter as trackingCollectorRouter } from "./server/tracking/collector.js";
import { globalLimiter } from "./middleware/rateLimit.js";
import { registerTrackingSyncWorker, scheduleTrackingSync } from "./workers/trackingSync.js";
import { registerRiskRecomputeWorker } from "./workers/riskRecompute.js";
import {
  registerWebhookRetryWorker,
  scheduleWebhookRetry,
} from "./workers/webhookRetry.js";
import { registerCommerceImportWorker } from "./workers/commerceImport.js";
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
  await initQueues();
  if (env.REDIS_URL) {
    registerTrackingSyncWorker();
    registerRiskRecomputeWorker();
    registerWebhookRetryWorker();
    registerCommerceImportWorker();
    registerCartRecoveryWorker();
    registerTrialReminderWorker();
    registerSubscriptionGraceWorker();
    await scheduleTrackingSync();
    await scheduleWebhookRetry();
    await scheduleCartRecovery();
    await scheduleTrialReminder();
    await scheduleSubscriptionGrace();
  }

  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRouter);
  app.use("/admin", adminRouter);
  // Stripe webhook MUST mount before any JSON parser — verifyStripeWebhook
  // signs over raw bytes, so `express.raw` lives inside the router.
  app.use("/api/webhooks/stripe", stripeWebhookRouter);
  app.use("/api/webhooks/twilio", twilioWebhookRouter);
  app.use("/api/integrations/webhook", integrationsWebhookRouter);
  // Shopify OAuth completion handler — install URLs from
  // `integrations.connect({provider:"shopify"})` redirect here.
  app.use("/api/integrations", shopifyOauthRouter);
  // Behavior tracker collector. CORS is wide-open so storefronts on any
  // origin can post events; they prove ownership via the merchant's
  // public tracking key.
  app.use(
    "/track",
    cors({ origin: true, credentials: false, methods: ["POST", "OPTIONS"] }),
    trackingCollectorRouter,
  );

  app.use(
    "/trpc",
    globalLimiter,
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
