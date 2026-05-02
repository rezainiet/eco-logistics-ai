import { Types } from "mongoose";
import { Order } from "@ecom/db";
import { writeAudit } from "./audit.js";
import { enqueueOrderConfirmationSms } from "../workers/automationSms.js";

/**
 * Deterministic, idempotent queue rebuilder. Called after a restore
 * (or any other operation that lands an order in a state the queues
 * should reflect). Reads the order's CURRENT state and ensures each
 * queue surface matches:
 *
 *   - **Fraud queue**: query-based, no enqueue. The merchant's review
 *     queue is built from `fraud.reviewStatus ∈ {pending_call,
 *     no_answer}`. Restoring `fraud.reviewStatus` from the snapshot
 *     (done inside restoreOrder) is sufficient — no push needed.
 *
 *   - **Automation SMS queue**: the auto-sms worker fires when an
 *     order needs a `pending_confirmation` prompt sent. We enqueue
 *     ONLY when:
 *       - automation.state === "pending_confirmation"
 *       - confirmationSentAt is unset (else the prompt already went)
 *       - confirmationCode is set (worker requires it)
 *
 *   - **Booking queue**: NEVER auto-enqueued. By design — restoring
 *     a previously-auto-booked order does not silently re-trigger
 *     the courier API call. The merchant must click Book again, or
 *     wait for the next manual / scheduled trigger.
 *
 * Idempotency: the auto-sms worker uses `jobId: auto-sms:<orderId>`,
 * so repeated rebuildQueueState calls collapse on BullMQ's dedupe.
 * The order's own state guards (the worker checks
 * `automation.state === "pending_confirmation"` again before sending)
 * provide a second safety net.
 */

export interface RebuildQueueStateResult {
  orderId: string;
  /** Decisions made, for audit + tests. */
  smsEnqueued: boolean;
  bookingEnqueued: boolean; // always false; surfaced for clarity
  fraudQueueEligible: boolean;
  reason: string;
}

export async function rebuildQueueState(args: {
  orderId: Types.ObjectId | string;
  merchantId: Types.ObjectId;
  /** Skip audit emit when the caller plans to write its own. */
  skipAudit?: boolean;
}): Promise<RebuildQueueStateResult> {
  const orderOid =
    args.orderId instanceof Types.ObjectId
      ? args.orderId
      : new Types.ObjectId(args.orderId);
  const merchantOid = args.merchantId;

  const order = await Order.findOne({ _id: orderOid, merchantId: merchantOid })
    .select(
      "automation.state automation.confirmationSentAt automation.confirmationCode customer.phone orderNumber order.cod order.status fraud.reviewStatus",
    )
    .lean<{
      automation?: {
        state?: string;
        confirmationSentAt?: Date | null;
        confirmationCode?: string;
      };
      customer?: { phone?: string };
      orderNumber?: string;
      order?: { cod?: number; status?: string };
      fraud?: { reviewStatus?: string };
    }>();

  if (!order) {
    return {
      orderId: String(orderOid),
      smsEnqueued: false,
      bookingEnqueued: false,
      fraudQueueEligible: false,
      reason: "order_not_found",
    };
  }

  const automationState = order.automation?.state;
  const fraudReviewStatus = order.fraud?.reviewStatus;
  const fraudQueueEligible =
    fraudReviewStatus === "pending_call" || fraudReviewStatus === "no_answer";

  let smsEnqueued = false;
  let reason = `state=${automationState ?? "unset"}`;

  // Booking is intentionally NEVER re-enqueued. Documented above.
  const bookingEnqueued = false;

  if (
    automationState === "pending_confirmation" &&
    !order.automation?.confirmationSentAt &&
    order.automation?.confirmationCode &&
    order.customer?.phone &&
    order.orderNumber
  ) {
    await enqueueOrderConfirmationSms({
      orderId: String(orderOid),
      merchantId: String(merchantOid),
      phone: order.customer.phone,
      orderNumber: order.orderNumber,
      codAmount: order.order?.cod,
      confirmationCode: order.automation.confirmationCode,
    });
    smsEnqueued = true;
    reason += "; auto-sms enqueued";
  }

  if (!args.skipAudit) {
    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.queue_rebuilt",
      subjectType: "order",
      subjectId: orderOid,
      meta: {
        automationState: automationState ?? null,
        fraudReviewStatus: fraudReviewStatus ?? null,
        fraudQueueEligible,
        smsEnqueued,
        bookingEnqueued,
        reason,
      },
    });
  }

  return {
    orderId: String(orderOid),
    smsEnqueued,
    bookingEnqueued,
    fraudQueueEligible,
    reason,
  };
}
