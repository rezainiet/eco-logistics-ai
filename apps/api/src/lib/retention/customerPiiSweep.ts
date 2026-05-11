import {
  CallLog,
  Order,
  RecoveryTask,
  TrackingSession,
  WebhookInbox,
} from "@ecom/db";

/**
 * Customer-PII retention sweep — pseudonymises identifiable fields on
 * records older than the configured retention window. Required by the
 * Shopify Protected Customer Data programme's "Apply retention periods"
 * commitment (Level 1).
 *
 * Behaviour mirrors `redactCustomer` in lib/gdpr/redaction.ts, but
 * scoped by age (createdAt < cutoff) instead of by identifier match.
 * Order + CallLog rows are kept (analytics survives) with their PII
 * blanked; RecoveryTask / TrackingSession / WebhookInbox are deleted
 * outright — those collections exist only as identity-pivoted scratch,
 * so an "anonymised" row would just be deadweight.
 *
 * Idempotent: the order/call updates skip rows already containing the
 * REDACTED sentinel, so a re-run is a no-op on previously-swept rows.
 */
const REDACTED = "[redacted]";

export interface RetentionSweepResult {
  cutoff: string;
  retentionDays: number;
  orders: { redacted: number };
  callLogs: { redacted: number };
  recoveryTasks: { deleted: number };
  trackingSessions: { deleted: number };
  webhookInbox: { deleted: number };
}

export interface RetentionSweepOptions {
  retentionDays: number;
}

export async function runCustomerPiiRetentionSweep(
  options: RetentionSweepOptions,
): Promise<RetentionSweepResult> {
  const { retentionDays } = options;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const orderUpdate = await Order.updateMany(
    {
      createdAt: { $lt: cutoff },
      $or: [
        { "customer.name": { $exists: true, $ne: REDACTED } },
        { "customer.phone": { $exists: true, $ne: REDACTED } },
        { "customer.email": { $exists: true, $ne: REDACTED } },
        { "customer.address": { $exists: true, $ne: REDACTED } },
      ],
    },
    {
      $set: {
        "customer.name": REDACTED,
        "customer.phone": REDACTED,
        "customer.address": REDACTED,
        "customer.email": REDACTED,
        "shipping.name": REDACTED,
        "shipping.phone": REDACTED,
        "shipping.address": REDACTED,
      },
    },
  );

  const callUpdate = await CallLog.updateMany(
    {
      createdAt: { $lt: cutoff },
      $or: [
        { customerName: { $exists: true, $ne: REDACTED } },
        { customerPhone: { $exists: true, $ne: REDACTED } },
      ],
    },
    {
      $set: {
        customerName: REDACTED,
        customerPhone: REDACTED,
      },
    },
  );

  const recoveryDelete = await RecoveryTask.deleteMany({
    createdAt: { $lt: cutoff },
  });
  const trackingDelete = await TrackingSession.deleteMany({
    createdAt: { $lt: cutoff },
  });
  const inboxDelete = await WebhookInbox.deleteMany({
    createdAt: { $lt: cutoff },
  });

  return {
    cutoff: cutoff.toISOString(),
    retentionDays,
    orders: { redacted: orderUpdate.modifiedCount ?? 0 },
    callLogs: { redacted: callUpdate.modifiedCount ?? 0 },
    recoveryTasks: { deleted: recoveryDelete.deletedCount ?? 0 },
    trackingSessions: { deleted: trackingDelete.deletedCount ?? 0 },
    webhookInbox: { deleted: inboxDelete.deletedCount ?? 0 },
  };
}
