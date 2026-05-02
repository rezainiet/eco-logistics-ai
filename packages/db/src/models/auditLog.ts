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
  "order.ingested",
  "courier.configured",
  "fraud.config_updated",
  "automation.confirmed",
  "automation.rejected",
  "automation.bulk_confirmed",
  "automation.bulk_rejected",
  "automation.auto_expired",
  "automation.escalated_no_reply",
  "automation.auto_booked",
  "automation.auto_book_failed",
  "automation.confirmation_sms_failed",
  "automation.confirmation_sms_delivered",
  "automation.confirmation_sms_undelivered",
  "automation.watchdog_exhausted",
  "automation.watchdog_reenqueued",
  "automation.config_updated",
  "automation.sms_confirm",
  "automation.sms_reject",
  "automation.restored",
  "payment.submitted",
  "payment.reviewed",
  "payment.first_approval",
  "payment.approved",
  "payment.rejected",
  "payment.flagged",
  "payment.checkout_started",
  "payment.checkout_completed",
  "payment.proof_uploaded",
  "subscription.checkout_started",
  "subscription.recurring_started",
  "subscription.synced",
  "subscription.payment_recovered",
  "subscription.payment_failed",
  "subscription.suspended",
  "subscription.activated",
  "subscription.cancelled",
  "subscription.extended",
  "subscription.plan_changed",
  "integration.connected",
  "integration.disconnected",
  "integration.test",
  "integration.webhook",
  "integration.webhook_replayed",
  "integration.webhook_dead_lettered",
  "integration.webhook_secret_rotated",
  "integration.secret_revealed",
  "integration.shopify_oauth",
  "tracking.identified",
  "auth.reset_requested",
  "auth.password_reset",
  "auth.password_changed",
  "auth.email_verified",
  "auth.logout_all",
  "merchant.test_sms_sent",
  "awb.reconcile.orphaned",
  "awb.reconcile.abandoned",
  "automation.queue_rebuilt",
  "automation.worker_skipped",
  // --- Admin RBAC + governance ---
  "admin.role_granted",
  "admin.role_revoked",
  "admin.scope_granted",
  "admin.scope_revoked",
  "admin.stepup_issued",
  "admin.stepup_consumed",
  "admin.stepup_failed",
  "admin.merchant_suspended",
  "admin.merchant_unsuspended",
  "admin.fraud_override",
  "admin.unauthorized_attempt",
  // --- Anomaly engine ---
  "alert.fired",
] as const;

export const AUDIT_SUBJECT_TYPES = [
  "order",
  "merchant",
  "courier",
  "call",
  "payment",
  "integration",
  "session",
  "pending_awb",
  "admin",
  "system",
] as const;

const auditLogSchema = new Schema(
  {
    /**
     * The merchant the audit entry concerns. Optional for system/admin-level
     * events that don't tie back to a single merchant (e.g. "alert.fired"
     * for a global webhook-failure spike).
     */
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", index: true },
    actorId: { type: Schema.Types.ObjectId, ref: "Merchant" },
    /** Email of the actor at write time — preserved even if the user is later deleted. */
    actorEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    actorType: {
      type: String,
      enum: ["merchant", "agent", "admin", "system"],
      default: "merchant",
    },
    /** Admin scope used to authorize the action (super_admin/finance_admin/support_admin). */
    actorScope: { type: String, trim: true, maxlength: 60 },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    subjectType: { type: String, enum: AUDIT_SUBJECT_TYPES, required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    meta: { type: Schema.Types.Mixed },
    /**
     * Before/after state snapshots — REQUIRED for any admin mutation. Free-form
     * shape so callers serialize whatever level of fidelity matters for the
     * action. Reads are diff-friendly: prevState is null on create, nextState
     * is null on delete. Both null is a no-op event (rare, but legal).
     */
    prevState: { type: Schema.Types.Mixed },
    nextState: { type: Schema.Types.Mixed },
    /** Request metadata — populated by writeAdminAudit from ctx.request. */
    ip: { type: String, trim: true, maxlength: 64 },
    userAgent: { type: String, trim: true, maxlength: 500 },
    at: { type: Date, required: true, default: () => new Date() },
    /**
     * Tamper-evident chain. Each row stores its own SHA-256 digest plus
     * the previous row's digest. Any ex-post mutation breaks the chain.
     * Verification walks the index and recomputes selfHash from the row's
     * canonical fields; a mismatch means the row (or its predecessor) was
     * altered. The two-hash design (prev + self) means a deletion from
     * the middle of the chain shows up as a `prevHash` mismatch on the
     * NEXT row, not just on the deleted one.
     */
    prevHash: { type: String, trim: true, maxlength: 64 },
    selfHash: { type: String, trim: true, maxlength: 64, index: true },
  },
  { timestamps: false }
);

auditLogSchema.index({ merchantId: 1, at: -1 });
auditLogSchema.index({ merchantId: 1, subjectType: 1, subjectId: 1, at: -1 });
auditLogSchema.index({ merchantId: 1, action: 1, at: -1 });
// Admin-pane reverse-chronological scan + scope-filtered queries.
auditLogSchema.index({ actorType: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });

/**
 * Immutability hooks. Audit rows are append-only. Mongoose can't fully prevent
 * a determined operator with shell access, but in-process attempts to update
 * or delete a row throw — the hooks catch every model-level mutation path
 * (updateOne, updateMany, findOneAndUpdate, deleteOne, deleteMany,
 * findOneAndDelete). Verifying the hash chain catches anything that
 * bypassed the hooks (raw collection access).
 *
 * Implementation note: Mongoose 8 dispatches `updateOne` and `deleteOne`
 * as both query-level (Model.updateOne) and document-level (doc.updateOne)
 * hooks. We register query-level for the model API path explicitly via
 * `{ query: true, document: false }` and use `throw` rather than the
 * legacy `next(err)` callback so the rejection propagates regardless of
 * how the hook is invoked (await, callback, or chain).
 */
const REFUSE_MSG =
  "AuditLog is append-only — updates and deletes are not permitted";
const QUERY_OPTS = { query: true, document: false } as const;
auditLogSchema.pre("updateOne", QUERY_OPTS, function () {
  throw new Error(REFUSE_MSG);
});
auditLogSchema.pre("updateMany", QUERY_OPTS, function () {
  throw new Error(REFUSE_MSG);
});
auditLogSchema.pre("findOneAndUpdate", QUERY_OPTS, function () {
  throw new Error(REFUSE_MSG);
});
auditLogSchema.pre("replaceOne", QUERY_OPTS, function () {
  throw new Error(REFUSE_MSG);
});
auditLogSchema.pre("deleteOne", QUERY_OPTS, function () {
  throw new Error(REFUSE_MSG);
});
auditLogSchema.pre("deleteMany", QUERY_OPTS, function () {
  throw new Error(REFUSE_MSG);
});
auditLogSchema.pre("findOneAndDelete", QUERY_OPTS, function () {
  throw new Error(REFUSE_MSG);
});
auditLogSchema.pre("findOneAndReplace", QUERY_OPTS, function () {
  throw new Error(REFUSE_MSG);
});
// Document-level save() guard: refuse re-saves of an already-persisted row.
auditLogSchema.pre("save", function (this: { isNew: boolean }) {
  if (!this.isNew) {
    throw new Error(
      "AuditLog is append-only — re-saving an existing row is not permitted",
    );
  }
});

export type AuditLog = InferSchemaType<typeof auditLogSchema> & { _id: Types.ObjectId };

export const AuditLog: Model<AuditLog> =
  (models.AuditLog as Model<AuditLog>) || model<AuditLog>("AuditLog", auditLogSchema);
