import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { env } from "./env.js";
import { connectDb } from "./lib/db.js";
import { assertRedisOrExit } from "./lib/redis.js";
import { initQueues, shutdownQueues } from "./lib/queue.js";
import { appRouter } from "./server/routers/index.js";
import { createContext } from "./server/trpc.js";
import { authRouter } from "./server/auth.js";
import { adminRouter } from "./server/admin.js";
import { twilioWebhookRouter } from "./server/webhooks/twilio.js";
import { globalLimiter } from "./middleware/rateLimit.js";
import { registerTrackingSyncWorker, scheduleTrackingSync } from "./workers/trackingSync.js";
import { registerRiskRecomputeWorker } from "./workers/riskRecompute.js";

async function main() {
  // Eagerly validate env before any I/O — fail fast with a readable error.
  console.log(`[boot] env=${env.NODE_ENV} port=${env.API_PORT}`);

  await connectDb();
  await assertRedisOrExit();
  await initQueues();
  if (env.REDIS_URL) {
    registerTrackingSyncWorker();
    registerRiskRecomputeWorker();
    await scheduleTrackingSync();
  }

  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRouter);
  app.use("/admin", adminRouter);
  app.use("/api/webhooks/twilio", twilioWebhookRouter);

  app.use(
    "/trpc",
    globalLimiter,
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
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
