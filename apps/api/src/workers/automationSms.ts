import type { Job } from "bullmq";
import { Types } from "mongoose";
import { Order } from "@ecom/db";
import { QUEUE_NAMES, registerWorker, safeEnqueue } from "../lib/queue.js";
import { sendOrderConfirmationSms } from "../lib/sms/index.js";
import { writeAudit } from "../lib/audit.js";

/**
 * Reliable outbound for the pending_confirmation prompt SMS.
 *
 * The order-create flow used to call sendOrderConfirmationSms inline as
 * fire-and-forget. If the SMS gateway was down at that moment, the order
 * silently rotted in pending_confirmation forever. This worker takes the
 * send off the request path and gives it BullMQ-grade retries with
 * exponential backoff. On success it stamps `automation.confirmationSentAt`
 * so the stale-pending sweeper and the merchant UI both know the prompt
 * actually went out.
 *
 * Idempotent: a duplicate enqueue for the same order collapses on
 * `jobId: auto-sms:<orderId>`. The worker also short-circuits if the
 * order has already moved out of pending_confirmation.
 */

const REPEAT_OPTS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 15_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 100 },
};

export interface AutoSmsJobData {
  orderId: string;
  merchantId: string;
  phone: string;
  orderNumber: string;
  codAmount?: number;
  /**
   * 6-digit confirmation code minted by the automation engine. Required —
   * the inbound-SMS parser refuses replies without a code, so we cannot
   * dispatch a confirmation prompt without one.
   */
  confirmationCode: string;
}

export interface AutoSmsJobResult {
  ok: boolean;
  status: "sent" | "skipped" | "failed";
  providerStatus?: string;
}

export async function enqueueOrderConfirmationSms(input: AutoSmsJobData): Promise<void> {
  await safeEnqueue(
    QUEUE_NAMES.automationSms,
    "send-confirm-sms",
    input,
    {
      ...REPEAT_OPTS,
      jobId: `auto-sms:${input.orderId}`,
    },
    {
      merchantId: input.merchantId,
      orderId: input.orderId,
      description: "confirmation SMS",
    },
  );
}

async function sendOrThrow(data: AutoSmsJobData): Promise<AutoSmsJobResult> {
  const orderOid = new Types.ObjectId(data.orderId);
  const merchantOid = new Types.ObjectId(data.merchantId);

  const order = await Order.findOne({ _id: orderOid, merchantId: merchantOid })
    .select("automation.state automation.confirmationSentAt")
    .lean();
  if (!order) {
    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.worker_skipped",
      subjectType: "order",
      subjectId: orderOid,
      meta: {
        worker: "auto-sms",
        reason: "order_not_found",
        expected: "pending_confirmation",
      },
    }).catch(() => {});
    return { ok: true, status: "skipped", providerStatus: "order_not_found" };
  }
  const state = (order as { automation?: { state?: string } }).automation?.state;
  if (state !== "pending_confirmation") {
    // State no longer matches what the job was queued for — most
    // commonly: merchant restored or rejected the order between
    // enqueue and pickup. Loud audit so timeline reconstruction
    // shows the worker stepping aside cleanly.
    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.worker_skipped",
      subjectType: "order",
      subjectId: orderOid,
      meta: {
        worker: "auto-sms",
        reason: "state_mismatch",
        expected: "pending_confirmation",
        actual: state ?? "unset",
      },
    }).catch(() => {});
    return { ok: true, status: "skipped", providerStatus: `state_${state ?? "unset"}` };
  }

  const result = await sendOrderConfirmationSms(data.phone, {
    orderNumber: data.orderNumber,
    codAmount: data.codAmount,
    confirmationCode: data.confirmationCode,
  });

  if (!result.ok) {
    // Throw so BullMQ counts the attempt and retries with backoff.
    throw new Error(result.error ?? `sms failed (${result.providerStatus ?? "unknown"})`);
  }

  // State-guarded write: between the lookup at line 72 and this point the
  // order may have been confirmed/rejected (SMS reply, manual action,
  // stale-sweeper). Filtering on automation.state prevents stamping a
  // confirmation timestamp on an order that has moved on.
  const stamped = await Order.updateOne(
    {
      _id: orderOid,
      merchantId: merchantOid,
      "automation.state": "pending_confirmation",
    },
    {
      $set: {
        "automation.confirmationSentAt": new Date(),
        "automation.confirmationChannel": "sms",
      },
    },
  );
  if (stamped.matchedCount === 0) {
    return { ok: true, status: "skipped", providerStatus: "state_changed_after_send" };
  }

  return { ok: true, status: "sent", providerStatus: result.providerStatus };
}

export function registerAutomationSmsWorker() {
  const worker = registerWorker<AutoSmsJobData, AutoSmsJobResult>(
    QUEUE_NAMES.automationSms,
    async (job: Job<AutoSmsJobData>) => sendOrThrow(job.data),
    { concurrency: 4 },
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    const exhausted =
      job.opts.attempts !== undefined && (job.attemptsMade ?? 0) >= job.opts.attempts;
    if (!exhausted) return;

    const data = job.data;
    let merchantOid: Types.ObjectId | null = null;
    let orderOid: Types.ObjectId | null = null;
    try {
      merchantOid = new Types.ObjectId(data.merchantId);
      orderOid = new Types.ObjectId(data.orderId);
    } catch {
      return;
    }

    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.confirmation_sms_failed",
      subjectType: "order",
      subjectId: orderOid,
      meta: {
        attempts: job.attemptsMade,
        error: err.message?.slice(0, 500),
        orderNumber: data.orderNumber,
      },
    }).catch(() => {});
  });

  return worker;
}

export const __TEST = { REPEAT_OPTS };
