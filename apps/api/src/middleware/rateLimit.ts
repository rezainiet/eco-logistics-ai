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

/**
 * Tighter limiter for password-reset and email-verify resends. Keyed on the
 * email *and* IP so an attacker can't burn the budget for a victim by
 * spamming requests for their address from many IPs.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip ?? "unknown")}:${String(req.body?.email ?? "").toLowerCase()}`,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore(),
  message: { error: "too many reset attempts — try again later" },
});

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore(),
});

/**
 * Per-IP limiter for inbound webhooks. Couriers can legitimately burst
 * (status updates fan out per-package) so the budget is generous, but the
 * limiter still kills runaway senders or someone replaying captured
 * payloads at line speed.
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore(),
  message: { ok: false, error: "rate_limited" },
});

/**
 * Per-IP limiter for the public tracking lookup. Tracking codes are short
 * and enumerable, so without this any unauthenticated client could brute-
 * force the order namespace. 30/min is plenty for legitimate consumers
 * checking their own delivery status.
 */
export const publicTrackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore(),
  message: { error: "too many tracking lookups — slow down" },
});
