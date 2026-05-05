import type { Types } from "mongoose";
import { Integration } from "@ecom/db";
import {
  getQueue,
  QUEUE_NAMES,
  registerWorker,
  safeEnqueue,
} from "../lib/queue.js";
import { adapterFor } from "../lib/integrations/index.js";
import { decryptSecret } from "../lib/crypto.js";
import { enqueueInboundWebhook } from "../server/ingest.js";
import type { IntegrationCredentials } from "../lib/integrations/types.js";

export interface OrderSyncTickResult {
  scanned: number;
  /** Sum of raw deliveries handed to the inbox across all integrations. */
  enqueued: number;
  /** Sum of inbox rows that came back as duplicates (webhook beat us). */
  duplicates: number;
  /** Per-integration adapter failures — leaves cursor untouched. */
  failed: number;
}

export interface RunOrderSyncOnceOptions {
  /** Override for tests — typically the global mongo cursor isn't filtered. */
  integrationFilter?: Record<string, unknown>;
  /**
   * Override the per-integration limit. Production caps at 50; tests use
   * smaller values for speed.
   */
  ordersPerTick?: number;
  /**
   * When false, skip the safeEnqueue call that hands the inbox row to
   * the webhook-process worker. Tests turn this off to assert the inbox
   * stamp without spinning up a worker. Production always enqueues.
   */
  enqueueProcessor?: boolean;
}

/**
 * Auto-sync (polling) worker.
 *
 * Hybrid sync model:
 *   - Webhooks deliver orders in real time (sub-second latency).
 *   - This worker is the recovery rail: every tick it sweeps active
 *     integrations, pulls orders placed since `lastSyncedAt`, and pushes
 *     each one through the EXACT SAME inbox path that webhooks use. The
 *     `(merchantId, provider, externalId)` unique key on `WebhookInbox`
 *     plus the `(merchantId, source.sourceProvider, source.externalId)`
 *     partial unique on `Order` make duplicates impossible — a polled
 *     order whose webhook DID land short-circuits at inbox stamping
 *     with `duplicate: true` and never re-enters ingestion.
 *
 * Crash + retry semantics:
 *   - On an adapter failure (HTTP 5xx, schema_drift, timeout) we leave
 *     `lastSyncedAt` UNCHANGED and log the error. The next tick replays
 *     from the same cursor, so a transient blip self-heals after one
 *     tick. The worker NEVER advances the cursor past unfetched orders.
 *   - On per-order inbox-stamp failure (e.g. a Redis hiccup that
 *     `safeEnqueue`'s dead-letter path catches) the inbox row is
 *     persisted to PendingJob; the cursor still advances because the
 *     order WAS captured. The replay sweep promotes it onto BullMQ when
 *     Redis recovers.
 *
 * Safety limits:
 *   - 50 orders per integration per tick. Adapters cap at this internally
 *     (Shopify+Woo use `limit=50`/`per_page=50`). Backlogs > 50 drain on
 *     subsequent ticks because the cursor advances to the newest in the
 *     batch and the next tick re-fetches with the new floor.
 *   - Disabled in tests + dev when REDIS_URL is unset (the BullMQ-backed
 *     scheduler can't run without Redis); call the exported
 *     `runOrderSyncOnce` directly in tests instead.
 */
const REPEAT_JOB_NAME = "order-sync:sweep";
const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5 minutes
const ORDERS_PER_TICK = 50;

/**
 * Providers the auto-sync worker actively polls. `custom_api` is
 * push-only (no remote endpoint to pull from) and `csv` is a manual
 * upload path; both are skipped at the filter layer.
 */
const POLLED_PROVIDERS = ["shopify", "woocommerce"] as const;

function decryptCreds(
  stored: Record<string, unknown> | null | undefined,
): Partial<IntegrationCredentials> {
  const s = (stored ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const tryDecrypt = (v: unknown): string | undefined => {
    if (!v) return undefined;
    try {
      return decryptSecret(v as never);
    } catch {
      return undefined;
    }
  };
  if (s.apiKey) out.apiKey = tryDecrypt(s.apiKey);
  if (s.apiSecret) out.apiSecret = tryDecrypt(s.apiSecret);
  if (s.accessToken) out.accessToken = tryDecrypt(s.accessToken);
  if (s.consumerKey) out.consumerKey = tryDecrypt(s.consumerKey);
  if (s.consumerSecret) out.consumerSecret = tryDecrypt(s.consumerSecret);
  if (s.siteUrl) out.siteUrl = s.siteUrl;
  if (s.authStrategy === "basic" || s.authStrategy === "querystring") {
    out.authStrategy = s.authStrategy;
  }
  return out as Partial<IntegrationCredentials>;
}

/**
 * Sync a single integration. Public for tests (lets us drive one
 * integration deterministically without spinning up the cursor).
 *
 * Returns counters that aggregate up into `OrderSyncTickResult`. Never
 * throws — adapter failures resolve to `{ failed: 1 }`.
 */
export async function syncOneIntegration(
  integrationId: Types.ObjectId,
  options: RunOrderSyncOnceOptions = {},
): Promise<{ enqueued: number; duplicates: number; failed: number }> {
  const integration: any = await Integration.findById(integrationId);
  if (!integration) return { enqueued: 0, duplicates: 0, failed: 0 };
  if (integration.status !== "connected") {
    return { enqueued: 0, duplicates: 0, failed: 0 };
  }
  // Soft-pause: mirror the webhook-route short-circuit so polling
  // doesn't backfill orders the merchant explicitly told us to ignore.
  // No state change to lastSyncedAt — when they resume, we pick up
  // exactly where we left off.
  if (integration.pausedAt) {
    return { enqueued: 0, duplicates: 0, failed: 0 };
  }
  if (!(POLLED_PROVIDERS as readonly string[]).includes(integration.provider)) {
    return { enqueued: 0, duplicates: 0, failed: 0 };
  }
  const adapter: any = adapterFor(integration.provider);
  const creds = decryptCreds(integration.credentials ?? {});
  const limit = options.ordersPerTick ?? ORDERS_PER_TICK;
  const since: Date | undefined = integration.lastSyncedAt ?? undefined;

  let fetched: any;
  try {
    fetched = await adapter.fetchSampleOrders(creds, limit, since);
  } catch (err: any) {
    // Defensive — adapters generally don't throw, but a programmer
    // error or unexpected upstream shape could leak. Treat as a
    // transient failure: leave the cursor, log, retry next tick.
    const errMsg: string = err?.message?.slice(0, 500) ?? "unknown";
    console.error(
      JSON.stringify({
        evt: "order_sync.fetch_error",
        integrationId: String(integrationId),
        provider: integration.provider,
        merchantId: String(integration.merchantId),
        error: errMsg.slice(0, 200),
      }),
    );
    await Integration.updateOne(
      { _id: integration._id },
      {
        $inc: { errorCount: 1 },
        $set: { lastSyncStatus: "error", lastError: errMsg },
      },
    ).catch(() => {});
    return { enqueued: 0, duplicates: 0, failed: 1 };
  }

  if (!fetched.ok) {
    const errMsg: string = fetched.error?.slice(0, 500) ?? "unknown";
    console.warn(
      JSON.stringify({
        evt: "order_sync.fetch_failed",
        integrationId: String(integrationId),
        provider: integration.provider,
        merchantId: String(integration.merchantId),
        error: errMsg.slice(0, 200),
      }),
    );
    await Integration.updateOne(
      { _id: integration._id },
      {
        $inc: { errorCount: 1 },
        $set: { lastSyncStatus: "error", lastError: errMsg },
      },
    ).catch(() => {});
    return { enqueued: 0, duplicates: 0, failed: 1 };
  }

  const deliveries: any[] = fetched.rawDeliveries ?? [];
  if (deliveries.length === 0) {
    // Nothing new — keep `lastSyncedAt` exactly where it is so the next
    // tick's `?after=` window stays anchored on the most recent ingest.
    // Still flip status to `ok` and reset the failure counter: a healthy
    // poll of an upstream that simply has no new orders is the most
    // common "all good, nothing to do" signal.
    await Integration.updateOne(
      { _id: integration._id },
      { $set: { lastSyncStatus: "ok", errorCount: 0, lastError: null } },
    ).catch(() => {});
    return { enqueued: 0, duplicates: 0, failed: 0 };
  }

  let enqueued = 0;
  let duplicates = 0;
  let newestPlacedAt: Date | undefined = since
    ? new Date(since.getTime())
    : undefined;

  for (const delivery of deliveries) {
    if (delivery.placedAt) {
      if (!newestPlacedAt || delivery.placedAt > newestPlacedAt) {
        newestPlacedAt = delivery.placedAt;
      }
    }
    let stamped: any;
    try {
      stamped = await enqueueInboundWebhook({
        merchantId: integration.merchantId,
        integrationId: integration._id,
        provider: integration.provider,
        topic: delivery.topic,
        externalId: delivery.externalId,
        rawPayload: delivery.payload,
        payloadBytes: JSON.stringify(delivery.payload).length,
      } as any);
    } catch (err: any) {
      console.error(
        JSON.stringify({
          evt: "order_sync.inbox_stamp_failed",
          integrationId: String(integrationId),
          externalId: delivery.externalId,
          error: err?.message?.slice(0, 200) ?? "unknown",
        }),
      );
      // Don't bump the cursor past this row — next tick will retry the
      // stamp. We continue with the rest of the batch.
      continue;
    }
    if (stamped.duplicate) {
      duplicates += 1;
      continue;
    }
    enqueued += 1;
    if (options.enqueueProcessor !== false) {
      // Hand the fresh inbox row to the same worker the live webhook
      // route uses. `safeEnqueue` never throws — on Redis outage it
      // dead-letters to PendingJob and the retry sweep promotes it back.
      void safeEnqueue(
        QUEUE_NAMES.webhookProcess,
        "webhook-process:ingest",
        { inboxId: String(stamped.inboxId) },
        { attempts: 1 },
        {
          merchantId: String(integration.merchantId),
          description: `${integration.provider} order-sync ingest`,
        },
      );
    }
  }

  // Advance the cursor only if we observed at least one placedAt that
  // moved the watermark. A batch where every order had `placedAt`
  // missing is treated as cursor-neutral — the next tick re-fetches the
  // same window. Observability fields are bumped regardless: a
  // successful tick that found orders is the strongest "sync ok" signal,
  // independently of whether placedAt was extractable.
  const observabilitySet: Record<string, unknown> = {
    lastSyncStatus: "ok",
    errorCount: 0,
    lastError: null,
  };
  if (enqueued > 0 || duplicates > 0) {
    // Bump `lastImportAt` only when we observed orders this tick. The
    // ingest pipeline ALSO bumps it on each successful Order.create,
    // but the polling worker stamps a "the sync engine is working"
    // marker here so an empty-batch tick still moves the watermark for
    // dashboards that gate on this field.
    observabilitySet.lastImportAt = new Date();
  }
  if (newestPlacedAt && (!since || newestPlacedAt > since)) {
    observabilitySet.lastSyncedAt = newestPlacedAt;
  }
  await Integration.updateOne(
    { _id: integration._id },
    { $set: observabilitySet },
  ).catch(() => {});

  return { enqueued, duplicates, failed: 0 };
}

/**
 * Scan every active polling integration and sync each in turn.
 * Sequential rather than parallel — keeps each upstream's load bounded
 * to one outbound call per tick and avoids fan-out on a Mongo aggregate
 * that pulls every active row at once.
 */
export async function runOrderSyncOnce(
  options: RunOrderSyncOnceOptions = {},
): Promise<OrderSyncTickResult> {
  const filter = options.integrationFilter ?? {
    status: "connected",
    provider: { $in: POLLED_PROVIDERS },
  };
  const cursor: any = (Integration.find(filter as any) as any)
    .select("_id")
    .lean()
    .cursor();
  let scanned = 0;
  let enqueued = 0;
  let duplicates = 0;
  let failed = 0;
  for await (const row of cursor as AsyncIterable<{ _id: Types.ObjectId }>) {
    scanned += 1;
    const result = await syncOneIntegration(row._id, options);
    enqueued += result.enqueued;
    duplicates += result.duplicates;
    failed += result.failed;
  }
  return { scanned, enqueued, duplicates, failed };
}

export function registerOrderSyncWorker() {
  return registerWorker(
    QUEUE_NAMES.orderSync,
    async (job: any) => {
      const res = await runOrderSyncOnce();
      if (res.scanned > 0) {
        console.log(
          `[order-sync] job=${job.id} scanned=${res.scanned} enqueued=${res.enqueued} duplicates=${res.duplicates} failed=${res.failed}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

/**
 * Schedule the repeatable sweep. Mirror of the webhook-retry pattern —
 * one repeatable job per process, idempotent on re-schedule. Disabled
 * cleanly when `intervalMs <= 0` so dev/test boots can opt out.
 */
export async function scheduleOrderSync(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[order-sync] disabled (intervalMs<=0)");
    return;
  }
  const q: any = getQueue(QUEUE_NAMES.orderSync);
  const repeatables: any[] = await q.getRepeatableJobs();
  await Promise.all(
    repeatables
      .filter((r: any) => r.name === REPEAT_JOB_NAME)
      .map((r: any) => q.removeRepeatableByKey(r.key)),
  );
  await q.add(
    REPEAT_JOB_NAME,
    {},
    {
      repeat: { every: intervalMs },
      jobId: REPEAT_JOB_NAME,
    },
  );
  console.log(`[order-sync] scheduled every ${intervalMs}ms`);
}
