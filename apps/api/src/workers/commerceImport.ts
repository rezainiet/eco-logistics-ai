import type { Job } from "bullmq";
import { Types } from "mongoose";
import { ImportJob, Integration, type IntegrationProvider } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { adapterFor, hasAdapter } from "../lib/integrations/index.js";
import { decryptSecret } from "../lib/crypto.js";
import { ingestNormalizedOrder } from "../server/ingest.js";
import type { IntegrationCredentials } from "../lib/integrations/types.js";

/**
 * Commerce-import worker.
 *
 * Replaces the synchronous loop that used to live inside `integrations.
 * importOrders`. The mutation now creates an `ImportJob` row and returns
 * immediately; this worker pulls from the upstream adapter, then ingests
 * each order with incremental progress writes so the dashboard's polling UI
 * shows the bar move.
 *
 * Resumable behavior is intentionally NOT modeled — adapters today only
 * support "fetch the most recent N", so a retried job restarts from scratch.
 * If a partial write succeeded, the WebhookInbox / Order idempotency indexes
 * dedupe so we never double-create.
 */

const PROGRESS_BATCH = 5;

export interface CommerceImportJobData {
  importJobId: string;
}

export interface CommerceImportJobResult {
  imported: number;
  duplicates: number;
  failed: number;
  scanned: number;
}

function decryptCreds(stored: Record<string, unknown> | null | undefined): IntegrationCredentials {
  const s = (stored ?? {}) as Record<string, string | null | undefined>;
  const out: IntegrationCredentials = {};
  const tryDecrypt = (v: string | null | undefined): string | undefined => {
    if (!v) return undefined;
    try {
      return decryptSecret(v);
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
  return out;
}

export async function processCommerceImport(
  data: CommerceImportJobData,
): Promise<CommerceImportJobResult> {
  if (!Types.ObjectId.isValid(data.importJobId)) {
    return { imported: 0, duplicates: 0, failed: 0, scanned: 0 };
  }
  const jobId = new Types.ObjectId(data.importJobId);
  const jobRow = await ImportJob.findById(jobId);
  if (!jobRow) return { imported: 0, duplicates: 0, failed: 0, scanned: 0 };
  if (jobRow.status === "succeeded" || jobRow.status === "failed" || jobRow.status === "cancelled") {
    return {
      imported: jobRow.importedRows,
      duplicates: jobRow.duplicateRows,
      failed: jobRow.failedRows,
      scanned: jobRow.processedRows,
    };
  }

  jobRow.status = "running";
  jobRow.startedAt = jobRow.startedAt ?? new Date();
  await jobRow.save();

  const integration = await Integration.findById(jobRow.integrationId);
  if (!integration || !hasAdapter(integration.provider as IntegrationProvider)) {
    jobRow.status = "failed";
    jobRow.lastError = integration ? "no adapter for provider" : "integration not found";
    jobRow.finishedAt = new Date();
    await jobRow.save();
    return { imported: 0, duplicates: 0, failed: 0, scanned: 0 };
  }

  const adapter = adapterFor(integration.provider as IntegrationProvider);
  const creds = decryptCreds(integration.credentials ?? {});
  const limit = Math.max(1, Math.min(50, jobRow.requestedLimit || 25));
  const fetched = await adapter.fetchSampleOrders(creds, limit);

  if (!fetched.ok) {
    jobRow.status = "failed";
    jobRow.lastError = (fetched.error ?? "fetch failed").slice(0, 500);
    jobRow.finishedAt = new Date();
    await jobRow.save();
    return { imported: 0, duplicates: 0, failed: 0, scanned: 0 };
  }

  jobRow.totalRows = fetched.sample.length;
  await jobRow.save();

  let imported = 0;
  let duplicates = 0;
  let failed = 0;
  let processed = 0;
  let firstError: string | undefined;

  for (const normalized of fetched.sample) {
    processed += 1;
    try {
      const result = await ingestNormalizedOrder(normalized, {
        merchantId: integration.merchantId as Types.ObjectId,
        integrationId: integration._id,
        source: integration.provider as "shopify" | "woocommerce" | "custom_api",
        channel: "api",
      });
      if (!result.ok) {
        failed += 1;
        firstError = firstError ?? result.error;
      } else if (result.duplicate) {
        duplicates += 1;
      } else {
        imported += 1;
      }
    } catch (err) {
      failed += 1;
      firstError = firstError ?? (err as Error).message;
    }

    // Flush progress every PROGRESS_BATCH rows or on the final row so the
    // poll UI advances without thrashing Mongo on every write.
    if (processed % PROGRESS_BATCH === 0 || processed === fetched.sample.length) {
      await ImportJob.updateOne(
        { _id: jobRow._id },
        {
          $set: {
            processedRows: processed,
            importedRows: imported,
            duplicateRows: duplicates,
            failedRows: failed,
            ...(firstError ? { lastError: firstError.slice(0, 500) } : {}),
          },
        },
      );
    }
  }

  await Integration.updateOne(
    { _id: integration._id },
    { $set: { lastSyncAt: new Date() } },
  );

  jobRow.status = failed > 0 && imported === 0 ? "failed" : "succeeded";
  jobRow.finishedAt = new Date();
  jobRow.processedRows = processed;
  jobRow.importedRows = imported;
  jobRow.duplicateRows = duplicates;
  jobRow.failedRows = failed;
  if (firstError) jobRow.lastError = firstError.slice(0, 500);
  await jobRow.save();

  return { imported, duplicates, failed, scanned: processed };
}

export function registerCommerceImportWorker() {
  return registerWorker<CommerceImportJobData, CommerceImportJobResult>(
    QUEUE_NAMES.commerceImport,
    async (job: Job<CommerceImportJobData>) => {
      const res = await processCommerceImport(job.data);
      console.log(
        `[commerce-import] job=${job.id} imported=${res.imported} dup=${res.duplicates} failed=${res.failed} scanned=${res.scanned}`,
      );
      return res;
    },
    { concurrency: 2 },
  );
}

/**
 * Best-effort enqueue. Falls back to running the job synchronously when
 * Redis is unavailable (dev/test) so the merchant still gets results.
 */
export async function enqueueCommerceImport(
  data: CommerceImportJobData,
): Promise<void> {
  try {
    const q = getQueue(QUEUE_NAMES.commerceImport);
    await q.add("commerce-import:run", data, {
      jobId: `import:${data.importJobId}`,
      attempts: 1, // failures are tracked on the ImportJob row, not BullMQ
      removeOnComplete: { count: 200, age: 24 * 3600 },
      removeOnFail: { count: 500, age: 7 * 24 * 3600 },
    });
  } catch {
    void processCommerceImport(data).catch((err) =>
      console.error("[commerce-import] sync fallback failed", err),
    );
  }
}
