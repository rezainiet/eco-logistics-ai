import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

const PHONE_RE = /^\+?[0-9]{7,15}$/;

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
  },
  { _id: false }
);

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
    subscription: { type: subscriptionSchema, default: () => ({}) },
    couriers: { type: [courierSchema], default: [] },
    fraudConfig: { type: fraudConfigSchema, default: () => ({}) },
    /**
     * Public tracking key embedded in the JS SDK on the merchant's storefront.
     * Resolves to merchantId server-side at the collector boundary. Safe to
     * expose — it can only write events for this merchant, never read.
     * Auto-generated on first /track request that needs it.
     */
    trackingKey: { type: String, unique: true, sparse: true, trim: true, maxlength: 64 },
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
}

export const Merchant: Model<Merchant> =
  (models.Merchant as Model<Merchant>) || model<Merchant>("Merchant", merchantSchema);

export const MERCHANT_COUNTRIES = COUNTRIES;
export const MERCHANT_LANGUAGES = LANGUAGES;
export const SUBSCRIPTION_TIERS = TIERS;
export const SUBSCRIPTION_STATUSES = SUB_STATUS;
export const COURIER_PROVIDER_NAMES = COURIER_PROVIDERS;
export type CourierProvider = (typeof COURIER_PROVIDERS)[number];
