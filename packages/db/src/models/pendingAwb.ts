import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Pending-AWB ledger. Every courier-booking attempt stamps a row here
 * BEFORE the upstream API call. The row is flipped to `succeeded` after
 * the AWB is persisted on the order, or `failed` on a deterministic error.
 * Rows that stay `pending` past the stale-lock threshold are reconciled
 * by the `awbReconcile` worker.
 *
 * Idempotency key = sha256(orderId + ":" + attempt). Surfaced on the
 * upstream call as `Idempotency-Key`; same key on retry → same AWB at
 * the courier (where the courier honours the header).
 */

export const PENDING_AWB_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  // Upstream call returned but DB write didn't land — we may have an
  // orphan AWB at the courier. Surfaced to ops via alerting.
  "orphaned",
  // Reconciler gave up after exhausting probe attempts; manual review.
  "abandoned",
] as const;
export type PendingAwbStatus = (typeof PENDING_AWB_STATUSES)[number];

const pendingAwbSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    courier: { type: String, required: true, trim: true, maxlength: 60 },
    attempt: { type: Number, required: true, min: 1 },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 128 },
    status: {
      type: String,
      enum: PENDING_AWB_STATUSES,
      default: "pending",
      required: true,
    },
    requestedAt: { type: Date, default: () => new Date() },
    completedAt: { type: Date },
    trackingNumber: { type: String, trim: true, maxlength: 128 },
    providerOrderId: { type: String, trim: true, maxlength: 128 },
    lastError: { type: String, trim: true, maxlength: 500 },
    reconcileAttempts: { type: Number, default: 0 },
    reconciledAt: { type: Date },
  },
  { timestamps: true },
);

// Idempotency: same (order, attempt) pair can never appear twice. A retry
// always increments `attempt` so it gets a fresh row + fresh upstream key.
pendingAwbSchema.index({ orderId: 1, attempt: 1 }, { unique: true });
// Reconciler pickup — pending rows older than the stale threshold, oldest first.
pendingAwbSchema.index({ status: 1, requestedAt: 1 });
// Operator/audit query — recent booking attempts per merchant.
pendingAwbSchema.index({ merchantId: 1, createdAt: -1 });

export type PendingAwb = InferSchemaType<typeof pendingAwbSchema> & {
  _id: Types.ObjectId;
};

export const PendingAwb: Model<PendingAwb> =
  (models.PendingAwb as Model<PendingAwb>) ||
  model<PendingAwb>("PendingAwb", pendingAwbSchema);
