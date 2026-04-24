import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

export const AUDIT_ACTIONS = [
  "risk.scored",
  "risk.recomputed",
  "risk.alerted",
  "review.verified",
  "review.rejected",
  "review.no_answer",
  "review.reopened",
  "order.booked",
  "order.cancelled",
  "courier.configured",
  "fraud.config_updated",
  "payment.submitted",
  "payment.approved",
  "payment.rejected",
  "subscription.activated",
  "subscription.cancelled",
  "subscription.extended",
  "subscription.plan_changed",
] as const;

export const AUDIT_SUBJECT_TYPES = ["order", "merchant", "courier", "call", "payment"] as const;

const auditLogSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: "Merchant" },
    actorType: { type: String, enum: ["merchant", "agent", "admin", "system"], default: "merchant" },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    subjectType: { type: String, enum: AUDIT_SUBJECT_TYPES, required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    meta: { type: Schema.Types.Mixed },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);

auditLogSchema.index({ merchantId: 1, at: -1 });
auditLogSchema.index({ merchantId: 1, subjectType: 1, subjectId: 1, at: -1 });
auditLogSchema.index({ merchantId: 1, action: 1, at: -1 });

export type AuditLog = InferSchemaType<typeof auditLogSchema> & { _id: Types.ObjectId };

export const AuditLog: Model<AuditLog> =
  (models.AuditLog as Model<AuditLog>) || model<AuditLog>("AuditLog", auditLogSchema);
