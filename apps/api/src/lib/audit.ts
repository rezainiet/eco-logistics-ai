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
  | "courier.configured"
  | "fraud.config_updated"
  | "payment.submitted"
  | "payment.approved"
  | "payment.rejected"
  | "subscription.activated"
  | "subscription.cancelled"
  | "subscription.extended"
  | "subscription.plan_changed";

type SubjectType = "order" | "merchant" | "courier" | "call" | "payment";

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
