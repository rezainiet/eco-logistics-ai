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

const PLAN_TIERS = ["starter", "growth", "scale", "enterprise"] as const;

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
    /** Optional uploaded screenshot / receipt URL — we accept URL now; file upload comes later. */
    proofUrl: { type: String, trim: true, maxlength: 1000 },
    notes: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: PAYMENT_STATUSES, default: "pending", index: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: "Merchant" },
    reviewerNote: { type: String, trim: true, maxlength: 1000 },
    reviewedAt: { type: Date },
    /** Period the payment covers — mirrored onto subscription.currentPeriodEnd on approval. */
    periodStart: { type: Date },
    periodEnd: { type: Date },
  },
  { timestamps: true },
);

paymentSchema.index({ merchantId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });

export type Payment = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId };

export const Payment: Model<Payment> =
  (models.Payment as Model<Payment>) || model<Payment>("Payment", paymentSchema);
