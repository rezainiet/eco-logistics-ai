import type { Job } from "bullmq";
import { Types } from "mongoose";
import { Order } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { writeAudit } from "../lib/audit.js";
import { dispatchNotification } from "../lib/notifications.js";
import { updateOrderWithVersion } from "../lib/orderConcurrency.js";

/**
 * Stale-pending sweeper.
 *
 * Orders sitting in `automation.state = "pending_confirmation"` for longer
 * than STALE_AFTER_HOURS are escalated. Behaviour:
 *
 *   1. STALE (≥ STALE_AFTER_HOURS since the SMS went out):
 *      - notify the merchant once (in-app, dedupe per-order)
 *      - stamp `fraud.smsFeedback = "no_reply"` and
 *        `fraud.reviewStatus = "pending_call"` so the call-center queue
 *        picks it up BEFORE it auto-cancels at EXPIRE_AFTER_HOURS
 *
 *   2. EXPIRED (≥ EXPIRE_AFTER_HOURS since the SMS went out):
 *      - flip `automation.state` → `rejected`, `order.status` → `cancelled`
 *      - notify the merchant once (separate dedupe key)
 *
 * Both stages are gated on `confirmationSentAt` (when the SMS was actually
 * dispatched), NOT `createdAt`. If the SMS queue lags 6h, the customer
 * still gets the full window from when they received the message.
 *
 * Idempotency:
 *   - Notification dedupeKeys per stage collapse repeated rows into one.
 *   - All state writes are gated on the current state being
 *     "pending_confirmation" so a concurrent merchant click wins cleanly.
 */

const REPEAT_JOB_NAME = "automation-stale:sweep";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SCAN_BATCH = 200;

const STALE_AFTER_HOURS = 24;
const EXPIRE_AFTER_HOURS = 72;

export interface AutomationStaleResult {
  scanned: number;
  notified: number;
  expired: number;
}

export async function sweepStalePendingConfirmations(): Promise<AutomationStaleResult> {
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_AFTER_HOURS * 3600_000);
  const expireCutoff = new Date(now - EXPIRE_AFTER_HOURS * 3600_000);

  // Gate on confirmationSentAt (when the customer actually got the SMS),
  // not createdAt — if the SMS queue lagged 6h, the customer still gets
  // the full window from when they received it.
  const stale = await Order.find({
    "automation.state": "pending_confirmation",
    "automation.confirmationSentAt": { $lte: staleCutoff },
  })
    .select(
      "_id merchantId orderNumber createdAt order.status automation.confirmationSentAt version",
    )
    .limit(SCAN_BATCH)
    .lean();

  let notified = 0;
  let expired = 0;

  for (const o of stale) {
    const orderOid = o._id as Types.ObjectId;
    const merchantOid = o.merchantId as Types.ObjectId;
    const orderVersion = (o as { version?: number }).version ?? 0;
    const sentAt = (o as { automation?: { confirmationSentAt?: Date } }).automation
      ?.confirmationSentAt;
    const ageMs = sentAt ? now - new Date(sentAt).getTime() : 0;
    const orderNumber = (o as { orderNumber?: string }).orderNumber ?? String(orderOid).slice(-6);

    if (sentAt && sentAt <= expireCutoff) {
      // Auto-reject. Guarded on (state, version) — version guard catches the
      // narrow window where a merchant action mutated the doc between scan
      // and write but the state filter alone wouldn't have caught it (e.g.
      // confirm + auto-book + revert all landing in milliseconds).
      const stamp = new Date();
      const cas = await updateOrderWithVersion(
        { _id: orderOid, version: orderVersion, merchantId: merchantOid },
        {
          $set: {
            "automation.state": "rejected",
            "automation.decidedBy": "system",
            "automation.decidedAt": stamp,
            "automation.rejectedAt": stamp,
            "automation.rejectionReason": `auto-expired after ${EXPIRE_AFTER_HOURS}h without customer reply`,
            "order.status": "cancelled",
            // Preserve why the order died — surfaces in the order's fraud
            // panel and keeps the analytics rollups honest.
            "fraud.smsFeedback": "no_reply",
            "fraud.smsFeedbackAt": stamp,
            // Mark for analytics: a no-reply auto-cancel is effectively a
            // rejected review outcome (system did the agent's work).
            "fraud.reviewStatus": "rejected",
            "fraud.reviewedAt": stamp,
          },
        },
        {
          extraFilter: { "automation.state": "pending_confirmation" },
          returnDoc: true,
          projection: { _id: 1 },
        },
      );
      const updated = cas.ok ? cas.doc : null;
      if (!updated) {
        // State moved between the scan and this write (most commonly:
        // merchant confirmed/rejected/restored). Loud audit so the
        // timeline shows the worker correctly stepping aside.
        void writeAudit({
          merchantId: merchantOid,
          actorId: merchantOid,
          actorType: "system",
          action: "automation.worker_skipped",
          subjectType: "order",
          subjectId: orderOid,
          meta: {
            worker: "auto-stale",
            stage: "expire",
            reason: "state_mismatch",
            expected: "pending_confirmation",
          },
        }).catch(() => {});
      }
      if (updated) {
        expired += 1;
        await writeAudit({
          merchantId: merchantOid,
          actorId: merchantOid,
          actorType: "system",
          action: "automation.auto_expired",
          subjectType: "order",
          subjectId: orderOid,
          meta: {
            orderNumber,
            ageHours: Math.round(ageMs / 3600_000),
            reason: "stale pending_confirmation",
          },
        }).catch(() => {});
        await dispatchNotification({
          merchantId: merchantOid,
          kind: "automation.stale_pending",
          severity: "warning",
          title: `Order ${orderNumber} auto-cancelled (no reply in ${EXPIRE_AFTER_HOURS}h)`,
          body: `The customer never replied YES/NO to the confirmation SMS. The order has been moved to cancelled. You can re-create it manually if the customer reaches out.`,
          subjectType: "order",
          subjectId: orderOid,
          dedupeKey: `automation_expired:${String(orderOid)}`,
          meta: { ageHours: Math.round(ageMs / 3600_000), orderNumber },
        }).catch(() => {});
      }
      continue;
    }

    // Between STALE_AFTER and EXPIRE_AFTER → mark the order for the
    // call-center queue AND notify the merchant. Stage transition is
    // gated on (state, version) so a concurrent confirm/reject/restore
    // wins, and a stale-read sweeper exits cleanly.
    const escalateStamp = new Date();
    const escalateCas = await updateOrderWithVersion(
      { _id: orderOid, version: orderVersion, merchantId: merchantOid },
      {
        $set: {
          "fraud.smsFeedback": "no_reply",
          "fraud.smsFeedbackAt": escalateStamp,
          "fraud.reviewStatus": "pending_call",
        },
      },
      {
        extraFilter: { "automation.state": "pending_confirmation" },
        returnDoc: true,
        projection: { _id: 1, fraud: 1 },
      },
    );
    const escalated = escalateCas.ok ? escalateCas.doc : null;

    if (escalated) {
      // Audit the escalation once per order (writeAudit doesn't dedupe, so
      // we rely on dispatchNotification's dedupeKey to keep the inbox tidy
      // and on the gated update above to make this a no-op next sweep).
      await writeAudit({
        merchantId: merchantOid,
        actorId: merchantOid,
        actorType: "system",
        action: "automation.escalated_no_reply",
        subjectType: "order",
        subjectId: orderOid,
        meta: { orderNumber, ageHours: Math.round(ageMs / 3600_000) },
      }).catch(() => {});
    } else {
      // Escalation atomic-update missed → state moved between scan and
      // write. Most commonly a parallel restore / confirm / reject.
      void writeAudit({
        merchantId: merchantOid,
        actorId: merchantOid,
        actorType: "system",
        action: "automation.worker_skipped",
        subjectType: "order",
        subjectId: orderOid,
        meta: {
          worker: "auto-stale",
          stage: "escalate",
          reason: "state_mismatch",
          expected: "pending_confirmation",
        },
      }).catch(() => {});
      continue;
    }

    await dispatchNotification({
      merchantId: merchantOid,
      kind: "automation.stale_pending",
      severity: "info",
      title: `Order ${orderNumber} still awaiting customer confirmation`,
      body: `It's been more than ${STALE_AFTER_HOURS}h since we sent the confirmation SMS. We've moved it to your call queue and will auto-cancel after ${EXPIRE_AFTER_HOURS}h if neither you nor the customer responds.`,
      subjectType: "order",
      subjectId: orderOid,
      dedupeKey: `automation_stale:${String(orderOid)}`,
      meta: { ageHours: Math.round(ageMs / 3600_000), orderNumber },
    }).catch(() => {});
    notified += 1;
  }

  return { scanned: stale.length, notified, expired };
}

export function registerAutomationStaleWorker() {
  return registerWorker<unknown, AutomationStaleResult>(
    QUEUE_NAMES.automationStale,
    async (job: Job<unknown>) => {
      const res = await sweepStalePendingConfirmations();
      if (res.notified > 0 || res.expired > 0) {
        console.log(
          `[automation-stale] job=${job.id} scanned=${res.scanned} notified=${res.notified} expired=${res.expired}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

export async function scheduleAutomationStaleSweep(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[automation-stale] disabled (intervalMs<=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.automationStale);
  const repeatables = await q.getRepeatableJobs();
  await Promise.all(
    repeatables
      .filter((r) => r.name === REPEAT_JOB_NAME)
      .map((r) => q.removeRepeatableByKey(r.key)),
  );
  await q.add(
    REPEAT_JOB_NAME,
    {},
    {
      repeat: { every: intervalMs },
      jobId: REPEAT_JOB_NAME,
    },
  );
  console.log(`[automation-stale] scheduled every ${intervalMs}ms`);
}

export const __TEST = { STALE_AFTER_HOURS, EXPIRE_AFTER_HOURS };
