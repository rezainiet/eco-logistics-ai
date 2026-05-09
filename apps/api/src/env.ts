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
      .min(1, "COURIER_ENC_KEY is required in every environment (dev/test/staging/prod)")
      .refine(
        (v) => { try { return Buffer.from(v, "base64").length === 32; } catch { return false; } },
        "COURIER_ENC_KEY must be a base64-encoded 32-byte key (e.g. openssl rand -base64 32)",
      ),
    /**
     * Allowed Origin for browser fetches against this API. Must match the
     * `Origin` header the browser sends — and per the CORS spec, that
     * value never has a trailing slash. We strip any trailing slash
     * defensively so a Railway env var typed as `https://app.example.com/`
     * (easy mistake when copying from a browser address bar) doesn't
     * silently fail every preflight with an `Access-Control-Allow-Origin`
     * mismatch. Already cost ~1h of debugging once.
     */
    CORS_ORIGIN: z
      .string()
      .default("http://localhost:3001")
      .transform((v) => v.replace(/\/+$/, "")),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    /**
     * Express `trust proxy` setting. Accepts:
     *   - integer `N` (trust the last N hops on `X-Forwarded-For`)
     *   - comma-separated CIDRs (e.g. "10.0.0.0/8,fd00::/8")
     *   - "loopback" / "linklocal" / "uniquelocal" / combinations
     *   - "false" / "0" / unset → don't trust the header at all
     *
     * Why this matters: blindly trusting `X-Forwarded-For` lets a direct
     * caller spoof the client IP we record for fraud signals + audit logs
     * + rate-limit keying. If the API is exposed without an edge proxy,
     * leave this unset.
     */
    TRUSTED_PROXIES: z.string().optional(),
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
    TRACKING_SYNC_INTERVAL_MIN: z.coerce.number().int().min(0).max(1440).default(60),
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
    // --- SMS (Bangladesh — SSL Wireless) ---
    // BD-tier transactional SMS for OTP, order confirmation,
    // delivery notifications. When any of the three are unset, the
    // sms module no-ops in dev (writes to stdout) and refuses to
    // send in production with a loud warning rather than throwing.
    SSL_WIRELESS_API_KEY: z.string().optional(),
    SSL_WIRELESS_USER: z.string().optional(),
    SSL_WIRELESS_SID: z.string().optional(),
    /**
     * Sender mask sent to SSL Wireless. Defaults to the configured SID,
     * but the merchant can opt for a number-based 'masking' SID once
     * approved by BTRC. 11 chars max for alpha-masking.
     */
    SSL_WIRELESS_DEFAULT_SENDER: z.string().max(20).optional(),
    SSL_WIRELESS_BASE_URL: z.string().url().default('https://smsplus.sslwireless.com'),
    // --- Bangladesh manual payments (bKash / Nagad / bank transfer) ---
    // Surface to merchants on /dashboard/billing as the primary path.
    // Each is optional; missing entries simply hide that payment option.
    PAY_BKASH_NUMBER: z.string().optional(),
    PAY_NAGAD_NUMBER: z.string().optional(),
    /**
     * Free-form bank instructions, e.g. "City Bank, A/C 12345, Routing 678".
     * Surfaced verbatim, so do not embed HTML — it is rendered as plain text.
     */
    PAY_BANK_INFO: z.string().optional(),
    /**
     * Optional override for which bKash/Nagad payment account *type* the
     * merchant should send to (e.g. "Personal" vs "Send Money" vs
     * "Payment"). bKash/Nagad route differently depending on this.
     */
    PAY_BKASH_TYPE: z.string().optional(),
    PAY_NAGAD_TYPE: z.string().optional(),
    // Cap on manual-payment submissions per merchant per 24h. Spam guard.
    PAY_MANUAL_DAILY_CAP: z.coerce.number().int().min(1).max(50).default(3),
    /**
     * Shared secret used to HMAC-sign inbound SMS webhooks AND
     * delivery-report (DLR) webhooks. Required in production — both
     * handlers refuse unsigned/invalid posts. Dev-mode bypasses with a
     * loud warning so localhost testing without a gateway works.
     */
    SMS_WEBHOOK_SHARED_SECRET: z.string().optional(),
    // --- Cross-merchant fraud network ---
    // Master switch — when "0" disables both lookup AND contribution.
    // Useful for emergency-disable (e.g. if a bug is contaminating the
    // global signal store) without redeploying.
    FRAUD_NETWORK_ENABLED: z.enum(["0", "1"]).default("1").transform((v) => v === "1"),
    // Signals older than this many days are treated as stale at lookup
    // time and produce no bonus. Contribution still updates lastSeenAt
    // unconditionally.
    FRAUD_NETWORK_DECAY_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
    // Total network size below which the bonus is damped (×0.5) to
    // prevent false spikes during early rollout.
    FRAUD_NETWORK_WARMING_FLOOR: z.coerce.number().int().min(0).max(100000).default(50),
    // --- Shopify platform-level OAuth app ---
    // When BOTH are set, merchants can connect by entering only their shop
    // domain — the platform's public app credentials are used to drive
    // OAuth. When unset, the legacy custom-app flow remains available
    // (merchant supplies their own apiKey + apiSecret in the Advanced
    // section of the connect dialog).
    SHOPIFY_APP_API_KEY: z.string().optional(),
    SHOPIFY_APP_API_SECRET: z.string().optional(),
    // --- Telemetry (Sentry-compatible) ---
    SENTRY_DSN: z.string().optional(),
    SENTRY_RELEASE: z.string().optional(),
    // --- RTO Engine v1 — observation-only kill switches ---
    /**
     * Master flag for the Address Intelligence v1 stamp + the thana
     * extractor. When "0", `ingestNormalizedOrder` skips both
     * `computeAddressQuality` and `extractThana` — neither is written to
     * the Order. Existing values on already-stamped orders remain visible
     * (we only stop minting new ones).
     *
     * Default ON (additive, observation-only, never affects fraud /
     * automation / tracking decisions). Toggle to "0" for instant rollback
     * of stamping without redeploy.
     */
    ADDRESS_QUALITY_ENABLED: z
      .enum(["0", "1"])
      .default("1")
      .transform((v) => v === "1"),
    /**
     * Master flag for the Intent Intelligence v1 fire-and-forget
     * post-identity-resolution write. When "0", `scoreIntentForOrder` is
     * not invoked. Read-side surfaces (merchant UI) keep showing whatever
     * was previously stamped.
     *
     * Default ON. v1 is observation-only; flag exists for ops kill-switch
     * parity with `ADDRESS_QUALITY_ENABLED`.
     */
    INTENT_SCORING_ENABLED: z
      .enum(["0", "1"])
      .default("1")
      .transform((v) => v === "1"),
    /**
     * Master flag for the Delivery Reliability Intelligence v1 chokepoint
     * fan-out. When "0" (the default), `applyTrackingEvents` does NOT
     * invoke `recordCustomerOutcome` / `recordAddressOutcome`. The new
     * aggregate collections (`customer_reliabilities`,
     * `address_reliabilities`) remain empty and downstream classifier
     * reads degrade to `tier: "no_data"` — the intended cold-start
     * posture.
     *
     * Default OFF. Flip to "1" only after the validation gates in the
     * blueprint §5.5 are satisfied. Independent of the read-side flag
     * (`DELIVERY_RELIABILITY_READ_ENABLED`, S6) so writes can warm up
     * days before merchants see the surface.
     */
    DELIVERY_RELIABILITY_WRITE_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    /**
     * Observability toggle for the Delivery Reliability layer (S5).
     * When "0", `recordReliabilityOutcome` becomes a no-op — no structured
     * log lines, no in-process counter bumps, no Sentry breadcrumbs.
     * Useful as an emergency mute if the log volume turns out to be
     * pathological under load. Default ON: observability is the operational
     * confidence story for a freshly-wired chokepoint fan-out (S4) and
     * should remain visible until the rollout has stabilised.
     */
    DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED: z
      .enum(["0", "1"])
      .default("1")
      .transform((v) => v === "1"),
    /**
     * Read-side surfacing of the Delivery Reliability layer (S6). When "0"
     * (the default), `orders.getOrder` does NOT issue the aggregate
     * lookups and does NOT include the `deliveryReliability` field in
     * its response. Independent of `DELIVERY_RELIABILITY_WRITE_ENABLED`
     * so writes can warm up days before merchants see the surface.
     *
     * Default OFF. Flip to "1" only after the validation gates in the
     * blueprint §5.5 are satisfied (drift detector green for ≥7d in
     * production with the write flag on).
     */
    DELIVERY_RELIABILITY_READ_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    /**
     * Analytics surfacing for the Delivery Reliability layer (S7). When
     * "0" (the default), the four analytics tRPC procedures
     * (`deliveryReliabilitySummary`, `deliveryReliabilityDistribution`,
     * `courierReliabilityOverview`, `reliabilityHealthSnapshot`) refuse
     * with `FORBIDDEN`. Independent of `DELIVERY_RELIABILITY_READ_ENABLED`
     * so analytics can be enabled separately for internal dogfooding.
     *
     * Default OFF.
     */
    DELIVERY_RELIABILITY_ANALYTICS_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    /**
     * Optional comma-separated allowlist of merchant ObjectId hex strings
     * for staged rollout (S9). When non-empty, ALL three Delivery
     * Reliability gates (write / read / analytics) additionally require
     * the merchantId to be in this list — i.e. each gate becomes
     * `flagOn AND merchantInAllowlist`. When empty / unset (the default),
     * the gates behave exactly as before — purely env-flag-driven.
     *
     * Use this to roll the feature to staff merchants first, then a
     * low-volume cohort, before flipping the flag globally with the
     * allowlist cleared.
     *
     * Example: `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=507f1f77bcf86cd799439011,5e8a...`
     */
    DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS: z
      .string()
      .optional()
      .transform((v) => v?.trim() ?? ""),
    /**
     * Phase 2 master flag for the Bangladesh address canonicalisation
     * pipeline. When "0" (the default), `ingestNormalizedOrder` does NOT
     * call `canonicaliseAddress` and `Order.source.canonicalAddress`
     * remains undefined on new orders. The legacy `addressHash` is
     * stamped exactly as before — full ingest stability is preserved
     * regardless of flag state.
     *
     * Default OFF. Flip to "1" after the gazetteer is seeded
     * (`scripts/seedGazetteer.ts`) and the loader has primed
     * (`awaitLoad()` at boot).
     *
     * Replay-safety: this flag controls a pure ADDITIVE write. Existing
     * AddressReliability / FraudSignal aggregates are unaffected on
     * either side of the flip.
     */
    ADDRESS_CANONICALIZATION_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    /**
     * Phase 3 master flag for the courier-lane + area-reliability
     * chokepoint fan-out. When "0" (the default), `applyTrackingEvents`
     * does NOT call `recordCourierLaneOutcome` / `recordAreaOutcome`;
     * the new collections (CourierLane, AreaReliability) remain empty.
     * The legacy CourierPerformance / CustomerReliability /
     * AddressReliability writers continue to fire unchanged on either
     * side of the flip.
     *
     * Default OFF. Flip to "1" once Phase 2 canonicalAddress.thana is
     * landing on new orders in production (i.e. after
     * ADDRESS_CANONICALIZATION_ENABLED=1).
     *
     * Replay-safety: this flag controls a pure ADDITIVE write. Existing
     * aggregates are unaffected on either side of the flip.
     */
    LANE_INTELLIGENCE_WRITE_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    /**
     * Phase 3 master flag for the read-side thana → district → global
     * fallback ladder in `selectBestCourier`. When "0" (the default),
     * the existing district + _GLOBAL_ ladder is preserved exactly.
     * Independent of LANE_INTELLIGENCE_WRITE_ENABLED so writes can
     * accumulate evidence days before the read surface flips on.
     *
     * Default OFF.
     */
    LANE_INTELLIGENCE_READ_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    /**
     * Phase 4A — master flag for the external delivery history
     * intelligence subsystem. When "0" (the default), the orchestrator
     * (`getOrFetchExternalProfile`) returns null immediately; no DB
     * read, no provider fan-out, no cache touch. The
     * ExternalDeliveryProfile collection remains empty.
     *
     * Default OFF. Flip to "1" to enable the substrate; per-provider
     * flags below additionally gate which adapters actually run.
     *
     * Replay-safety: this subsystem is COMPLETELY SEPARATE from the
     * operational chokepoint. Toggling has no impact on any aggregate
     * write path.
     */
    EXTERNAL_DELIVERY_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    /** Default cache TTL in hours. Profile is considered stale after this
     *  window and the orchestrator triggers a fresh provider fan-out. */
    EXTERNAL_DELIVERY_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(168)
      .default(24),
    /** Per-provider call timeout in milliseconds. The orchestrator races
     *  every adapter against this limit; a provider that doesn't return
     *  in time is recorded as a timeout and excluded from the aggregate. */
    EXTERNAL_DELIVERY_PROVIDER_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30_000)
      .default(5000),
    /** Per-provider opt-in flags. Each adapter's isConfigured() returns
     *  false when its flag is "0" — it never participates in the fan-out. */
    EXTERNAL_DELIVERY_PATHAO_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    EXTERNAL_DELIVERY_STEADFAST_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    EXTERNAL_DELIVERY_REDX_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    /**
     * Phase 4A.5 — surface the cross-merchant FraudSignal aggregate as
     * merchant-facing operational evidence on the order detail
     * response. When "0" (the default), `getOrder` does NOT call
     * `lookupNetworkRisk`+`classifyNetworkEvidence` and the
     * `networkEvidence` field is absent from the response.
     *
     * Independent of FRAUD_NETWORK_ENABLED so the cross-merchant
     * lookup can stay on for risk-scoring even while the merchant
     * surface remains hidden. Default OFF.
     *
     * Replay-safety: read-only surface. NEVER writes any aggregate.
     */
    NETWORK_EVIDENCE_SURFACE_ENABLED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
  })
  .refine((e) => e.NODE_ENV !== "production" || !!e.REDIS_URL, {
    message: "REDIS_URL is required when NODE_ENV=production",
    path: ["REDIS_URL"],
  })
  .refine((e) => e.NODE_ENV !== "production" || !!e.ADMIN_SECRET, {
    message: "ADMIN_SECRET is required when NODE_ENV=production",
    path: ["ADMIN_SECRET"],
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
  if (result.data.NODE_ENV === "production") {
    if (!result.data.SMS_WEBHOOK_SHARED_SECRET) {
      console.warn(
        "[env] WARNING: SMS_WEBHOOK_SHARED_SECRET is unset in production — " +
          "inbound SMS + DLR webhooks will refuse all posts. " +
          "Set this to the secret you configured in your SMS gateway portal.",
      );
    }
    const noBdRails =
      !result.data.PAY_BKASH_NUMBER &&
      !result.data.PAY_NAGAD_NUMBER &&
      !result.data.PAY_BANK_INFO;
    if (noBdRails) {
      console.warn(
        "[env] WARNING: no manual-payment rails configured " +
          "(PAY_BKASH_NUMBER / PAY_NAGAD_NUMBER / PAY_BANK_INFO). " +
          "BD merchants will only see Stripe.",
      );
    }
  }
  return result.data;
}

export const env: Env = loadEnv();
