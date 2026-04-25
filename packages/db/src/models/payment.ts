import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Manual-payment receipts for Bangladesh (bKash / Nagad / bank transfer).
 *
 * Flow:
 *  1. Merchant submits a receipt via billing.submitPayment.
 *  2. Admin approves via admin.approvePayment → we flip subscription to active
 *     and bump currentPeriodEnd by ~30 days.
 *  3. Admin can reject with a note; merchant sees it in the billing history.
 *
 * Architecture-wise the shape is Stripe/Paddle-ready — a future automated
 * gateway lands as a new `method` value and an `externalChargeId`.
 */

export const PAYMENT_METHODS = ["bkash", "nagad", "bank_transfer", "card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["pending", "approved", "rejected", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_PROVIDERS = ["manual", "stripe"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

const PLAN_TIERS = ["starter", "growth", "scale", "enterprise"] as const;

/**
 * Inline file payload for proof-of-payment uploads. Stored on the Payment
 * doc itself (capped at 2MB on the API) — keeps the deployment surface
 * small (no S3 yet) and lets admins eyeball receipts in one click. Larger
 * footprints can migrate to object storage later by swapping the read path.
 */
const proofFileSchema = new Schema(
  {
    contentType: { type: String, required: true, trim: true, maxlength: 100 },
    sizeBytes: { type: Number, required: true, min: 0, max: 4_000_000 },
    /** Original filename hint, capped — only used for the download header. */
    filename: { type: String, trim: true, maxlength: 200 },
    /** Base64-encoded body. We hand this back as a data URL on read. */
    data: { type: String, required: true },
    uploadedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    /** The plan tier the merchant wants to pay for / upgrade to. */
    plan: { type: String, enum: PLAN_TIERS, required: true },
    /** Amount the merchant claims to have paid, in BDT. */
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "BDT", trim: true, uppercase: true, maxlength: 8 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    /** bKash / Nagad / bank txn id the merchant provides. */
    txnId: { type: String, trim: true, maxlength: 200 },
    /** Merchant-supplied sender phone (bKash sender number, etc). */
    senderPhone: { type: String, trim: true, maxlength: 32 },
    /** Optional uploaded screenshot / receipt URL (legacy: external URL only). */
    proofUrl: { type: String, trim: true, maxlength: 1000 },
    /** Inline upload — supersedes proofUrl when both are present. */
    proofFile: { type: proofFileSchema, default: undefined },
    notes: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: PAYMENT_STATUSES, default: "pending", index: true },
    /** "manual" = bKash/Nagad/Bank receipts; "stripe" = automated card charge. */
    provider: { type: String, enum: PAYMENT_PROVIDERS, default: "manual", index: true },
    /** Stripe Checkout Session id (cs_…) — set when we mint the session. */
    providerSessionId: { type: String, trim: true, maxlength: 200 },
    /** Stripe payment_intent id from the webhook event. */
    providerChargeId: { type: String, trim: true, maxlength: 200 },
    /** Idempotency key from the webhook event id (evt_…). */
    providerEventId: { type: String, trim: true, maxlength: 200 },
    /** Stripe Subscription id (sub_…) when this payment is part of a recurring cycle. */
    subscriptionId: { type: String, trim: true, maxlength: 200 },
    /**
     * Stripe Invoice id (in_…). One Invoice = one Payment row. The
     * sparse-unique index defined below dedupes invoice.payment_succeeded
     * retries.
     */
    invoiceId: { type: String, trim: true, maxlength: 200 },
    reviewerId: { type: Schema.Types.ObjectId, ref: "Merchant" },
    reviewerNote: { type: String, trim: true, maxlength: 1000 },
    reviewedAt: { type: Date },
    /** Period the payment covers — mirrored onto subscription.currentPeriodEnd on approval. */
    periodStart: { type: Date },
    periodEnd: { type: Date },
  },
  { timestamps: true },
);

paymentSchema.index(
  { providerSessionId: 1 },
  { unique: true, partialFilterExpression: { providerSessionId: { $type: "string" } } },
);
paymentSchema.index(
  { providerEventId: 1 },
  { unique: true, partialFilterExpression: { providerEventId: { $type: "string" } } },
);
// One Payment row per Stripe Invoice — duplicate `invoice.payment_succeeded`
// deliveries land back on the same row instead of creating a second receipt.
paymentSchema.index(
  { invoiceId: 1 },
  { unique: true, partialFilterExpression: { invoiceId: { $type: "string" } } },
);
paymentSchema.index({ merchantId: 1, subscriptionId: 1, createdAt: -1 });

paymentSchema.index({ merchantId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });

export type Payment = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId };

export const Payment: Model<Payment> =
  (models.Payment as Model<Payment>) || model<Payment>("Payment", paymentSchema);
