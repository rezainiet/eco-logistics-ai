import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import { getRedis } from "../lib/redis.js";

function redisStore(): Store | undefined {
  try {
    const client = getRedis();
    return new RedisStore({
      sendCommand: (...args: string[]) =>
        client.call(args[0]!, ...args.slice(1)) as Promise<any>,
    });
  } catch {
    return undefined;
  }
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip ?? "unknown")}:${String(req.body?.email ?? "").toLowerCase()}`,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: redisStore(),
  message: { error: "too many login attempts — try again later" },
});

export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore(),
  message: { error: "too many signups from this IP" },
});

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore(),
});
