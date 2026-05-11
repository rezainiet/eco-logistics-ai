import { env } from "../env.js";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { runCustomerPiiRetentionSweep } from "../lib/retention/customerPiiSweep.js";

/**
 * Customer-PII retention sweep worker. Daily by default.
 *
 * The library function (`runCustomerPiiRetentionSweep`) is what tests
 * exercise; this file is the thin BullMQ wrapper. See
 * apps/api/CLAUDE.md § "Library functions vs worker wrappers".
 */
const REPEAT_JOB_NAME = "customer-data-retention:sweep";

export function registerCustomerDataRetentionWorker() {
  return registerWorker(
    QUEUE_NAMES.customerDataRetention,
    async (job: { id?: string }) => {
      const result = await runCustomerPiiRetentionSweep({
        retentionDays: env.CUSTOMER_DATA_RETENTION_DAYS,
      });
      console.log(
        JSON.stringify({
          evt: "customer_data_retention.swept",
          jobId: job.id,
          ...result,
        }),
      );
      return result;
    },
    { concurrency: 1 },
  );
}

export async function scheduleCustomerDataRetention(
  intervalMs: number = env.CUSTOMER_DATA_RETENTION_INTERVAL_MIN * 60_000,
): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[customer-data-retention] disabled (intervalMs<=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.customerDataRetention) as unknown as {
    getRepeatableJobs: () => Promise<Array<{ name: string; key: string }>>;
    removeRepeatableByKey: (key: string) => Promise<unknown>;
    add: (
      name: string,
      data: unknown,
      opts: { repeat: { every: number }; jobId: string },
    ) => Promise<unknown>;
  };
  const repeatables = await q.getRepeatableJobs();
  await Promise.all(
    repeatables
      .filter((r) => r.name === REPEAT_JOB_NAME)
      .map((r) => q.removeRepeatableByKey(r.key)),
  );
  await q.add(
    REPEAT_JOB_NAME,
    {},
    { repeat: { every: intervalMs }, jobId: REPEAT_JOB_NAME },
  );
  console.log(
    `[customer-data-retention] scheduled every ${intervalMs}ms (retention=${env.CUSTOMER_DATA_RETENTION_DAYS}d)`,
  );
}
