import { Worker } from "bullmq";
import { runAnomalyDetection } from "../lib/anomaly.js";

/**
 * Anomaly-detection worker. Runs every 5 minutes via a repeatable job;
 * each tick runs every detector independently. We deliberately don't
 * wire this through `safeEnqueue` / merchant rate limits — alerts are
 * platform-level signals, not per-merchant.
 */

const ANOMALY_QUEUE = "anomaly-detection" as const;

export function startAnomalyWorker(connection: { connection: unknown }) {
  return new Worker(
    ANOMALY_QUEUE,
    async () => {
      const fired = await runAnomalyDetection();
      return { firedCount: fired.length, kinds: fired.map((f) => f.kind) };
    },
    { connection: connection.connection as never, concurrency: 1 },
  );
}

export const ANOMALY_QUEUE_NAME = ANOMALY_QUEUE;
