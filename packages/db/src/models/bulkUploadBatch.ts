import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * One row per CSV upload attempt. The `(merchantId, externalBatchId)`
 * unique index is the anti-replay guard — re-submitting the same batch
 * collides on insert and the bulkUpload procedure rejects with a clear
 * "this batch was already uploaded" error rather than silently
 * re-creating orders.
 *
 * `externalBatchId` is supplied by the caller (web client generates a
 * UUID per dialog open + CSV-content hash, so a paste-then-tweak still
 * produces a fresh id).
 */

export const BULK_UPLOAD_BATCH_STATUSES = [
  "processing",
  "completed",
  "failed",
  "review_pending",
] as const;
export type BulkUploadBatchStatus = (typeof BULK_UPLOAD_BATCH_STATUSES)[number];

export const BULK_UPLOAD_MODES = ["skip", "replace", "review"] as const;
export type BulkUploadMode = (typeof BULK_UPLOAD_MODES)[number];

const bulkUploadBatchSchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    externalBatchId: { type: String, required: true, trim: true, maxlength: 128 },
    source: { type: String, trim: true, maxlength: 60 },
    /** Client-supplied wall-clock at submission time. Server rejects if drift > MAX. */
    uploadedAt: { type: Date, required: true },
    mode: { type: String, enum: BULK_UPLOAD_MODES, required: true },
    status: {
      type: String,
      enum: BULK_UPLOAD_BATCH_STATUSES,
      default: "processing",
      required: true,
    },
    rowsParsed: { type: Number, default: 0 },
    rowsInserted: { type: Number, default: 0 },
    rowsReplaced: { type: Number, default: 0 },
    rowsDuplicatesSkipped: { type: Number, default: 0 },
    rowsErrors: { type: Number, default: 0 },
    completedAt: { type: Date },
    /** Captured for audit / abuse triage. */
    ip: { type: String, trim: true, maxlength: 64 },
    userAgent: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

bulkUploadBatchSchema.index(
  { merchantId: 1, externalBatchId: 1 },
  { unique: true },
);
bulkUploadBatchSchema.index({ merchantId: 1, createdAt: -1 });

export type BulkUploadBatch = InferSchemaType<typeof bulkUploadBatchSchema> & {
  _id: Types.ObjectId;
};

export const BulkUploadBatch: Model<BulkUploadBatch> =
  (models.BulkUploadBatch as Model<BulkUploadBatch>) ||
  model<BulkUploadBatch>("BulkUploadBatch", bulkUploadBatchSchema);
