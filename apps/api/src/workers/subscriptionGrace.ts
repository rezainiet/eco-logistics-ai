import type { Job } from "bullmq";
import { Types } from "mongoose";
import { Merchant } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { invalidateSubscriptionCache } from "../server/trpc.js";
import { writeAudit } from "../lib/audit.js";
import {
  buildSubscriptionSuspendedEmail,
  sendEmail,
  webUrl,
} from "../lib/email.js";

/**
 * Grace-expiry sweep.
 *
 * Sub state machine:
 *   active → past_due (set by `invoice.payment_failed`, with
 *            `gracePeriodEndsAt = now + STRIPE_GRACE_DAYS`)
 *          → suspended (set HERE, when `gracePeriodEndsAt < now`)
 *
 * Recovery is orthogonal: `invoice.payment_succeeded` flips back to
 * active and clears `gracePeriodEndsAt`. So we only need to scan
 * past_due rows whose deadline has passed; if Stripe recovered first the
 * grace timestamp is null and the merchant is excluded by the partial
 * index used in the find().
 *
 * Idempotency: the atomic `findOneAndUpdate` only fires for rows still
 * in the past_due bucket, so re-running the sweep is a no-op once a
 * merchant is suspended. The notification email is sent inside the
 * conditional branch so we never double-fire it.
 */

const REPEAT_JOB_NAME = "subscription-grace:sweep";
const SCAN_BATCH = 200;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly

export interface SubscriptionGraceJobResult {
  scanned: number;
  suspended: number;
  skipped: number;
}

export async function sweepSubscriptionGrace(): Promise<SubscriptionGraceJobResult> {
  const now = new Date();
  // Fast pre-filter — the partial index on
  // {subscription.status, subscription.gracePeriodEndsAt} keeps this cheap.
  const candidates = await Merchant.find({
    "subscription.status": "past_due",
    "subscription.gracePeriodEndsAt": { $lte: now },
  })
    .select("_id email businessName subscription.gracePeriodEndsAt")
    .limit(SCAN_BATCH)
    .lean();

  let suspended = 0;
  let skipped = 0;

  for (const m of candidates) {
    // Atomic flip — the `status: "past_due"` guard means a merchant who
    // recovered between the find() and the update() (because Stripe
    // retried payment in the gap) won't be suspended.
    const claim = await Merchant.findOneAndUpdate(
      {
        _id: m._id as Types.ObjectId,
        "subscription.status": "past_due",
        "subscription.gracePeriodEndsAt": { $lte: now },
      },
      {
        $set: { "subscription.status": "suspended" },
      },
      { new: false },
    )
      .select("_id")
      .lean();
    if (!claim) {
      skipped += 1;
      continue;
    }

    invalidateSubscriptionCache(String(m._id));
    suspended += 1;

    void writeAudit({
      merchantId: m._id as Types.ObjectId,
      actorId: m._id as Types.ObjectId,
      actorType: "system",
      action: "subscription.suspended",
      subjectType: "merchant",
      subjectId: m._id as Types.ObjectId,
      meta: {
        gracePeriodEndsAt: m.subscription?.gracePeriodEndsAt ?? null,
        sweptAt: now,
      },
    });

    const tpl = buildSubscriptionSuspendedEmail({
      businessName: m.businessName,
      billingUrl: webUrl("/dashboard/billing"),
    });
    void sendEmail({
      to: m.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: "subscription_suspended",
    }).catch((err) =>
      console.error("[grace] suspend email failed", (err as Error).message),
    );
  }

  return { scanned: candidates.length, suspended, skipped };
}

export function registerSubscriptionGraceWorker() {
  return registerWorker<unknown, SubscriptionGraceJobResult>(
    QUEUE_NAMES.subscriptionGrace,
    async (job: Job<unknown>) => {
      const res = await sweepSubscriptionGrace();
      if (res.suspended > 0) {
        console.log(
          `[grace] job=${job.id} scanned=${res.scanned} suspended=${res.suspended} skipped=${res.skipped}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

export async function scheduleSubscriptionGrace(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[grace] disabled (intervalMs<=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.subscriptionGrace);
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
  console.log(`[grace] scheduled every ${intervalMs}ms`);
}
