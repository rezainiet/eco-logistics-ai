import type { Job } from "bullmq";
import { Merchant } from "@ecom/db";
import { env } from "../env.js";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import {
  buildTrialEndingEmail,
  sendEmail,
  webUrl,
} from "../lib/email.js";

/**
 * Trial-ending warning sweep.
 *
 * Once per day, find every trial-status merchant whose `trialEndsAt` falls
 * inside the next `TRIAL_WARNING_DAYS` window and send a one-shot reminder
 * email. We stamp `notificationsSent.trialEndingAt = trialEndsAt` so a
 * second sweep on the same trial cycle is a no-op — the marker is only
 * cleared when the merchant restarts a trial (rare).
 *
 * Designed to be idempotent on multi-instance: the `findOneAndUpdate` with
 * a guard on `notificationsSent.trialEndingAt` ensures only one worker
 * actually fires the email even if two pick up the same row in the same
 * tick.
 */

const REPEAT_JOB_NAME = "trial-reminder:sweep";
const SCAN_BATCH = 200;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface TrialReminderJobResult {
  scanned: number;
  sent: number;
  skipped: number;
}

export async function sweepTrialReminders(): Promise<TrialReminderJobResult> {
  const now = new Date();
  const cutoff = new Date(now.getTime() + env.TRIAL_WARNING_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await Merchant.find({
    "subscription.status": "trial",
    "subscription.trialEndsAt": { $gt: now, $lte: cutoff },
  })
    .select("email businessName subscription.trialEndsAt notificationsSent.trialEndingAt")
    .limit(SCAN_BATCH)
    .lean();

  let sent = 0;
  let skipped = 0;

  for (const m of candidates) {
    const trialEndsAt = m.subscription?.trialEndsAt;
    if (!trialEndsAt) {
      skipped += 1;
      continue;
    }
    const lastSentFor = m.notificationsSent?.trialEndingAt;
    if (lastSentFor && new Date(lastSentFor).getTime() === new Date(trialEndsAt).getTime()) {
      skipped += 1;
      continue;
    }

    // Atomic claim — only one worker proceeds even if multiple instances see
    // the same merchant in the same tick.
    const claim = await Merchant.findOneAndUpdate(
      {
        _id: m._id,
        $or: [
          { "notificationsSent.trialEndingAt": { $exists: false } },
          { "notificationsSent.trialEndingAt": { $ne: trialEndsAt } },
        ],
      },
      { $set: { "notificationsSent.trialEndingAt": trialEndsAt } },
      { new: false },
    )
      .select("_id")
      .lean();
    if (!claim) {
      skipped += 1;
      continue;
    }

    const daysLeft = Math.max(
      1,
      Math.ceil((new Date(trialEndsAt).getTime() - now.getTime()) / 86400_000),
    );
    const tpl = buildTrialEndingEmail({
      businessName: m.businessName,
      daysLeft,
      pricingUrl: webUrl("/pricing"),
      billingUrl: webUrl("/dashboard/billing"),
    });
    const result = await sendEmail({
      to: m.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: "trial_ending",
    });
    if (result.ok) sent += 1;
    else skipped += 1;
  }

  return { scanned: candidates.length, sent, skipped };
}

export function registerTrialReminderWorker() {
  return registerWorker<unknown, TrialReminderJobResult>(
    QUEUE_NAMES.trialReminder,
    async (job: Job<unknown>) => {
      const res = await sweepTrialReminders();
      if (res.sent > 0) {
        console.log(
          `[trial-reminder] job=${job.id} scanned=${res.scanned} sent=${res.sent} skipped=${res.skipped}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

export async function scheduleTrialReminder(intervalMs: number = DEFAULT_INTERVAL_MS): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[trial-reminder] disabled (intervalMs<=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.trialReminder);
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
  console.log(`[trial-reminder] scheduled every ${intervalMs}ms`);
}
