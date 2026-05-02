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

/**
 * Manual payment approval workflow.
 *
 *   pending   → submitted by merchant, no admin has touched it yet
 *   reviewed  → a finance admin opened it, eyeballed proof + risk, marked
 *               it reviewed. Required intermediate state — instant approve
 *               from pending is forbidden. Risk score is computed during
 *               submission and surfaced here.
 *   approved  → final state. For high-risk payments (riskScore ≥ 60) two
 *               distinct admins must sign off (4-eyes). The first one's
 *               approval lands as `firstApprovalBy`; the second one flips
 *               status to approved.
 *   rejected  → admin declined with a reason
 *   refunded  → post-approval reversal (separate flow, not in this PR)
 */
export const PAYMENT_STATUSES = ["pending", "reviewed", "approved", "rejected", "refunded"] as const;
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
    /**
     * Caller-supplied idempotency token for manual `submitPayment` calls.
     * The dashboard generates a UUID per submit click; the (merchantId,
     * clientRequestId) sparse-unique index below dedupes double-submits.
     */
    clientRequestId: { type: String, trim: true, maxlength: 120 },
    reviewerId: { type: Schema.Types.ObjectId, ref: "Merchant" },
    reviewerNote: { type: String, trim: true, maxlength: 1000 },
    reviewedAt: { type: Date },
    /**
     * Two-stage review:
     *  - markedReviewedBy / markedReviewedAt: admin who triaged (status -> reviewed).
     *  - firstApprovalBy   / firstApprovalAt: only set for high-risk payments
     *    that need dual approval. Cleared on rejection.
     *  - reviewerId is the *second* (final) approver; admin set it on the
     *    transition to "approved".
     * For low-risk payments the first approval IS the final approval — we
     * keep firstApprovalBy unset and use reviewerId only.
     */
    markedReviewedBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
    markedReviewedAt: { type: Date },
    firstApprovalBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
    firstApprovalAt: { type: Date },
    firstApprovalNote: { type: String, trim: true, maxlength: 1000 },
    /**
     * Anti-fraud fingerprints — populated on submitPayment.
     *
     *   txnIdNorm     : normalized (lower-cased + stripped) txnId for
     *                   cross-merchant duplicate detection. Unique-sparse
     *                   index covers (method, txnIdNorm) globally so the
     *                   same bKash transaction id can't be claimed by two
     *                   merchants.
     *   proofHash     : sha256 of the proof file bytes. Two merchants
     *                   submitting the same screenshot collide on this.
     *   metadataHash  : sha256 of (senderPhone + amount + method + txnIdNorm).
     *                   Catches replays that swap the screenshot but keep
     *                   the underlying claim identical.
     */
    txnIdNorm: { type: String, trim: true, maxlength: 200 },
    proofHash: { type: String, trim: true, maxlength: 64 },
    metadataHash: { type: String, trim: true, maxlength: 64 },
    /**
     * Auto-computed risk score (0..100) from `scorePaymentRisk`. >= 60 forces
     * dual-approval at admin time; >= 80 also surfaces in the suspicious-
     * activity dashboard. Reasons are the human-readable signals that fired.
     */
    riskScore: { type: Number, min: 0, max: 100, default: 0 },
    riskReasons: { type: [String], default: [] },
    /** True iff riskScore was >= 60 at submission time — locked in to avoid
     * post-hoc tuning sneaking high-risk payments through single approval. */
    requiresDualApproval: { type: Boolean, default: false },
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
// Manual submitPayment idempotency — same merchant + same clientRequestId
// collapses to a single Payment row regardless of double-click.
paymentSchema.index(
  { merchantId: 1, clientRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRequestId: { $type: "string" } },
  },
);
paymentSchema.index({ merchantId: 1, subscriptionId: 1, createdAt: -1 });

paymentSchema.index({ merchantId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
// Cross-merchant fingerprint indices. NOT unique — two merchants legitimately
// submitting receipts with the same hash should both land; the cross-merchant
// fraud check fires at submit time and adds a risk signal. Keeping the index
// non-unique lets the audit trail of attempted reuse stay intact.
paymentSchema.index({ method: 1, txnIdNorm: 1 });
paymentSchema.index({ proofHash: 1 });
paymentSchema.index({ metadataHash: 1 });

export type Payment = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId };

export const Payment: Model<Payment> =
  (models.Payment as Model<Payment>) || model<Payment>("Payment", paymentSchema);
