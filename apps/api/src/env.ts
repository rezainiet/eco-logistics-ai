import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });
config();

const schema = z
  .object({
    API_PORT: z.coerce.number().default(4000),
    MONGODB_URI: z.string().url().or(z.string().startsWith("mongodb")),
    REDIS_URL: z.string().optional(),
    JWT_SECRET: z.string().min(16),
    ADMIN_SECRET: z.string().min(24).optional(),
    COURIER_ENC_KEY: z
      .string()
      .optional()
      .refine(
        (v) => !v || (() => { try { return Buffer.from(v, "base64").length === 32; } catch { return false; } })(),
        "COURIER_ENC_KEY must be a base64-encoded 32-byte key (e.g. openssl rand -base64 32)",
      ),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    TRIAL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_PHONE_NUMBER: z.string().optional(),
    TWILIO_WEBHOOK_BASE_URL: z.string().url().optional(),
    // --- Courier defaults (per-merchant baseUrl overrides these) ---
    PATHAO_BASE_URL: z.string().url().default("https://api-hermes.pathao.com"),
    STEADFAST_BASE_URL: z.string().url().default("https://portal.packzy.com"),
    REDX_BASE_URL: z.string().url().default("https://openapi.redx.com.bd"),
    // Tracking sync schedule (minutes). 0 disables the repeatable job.
    TRACKING_SYNC_INTERVAL_MIN: z.coerce.number().int().min(0).max(1440).default(10),
    TRACKING_SYNC_BATCH: z.coerce.number().int().min(1).max(500).default(100),
    // "1" forces in-memory mock transport for all courier adapters. Auto-on in
    // test env. Useful for local dev when real sandbox credentials aren't handy.
    COURIER_MOCK: z
      .enum(["0", "1"])
      .optional()
      .transform((v) => v === "1"),
    // --- Transactional email (Resend) ---
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    PUBLIC_WEB_URL: z.string().url().optional(),
    // Trial-ending warning is sent once at this many days before expiry.
    TRIAL_WARNING_DAYS: z.coerce.number().int().min(1).max(14).default(3),
    // --- Stripe (card payments — manual bKash/Nagad still supported). ---
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    /**
     * When true, card-method payments via Stripe Checkout charge in USD using
     * each plan's `priceUSD`. When false, charge in BDT (Stripe supports BDT
     * via international acquirer, but the merchant account must be approved).
     */
    STRIPE_USE_USD: z
      .enum(["0", "1"])
      .default("1")
      .transform((v) => v === "1"),
    /** Default subscription period (days) when a Stripe payment lands. */
    STRIPE_PERIOD_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /**
     * Days of grace after `invoice.payment_failed` before the grace worker
     * suspends the merchant. Stripe smart-retry exhausts within ~3 weeks
     * but we surface a tighter 7-day default so the merchant feels the
     * pressure to update their card.
     */
    STRIPE_GRACE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    /**
     * Stripe Price ids per plan tier. Optional in dev so the suite still
     * boots when nobody has run `seedStripe` yet. The
     * `createSubscriptionCheckout` mutation refuses to mint a session if
     * the price for the requested tier is missing.
     */
    STRIPE_PRICE_STARTER: z.string().optional(),
    STRIPE_PRICE_GROWTH: z.string().optional(),
    STRIPE_PRICE_SCALE: z.string().optional(),
    STRIPE_PRICE_ENTERPRISE: z.string().optional(),
    // --- Telemetry (Sentry-compatible) ---
    SENTRY_DSN: z.string().optional(),
    SENTRY_RELEASE: z.string().optional(),
  })
  .refine((e) => e.NODE_ENV !== "production" || !!e.REDIS_URL, {
    message: "REDIS_URL is required when NODE_ENV=production",
    path: ["REDIS_URL"],
  })
  .refine((e) => e.NODE_ENV !== "production" || !!e.ADMIN_SECRET, {
    message: "ADMIN_SECRET is required when NODE_ENV=production",
    path: ["ADMIN_SECRET"],
  })
  .refine((e) => e.NODE_ENV !== "production" || !!e.COURIER_ENC_KEY, {
    message: "COURIER_ENC_KEY is required when NODE_ENV=production",
    path: ["COURIER_ENC_KEY"],
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}

export const env: Env = loadEnv();
