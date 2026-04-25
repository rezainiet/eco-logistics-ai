import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Async commerce-import job. Lives separate from `WebhookInbox` because an
 * import is a unit of work the merchant initiates (vs. a delivery the
 * platform pushes), and its progress is what the dashboard polls during the
 * spinner.
 */
export const IMPORT_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

const importJobSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    integrationId: { type: Schema.Types.ObjectId, ref: "Integration", required: true, index: true },
    provider: { type: String, required: true, trim: true, maxlength: 60 },
    status: {
      type: String,
      enum: IMPORT_JOB_STATUSES,
      default: "queued",
      index: true,
    },
    /** Total upstream orders the job intends to process (set after first fetch). */
    totalRows: { type: Number, default: 0 },
    /** Rows the worker has already attempted (success + duplicate + failure). */
    processedRows: { type: Number, default: 0 },
    importedRows: { type: Number, default: 0 },
    duplicateRows: { type: Number, default: 0 },
    failedRows: { type: Number, default: 0 },
    /** First/last error string captured during the run. */
    lastError: { type: String, trim: true, maxlength: 500 },
    /** Optional caller-provided cap on how many orders to pull. */
    requestedLimit: { type: Number, default: 0 },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    triggeredBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

importJobSchema.index({ merchantId: 1, createdAt: -1 });
importJobSchema.index({ integrationId: 1, status: 1, createdAt: -1 });

export type ImportJob = InferSchemaType<typeof importJobSchema> & {
  _id: Types.ObjectId;
};

export const ImportJob: Model<ImportJob> =
  (models.ImportJob as Model<ImportJob>) ||
  model<ImportJob>("ImportJob", importJobSchema);
