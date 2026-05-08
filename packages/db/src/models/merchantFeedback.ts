import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Lightweight merchant-feedback collection — design-partner phase only.
 *
 * Captures one row per "send feedback" submission from the dashboard so
 * internal ops can triage real-world friction without building a CRM.
 * Fields are bounded (single string body, capped length, no attachments)
 * — the DB is the operational paper trail; deeper triage moves to
 * Slack/email at human discretion.
 *
 * Append-only at the application layer (no edits expected from the
 * merchant side). Internal ops can update `status` / `internalNotes` /
 * `triagedAt` via the admin router only.
 */

export const FEEDBACK_KINDS = [
  "onboarding",      // anything during /dashboard/getting-started
  "integration",     // Shopify / Woo / custom-API connect or sync issues
  "support",         // "I need help with X" — broad ticket-style entry
  "bug",             // "this looks broken" — distinct from feature-gap
  "feature_request", // explicit ask
  "general",         // everything else
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_SEVERITIES = ["info", "warning", "blocker"] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

export const FEEDBACK_STATUSES = [
  "new",        // freshly submitted; nobody has seen it yet
  "triaged",    // ops has read + categorised; awaiting follow-up
  "resolved",   // closed-loop with merchant
  "dismissed",  // not actionable / spam / duplicate
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

const merchantFeedbackSchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    /** Email at submit time — preserved verbatim even if the user is
     *  later deleted. */
    actorEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    kind: { type: String, enum: FEEDBACK_KINDS, required: true },
    severity: {
      type: String,
      enum: FEEDBACK_SEVERITIES,
      default: "info",
      index: true,
    },
    /** Free-form body. Capped to keep rows small. */
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    /** Page slug where feedback was submitted from (e.g.
     *  "/dashboard/orders"). Helps ops see where merchants get stuck. */
    pagePath: { type: String, trim: true, maxlength: 200 },
    userAgent: { type: String, trim: true, maxlength: 500 },
    status: {
      type: String,
      enum: FEEDBACK_STATUSES,
      default: "new",
      index: true,
    },
    /** Triage notes from internal ops. Capped. */
    internalNotes: { type: String, trim: true, maxlength: 2000 },
    triagedAt: { type: Date },
    triagedBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
    resolvedAt: { type: Date },
  },
  { timestamps: true },
);

merchantFeedbackSchema.index({ merchantId: 1, createdAt: -1 });
merchantFeedbackSchema.index({ status: 1, createdAt: -1 });
merchantFeedbackSchema.index({ kind: 1, createdAt: -1 });

export type MerchantFeedback = InferSchemaType<typeof merchantFeedbackSchema> & {
  _id: Types.ObjectId;
};

export const MerchantFeedback: Model<MerchantFeedback> =
  (models.MerchantFeedback as Model<MerchantFeedback>) ||
  model<MerchantFeedback>("MerchantFeedback", merchantFeedbackSchema);
