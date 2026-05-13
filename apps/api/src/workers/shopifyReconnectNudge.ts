import type { Job } from "bullmq";
import { Integration, Merchant } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { buildShopifyReconnectEmail, webUrl } from "../lib/email.js";
import { enqueueEmail } from "./email.worker.js";

/**
 * Shopify reconnect-nudge sweep.
 *
 * The Phase B Token Exchange rollout requires refreshable offline
 * tokens; integrations installed before that rollout still carry
 * non-expiring tokens that Shopify is phasing out. Every Admin API
 * call from these rows is a 403-in-waiting — the legacy-token guard
 * in `shopify-token-refresh.ts` returns them in best-effort mode so
 * the merchant isn't hard-blocked, but the underlying integration
 * will silently degrade.
 *
 * This sweep picks up any Shopify integration that still has no
 * `refreshToken` / `accessTokenExpiresAt`, emails the merchant once
 * per cooldown window (default: 7 days, configurable via
 * SHOPIFY_RECONNECT_NUDGE_COOLDOWN_DAYS), and stamps
 * `lastReconnectNudgeAt` to gate the next attempt.
 *
 * Designed to be idempotent on multi-instance: the `findOneAndUpdate`
 * with a guard on `lastReconnectNudgeAt` ensures only one worker
 * actually fires the email even if two pick up the same row in the
 * same tick.
 */

const REPEAT_JOB_NAME = "shopify-reconnect-nudge:sweep";
const SCAN_BATCH = 200;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_COOLDOWN_DAYS = 7;

export interface ShopifyReconnectNudgeJobResult {
  scanned: number;
  sent: number;
  skipped: number;
}

function cooldownMs(): number {
  const raw = Number(
    process.env.SHOPIFY_RECONNECT_NUDGE_COOLDOWN_DAYS ??
      DEFAULT_COOLDOWN_DAYS,
  );
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLDOWN_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

export async function sweepShopifyReconnectNudges(): Promise<ShopifyReconnectNudgeJobResult> {
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - cooldownMs());

  // Find legacy Shopify rows: missing refreshToken OR
  // missing accessTokenExpiresAt AND either never nudged OR nudged
  // longer than the cooldown ago. Bounded by SCAN_BATCH so a backlog
  // doesn't make a single sweep run unbounded.
  const candidates = await Integration.find({
    provider: "shopify",
    status: { $in: ["connected", "error"] },
    $or: [
      { "credentials.refreshToken": { $in: [null, undefined, ""] } },
      { "credentials.accessTokenExpiresAt": { $in: [null, undefined] } },
    ],
    $and: [
      {
        $or: [
          { lastReconnectNudgeAt: { $exists: false } },
          { lastReconnectNudgeAt: null },
          { lastReconnectNudgeAt: { $lt: cooldownCutoff } },
        ],
      },
    ],
  })
    .select("_id merchantId accountKey lastReconnectNudgeAt")
    .limit(SCAN_BATCH)
    .lean();

  let sent = 0;
  let skipped = 0;

  // Pre-fetch merchant emails in one query to avoid N+1.
  const merchantIds = candidates
    .map((c) => c.merchantId)
    .filter((id): id is NonNullable<typeof id> => !!id);
  const merchants = await Merchant.find({ _id: { $in: merchantIds } })
    .select("_id email businessName")
    .lean();
  const merchantById = new Map(merchants.map((m) => [String(m._id), m]));

  for (const integration of candidates) {
    const merchant = merchantById.get(String(integration.merchantId));
    if (!merchant?.email) {
      skipped += 1;
      continue;
    }

    // Atomic claim: only one worker proceeds even if two instances
    // see the same integration in the same tick. The guard re-checks
    // the cooldown so a sibling tick that already nudged this row in
    // the last second is a no-op.
    const claim = await Integration.findOneAndUpdate(
      {
        _id: integration._id,
        $or: [
          { lastReconnectNudgeAt: { $exists: false } },
          { lastReconnectNudgeAt: null },
          { lastReconnectNudgeAt: { $lt: cooldownCutoff } },
        ],
      },
      { $set: { lastReconnectNudgeAt: now } },
      { new: false },
    )
      .select("_id")
      .lean();
    if (!claim) {
      skipped += 1;
      continue;
    }

    const tpl = buildShopifyReconnectEmail({
      businessName: merchant.businessName ?? merchant.email,
      shopDomain: integration.accountKey ?? "your store",
      integrationsUrl: webUrl("/dashboard/integrations"),
    });
    // Correlated on (integrationId, nudge-day) so the same email
    // can't enqueue twice for the same cooldown cycle even if the
    // worker is restarted mid-tick.
    const result = await enqueueEmail({
      correlationId: `shopify_reconnect:${String(integration._id)}:${Math.floor(now.getTime() / (24 * 60 * 60 * 1000))}`,
      to: merchant.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: "shopify_reconnect_nudge",
    });
    if (result.enqueued || result.mode === "inline") sent += 1;
    else skipped += 1;
  }

  return { scanned: candidates.length, sent, skipped };
}

export function registerShopifyReconnectNudgeWorker() {
  return registerWorker<unknown, ShopifyReconnectNudgeJobResult>(
    QUEUE_NAMES.shopifyReconnectNudge,
    async (job: Job<unknown>) => {
      const res = await sweepShopifyReconnectNudges();
      if (res.sent > 0) {
        console.log(
          `[shopify-reconnect-nudge] job=${job.id} scanned=${res.scanned} sent=${res.sent} skipped=${res.skipped}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

export async function scheduleShopifyReconnectNudge(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[shopify-reconnect-nudge] disabled (intervalMs<=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.shopifyReconnectNudge);
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
  console.log(`[shopify-reconnect-nudge] scheduled every ${intervalMs}ms`);
}
