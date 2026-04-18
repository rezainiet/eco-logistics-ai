import express from "express";
import cors from "cors";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { env } from "./env.js";
import { connectDb } from "./lib/db.js";
import { assertRedisOrExit } from "./lib/redis.js";
import { appRouter } from "./server/routers/index.js";
import { createContext } from "./server/trpc.js";
import { authRouter } from "./server/auth.js";
import { globalLimiter } from "./middleware/rateLimit.js";

async function main() {
  await connectDb();
  await assertRedisOrExit();

  const app = express();
  app.set("trust proxy", 1);
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRouter);

  app.use(
    "/trpc",
    globalLimiter,
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  app.listen(env.API_PORT, () => {
    console.log(`[api] listening on http://localhost:${env.API_PORT}`);
  });
}

main().catch((err) => {
  console.error("[api] fatal", err);
  process.exit(1);
});
