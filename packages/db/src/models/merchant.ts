import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

// Single source of truth for phone number validation. Used by Mongoose
// schemas, tRPC routers, and the auth router. Keep loose enough for
// international numbers; stricter per-country checks live in lib/phone.ts.
export const PHONE_RE = /^\+?[0-9]{7,15}$/;

const COUNTRIES = ["BD", "PK", "IN", "LK", "NP", "ID", "PH", "VN", "MY", "TH"] as const;
const LANGUAGES = ["en", "bn", "ur", "hi", "ta", "id", "th", "vi", "ms"] as const;
const TIERS = ["starter", "growth", "scale", "enterprise"] as const;
/**
 * Subscription lifecycle states.
 *
 *   trial      — initial 14-day evaluation window
 *   active     — paid (manual receipt approved OR Stripe subscription healthy)
 *   past_due   — Stripe invoice failed; merchant has `gracePeriodEndsAt`
 *                to recover before they get cut off
 *   paused     — admin-initiated freeze (back-office workflow)
 *   suspended  — past_due + grace expired; the grace worker flipped here
 *   cancelled  — merchant cancelled (kept access until period end) or Stripe
 *                fired customer.subscription.deleted at the end of the cycle
 */
const SUB_STATUS = [
  "trial",
  "active",
  "past_due",
  "paused",
  "suspended",
  "cancelled",
] as const;

const COURIER_PROVIDERS = ["pathao", "steadfast", "redx", "ecourier", "paperfly", "other"] as const;

const courierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, lowercase: true, enum: COURIER_PROVIDERS },
    accountId: { type: String, required: true, trim: true },
    // Encrypted payload (`v1:iv:tag:ct`) — never returned to the client in plaintext.
    apiKey: { type: String, required: true },
    // Optional second secret (e.g. Pathao client secret / password).
    apiSecret: { type: String },
    baseUrl: { type: String, trim: true },
    preferredDistricts: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    lastValidatedAt: { type: Date },
    validationError: { type: String, trim: true, maxlength: 500 },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

/**
 * Per-merchant fraud tunables. Every field is optional — unset fields fall
 * back to platform defaults from `risk.ts`. Low/high-ticket merchants tune
 * COD thresholds; country-specific flags live in `suspiciousDistricts`;
 * `blockedPhones` / `blockedAddresses` are merchant-curated blacklists that
 * force a `pending_call` review on match.
 */
const fraudConfigSchema = new Schema(
  {
    highCodThreshold: { type: Number, min: 0 },
    extremeCodThreshold: { type: Number, min: 0 },
    suspiciousDistricts: { type: [String], default: [] },
    blockedPhones: { type: [String], default: [] },
    /**
     * Entries are pre-hashed with the same `hashAddress()` fingerprint the
     * scoring path computes so merchants can paste a raw address in the UI
     * and we store only the fingerprint. Raw-form entries are hashed on
     * write via the fraud-config router.
     */
    blockedAddresses: { type: [String], default: [] },
    /** Orders-per-minute velocity ceiling for the same phone. 0 disables. */
    velocityThreshold: { type: Number, min: 0, default: 0 },
    /** Window (minutes) for the velocity + IP-recent signals. */
    velocityWindowMin: { type: Number, min: 1, default: 10 },
    /** Half-life (days) used when decaying historical fraud signals. 0 disables decay. */
    historyHalfLifeDays: { type: Number, min: 0, default: 30 },
    /** Notify the merchant when a pending_call arrives. Defaults to true. */
    alertOnPendingReview: { type: Boolean, default: true },
    /**
     * Per-signal weight overrides written by the monthly weight-tuning
     * worker. Merchant-specific because RTO patterns vary wildly across
     * verticals (high-ticket electronics vs. low-ticket apparel). Stored
     * as a free-form key→multiplier so we can ship new signals without a
     * schema migration. Multiplier is applied to the platform default;
     * `undefined` (or missing key) keeps the default.
     */
    signalWeightOverrides: {
      type: Map,
      of: Number,
      default: undefined,
    },
    /**
     * Anchor for the P(RTO) calibration. Default 0.18 reflects the BD
     * COD market base rate; the tuning worker rewrites this per merchant
     * once they have ≥200 resolved orders (statistical floor).
     */
    baseRtoRate: { type: Number, min: 0, max: 1 },
    /** Stamp set by the tuning worker so the UI can show "Last tuned: …". */
    lastTunedAt: { type: Date },
    /** Version tag of the weights currently in effect. */
    weightsVersion: { type: String, trim: true, maxlength: 60 },
  },
  { _id: false }
);

/**
 * Public-facing branding fields, shown on the customer tracking page
 * (`/track/[code]`). Every field optional — falls back to neutral
 * platform defaults when unset. Display name defaults to businessName.
 * primaryColor must be a 7-char hex string (#rrggbb); the web layer
 * sanitizes anything else so a bad merchant value can never become a
 * CSS injection vector.
 */
const brandingSchema = new Schema(
  {
    displayName: { type: String, trim: true, maxlength: 80 },
    logoUrl: { type: String, trim: true, maxlength: 500 },
    /**
     * Inline base64 logo for the in-app sidebar header and hero. Stored as a
     * `data:image/...;base64,...` URL so we don't need a file server. Capped
     * at 280k chars (~200 KB raw + base64 overhead) — enforced again in the
     * tRPC mutation so we surface a friendly error before Mongoose throws.
     * Distinct from `logoUrl` (which is the public-tracking-page logo) so a
     * merchant can run different art on the customer surface vs the admin.
     */
    logoDataUrl: {
      type: String,
      maxlength: 280_000,
      validate: {
        validator: (v: string) => !v || /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,/.test(v),
        message: "logoDataUrl must be a data:image/* base64 URL",
      },
    },
    primaryColor: {
      type: String,
      trim: true,
      maxlength: 7,
      validate: {
        validator: (v: string) => !v || /^#[0-9a-fA-F]{6}$/.test(v),
        message: "primaryColor must be a 6-digit hex like #112233",
      },
    },
    supportPhone: {
      type: String,
      trim: true,
      maxlength: 20,
      validate: { validator: (v: string) => !v || PHONE_RE.test(v), message: "Invalid phone" },
    },
    supportEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
  },
  { _id: false },
);

export interface MerchantBranding {
  displayName?: string;
  logoUrl?: string;
  logoDataUrl?: string;
  primaryColor?: string;
  supportPhone?: string;
  supportEmail?: string;
}

export const AUTOMATION_MODES = ["manual", "semi_auto", "full_auto"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

/**
 * Per-merchant automation policy for newly created orders.
 *
 *   manual     — every order goes to pending_confirmation; merchant
 *                clicks Confirm or Reject. (Default — safest.)
 *   semi_auto  — low-risk orders auto-confirm; medium/high go to
 *                pending_confirmation; auto-book is OFF by default.
 *   full_auto  — low-risk orders auto-confirm AND auto-book through
 *                the merchant's preferred courier. Medium goes to
 *                pending_confirmation; high always requires_review.
 *
 * `maxRiskForAutoConfirm` is the riskScore ceiling under full_auto.
 * Orders scored above this number bypass auto-confirm regardless of
 * level — useful for merchants who want full_auto only on very-low
 * risk while keeping their threshold tighter than 39.
 */
const automationConfigSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    mode: { type: String, enum: AUTOMATION_MODES, default: "manual" },
    /** Hard cap on the risk score under which auto-confirm fires (0..100). */
    maxRiskForAutoConfirm: { type: Number, min: 0, max: 100, default: 39 },
    /** When true, auto-confirmed orders also get auto-booked. */
    autoBookEnabled: { type: Boolean, default: false },
    /** Preferred courier for auto-book when multiple are configured. */
    autoBookCourier: { type: String, trim: true, lowercase: true, maxlength: 60 },
  },
  { _id: false },
);

export interface MerchantAutomationConfig {
  enabled?: boolean;
  mode?: AutomationMode;
  maxRiskForAutoConfirm?: number;
  autoBookEnabled?: boolean;
  autoBookCourier?: string;
}
const subscriptionSchema = new Schema(
  {
    tier: { type: String, enum: TIERS, default: "starter" },
    rate: { type: Number, min: 0, default: 999 },
    startDate: { type: Date, default: () => new Date() },
    trialEndsAt: { type: Date },
    /** End of the current paid cycle; when it passes we flip status → past_due. */
    currentPeriodEnd: { type: Date },
    /** Team-seat override — if null we fall back to the plan default in plans.ts. */
    seatsOverride: { type: Number, min: 0 },
    status: { type: String, enum: SUB_STATUS, default: "trial" },
    activatedAt: { type: Date },
    activatedBy: { type: String, trim: true },
    notes: { type: String, trim: true, maxlength: 500 },
    /** Provisional flag lit while a pending payment submission is awaiting admin approval. */
    pendingPaymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
    /**
     * Set when Stripe fires `invoice.payment_failed`. The grace worker
     * flips status to `suspended` once `Date.now() > gracePeriodEndsAt`.
     * Cleared on a successful subsequent invoice (recovery path).
     */
    gracePeriodEndsAt: { type: Date },
    /**
     * "manual" = bKash/Nagad/bank receipt or one-shot Stripe Checkout
     *            (legacy `mode=payment`). Renewal is admin-driven.
     * "stripe_subscription" = recurring Stripe Subscription. Renewal is
     *            automatic via invoice.payment_succeeded webhooks.
     * Future: "card_pos", "wire", etc.
     */
    billingProvider: {
      type: String,
      enum: ["manual", "stripe_subscription"],
      default: "manual",
    },
  },
  { _id: false }
);

/**
 * Single-use tokens we hash before storing. The plaintext is delivered to the
 * merchant via email and never persisted; on consumption the API hashes the
 * incoming token and compares against `hash`. Expiry + `consumedAt` keep the
 * token strictly single-use.
 */
const tokenSchema = new Schema(
  {
    /** SHA-256 of the plaintext token (hex). */
    hash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    requestedAt: { type: Date, default: () => new Date() },
    requestedFromIp: { type: String, trim: true, maxlength: 64 },
    consumedAt: { type: Date },
  },
  { _id: false }
);

const merchantSchema = new Schema(
  {
    businessName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    phone: {
      type: String,
      trim: true,
      validate: {
        validator: (v: string) => !v || PHONE_RE.test(v),
        message: "Invalid phone number",
      },
    },
    country: { type: String, enum: COUNTRIES, default: "BD" },
    language: { type: String, enum: LANGUAGES, default: "en" },
    role: { type: String, enum: ["merchant", "admin", "agent"], default: "merchant" },
    /**
     * Admin RBAC scopes. Empty for non-admin users. An admin without any
     * scope can read but cannot mutate. Scopes are additive; super_admin
     * implies all others.
     *   - super_admin    : full power, including granting/revoking other admins
     *   - finance_admin  : payment approval / refund / plan changes
     *   - support_admin  : merchant suspension / unsuspension, fraud override
     */
    adminScopes: {
      type: [String],
      enum: ["super_admin", "finance_admin", "support_admin"],
      default: [],
    },
    /**
     * Per-admin alert delivery preferences — drives lib/admin-alerts.ts
     * fan-out from `alert.fired` audit rows. Each severity has independent
     * email + sms toggles; in-app is always on so an admin can never miss
     * an alert because they tuned themselves out of every channel.
     *
     * Defaults (mirrored in `DEFAULT_ADMIN_ALERT_PREFS`):
     *   info     — inApp only
     *   warning  — inApp + email
     *   critical — inApp + email + sms
     *
     * Defaults only apply when the field is unset. An admin who explicitly
     * disables every channel still receives in-app rows.
     */
    adminAlertPrefs: {
      type: new Schema(
        {
          info: {
            email: { type: Boolean, default: false },
            sms: { type: Boolean, default: false },
          },
          warning: {
            email: { type: Boolean, default: true },
            sms: { type: Boolean, default: false },
          },
          critical: {
            email: { type: Boolean, default: true },
            sms: { type: Boolean, default: true },
          },
        },
        { _id: false },
      ),
      default: undefined,
    },
    subscription: { type: subscriptionSchema, default: () => ({}) },
    couriers: { type: [courierSchema], default: [] },
    fraudConfig: { type: fraudConfigSchema, default: () => ({}) },
    branding: { type: brandingSchema, default: () => ({}) },
    automationConfig: { type: automationConfigSchema, default: () => ({}) },
    /**
     * Public tracking key embedded in the JS SDK on the merchant's storefront.
     * Resolves to merchantId server-side at the collector boundary. Safe to
     * expose — it can only write events for this merchant, never read.
     * Auto-generated on first /track request that needs it.
     */
    trackingKey: { type: String, unique: true, sparse: true, trim: true, maxlength: 64 },
    /**
     * Optional shared secret for HMAC-signed collector events. When set, the
     * SDK signs every batch as `HMAC-SHA256(secret, timestamp + "." + body)`
     * and the collector verifies before accepting. Unsigned batches still
     * pass when the secret is unset (backward compat); once a merchant
     * rotates the secret on, signature verification becomes mandatory for
     * any subsequent unsigned batches via the strictHmac flag.
     */
    trackingSecret: { type: String, trim: true, maxlength: 128 },
    /** When true, the collector REJECTS any batch missing/invalid HMAC. */
    trackingStrictHmac: { type: Boolean, default: false },
    /**
     * Stripe customer record. Created once on the first subscription checkout
     * and reused for every later billing operation (subsequent checkouts,
     * portal sessions, webhook lookups). Sparse-unique so legacy merchants
     * without a Stripe profile don't trip the index.
     */
    stripeCustomerId: { type: String, trim: true, maxlength: 80 },
    /** The merchant's most recent Stripe Subscription id (sub_…). */
    stripeSubscriptionId: { type: String, trim: true, maxlength: 80 },
    emailVerified: { type: Boolean, default: false },
    emailVerification: { type: tokenSchema, default: undefined },
    passwordReset: { type: tokenSchema, default: undefined },
    /** Tracks one-shot transactional notifications so we don't re-fire them. */
    notificationsSent: {
      type: new Schema(
        {
          trialEndingAt: { type: Date },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { timestamps: true }
);

merchantSchema.index({ country: 1, createdAt: -1 });
merchantSchema.index({ "subscription.status": 1 });
merchantSchema.index({ "subscription.status": 1, "subscription.trialEndsAt": 1 });
// Sparse-unique on Stripe identifiers so legacy merchants (null) don't
// collide and we can look up by id from a webhook in O(1).
merchantSchema.index(
  { stripeCustomerId: 1 },
  { unique: true, partialFilterExpression: { stripeCustomerId: { $type: "string" } } },
);
merchantSchema.index(
  { stripeSubscriptionId: 1 },
  { unique: true, partialFilterExpression: { stripeSubscriptionId: { $type: "string" } } },
);
// Grace-expiry sweep — partial so we only scan rows that actually have a
// grace deadline pending.
merchantSchema.index(
  { "subscription.status": 1, "subscription.gracePeriodEndsAt": 1 },
  {
    partialFilterExpression: {
      "subscription.gracePeriodEndsAt": { $type: "date" },
    },
  },
);

export type Merchant = InferSchemaType<typeof merchantSchema> & { _id: Types.ObjectId };

/**
 * Explicit fraud-config view used by consumers that load the merchant via
 * `.lean()`. We publish a stable interface here so callers don't have to
 * contend with Mongoose's partial inference of optional subdocs (fields are
 * nullable at rest but surface as `undefined` once the null is coalesced).
 */
export interface MerchantFraudConfig {
  highCodThreshold?: number;
  extremeCodThreshold?: number;
  suspiciousDistricts?: string[];
  blockedPhones?: string[];
  blockedAddresses?: string[];
  velocityThreshold?: number;
  velocityWindowMin?: number;
  historyHalfLifeDays?: number;
  alertOnPendingReview?: boolean;
  signalWeightOverrides?: Map<string, number> | Record<string, number>;
  baseRtoRate?: number;
  lastTunedAt?: Date;
  weightsVersion?: string;
}

export const Merchant: Model<Merchant> =
  (models.Merchant as Model<Merchant>) || model<Merchant>("Merchant", merchantSchema);

export const MERCHANT_COUNTRIES = COUNTRIES;
export const MERCHANT_LANGUAGES = LANGUAGES;

// Re-export the courier-provider enum so API routers can build zod
// `z.enum(...)` validators without re-declaring the union.
export const COURIER_PROVIDER_NAMES = COURIER_PROVIDERS;
export type CourierProvider = (typeof COURIER_PROVIDERS)[number];

export type AdminAlertSeverity = "info" | "warning" | "critical";

export interface AdminAlertPrefs {
  info: { email: boolean; sms: boolean };
  warning: { email: boolean; sms: boolean };
  critical: { email: boolean; sms: boolean };
}

/**
 * Source-of-truth defaults consumed by lib/admin-alerts.ts when an admin
 * has no explicit preferences set. Mirrors the Mongoose schema defaults
 * but lives here so the API layer doesn't have to round-trip the schema
 * to know what an "unconfigured" admin should receive.
 */
export const DEFAULT_ADMIN_ALERT_PREFS: AdminAlertPrefs = {
  info: { email: false, sms: false },
  warning: { email: true, sms: false },
  critical: { email: true, sms: true },
};

// Re-export subscription-tier enum for admin/billing surfaces that need a
// stable list of valid tiers.
export const SUBSCRIPTION_TIERS = TIERS;
export type SubscriptionTier = (typeof TIERS)[number];
export const SUBSCRIPTION_STATUSES = SUB_STATUS;
export type SubscriptionStatus = (typeof SUB_STATUS)[number];
