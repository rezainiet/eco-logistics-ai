import { Types } from "mongoose";
import { AuditLog } from "@ecom/db";

type AuditAction =
  | "risk.scored"
  | "risk.recomputed"
  | "risk.alerted"
  | "review.verified"
  | "review.rejected"
  | "review.no_answer"
  | "review.reopened"
  | "order.booked"
  | "order.cancelled"
  | "order.ingested"
  | "courier.configured"
  | "fraud.config_updated"
  | "payment.submitted"
  | "payment.approved"
  | "payment.rejected"
  | "payment.checkout_started"
  | "payment.checkout_completed"
  | "payment.proof_uploaded"
  | "subscription.checkout_started"
  | "subscription.recurring_started"
  | "subscription.synced"
  | "subscription.payment_recovered"
  | "subscription.payment_failed"
  | "subscription.suspended"
  | "subscription.activated"
  | "subscription.cancelled"
  | "subscription.extended"
  | "subscription.plan_changed"
  | "integration.connected"
  | "integration.disconnected"
  | "integration.test"
  | "integration.webhook"
  | "integration.webhook_replayed"
  | "integration.webhook_dead_lettered"
  | "integration.shopify_oauth"
  | "tracking.identified"
  | "auth.reset_requested"
  | "auth.password_reset"
  | "auth.password_changed"
  | "auth.email_verified";

type SubjectType =
  | "order"
  | "merchant"
  | "courier"
  | "call"
  | "payment"
  | "integration"
  | "session";

export interface AuditEntry {
  merchantId: Types.ObjectId;
  actorId?: Types.ObjectId;
  actorType?: "merchant" | "agent" | "admin" | "system";
  action: AuditAction;
  subjectType: SubjectType;
  subjectId: Types.ObjectId;
  meta?: Record<string, unknown>;
}

/**
 * Fire-and-forget audit writer — never throws back into the caller's path.
 * Audit writes are best-effort; we log and swallow storage errors so a dropped
 * Mongo connection doesn't block a business action.
 */
export function writeAudit(entry: AuditEntry): Promise<void> {
  return AuditLog.create({
    ...entry,
    at: new Date(),
  })
    .then(() => undefined)
    .catch((err: Error) => {
      console.error("[audit] write failed", {
        action: entry.action,
        subject: `${entry.subjectType}:${entry.subjectId}`,
        err: err.message,
      });
    });
}
