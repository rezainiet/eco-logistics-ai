import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env.js";

export const QUEUE_NAMES = {
  verifyOrder: "verify-order",
  tracking: "tracking-sync",
  risk: "risk-recompute",
  subscription: "subscription-sweep",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1_000, age: 24 * 3600 },
  removeOnFail: { count: 5_000, age: 7 * 24 * 3600 },
};

let _connection: Redis | null = null;
const _queues = new Map<QueueName, Queue>();
const _workers = new Map<QueueName, Worker>();

function connection(): Redis {
  if (_connection) return _connection;
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is required for BullMQ");
  }
  _connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  _connection.on("error", (err) => console.error("[queue] redis", err));
  return _connection;
}

export function getQueue(name: QueueName): Queue {
  const existing = _queues.get(name);
  if (existing) return existing;
  const q = new Queue(name, {
    connection: connection(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  q.on("error", (err) => console.error(`[queue:${name}]`, err));
  _queues.set(name, q);
  return q;
}

export function registerWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Processor<T, R>,
  opts: Partial<WorkerOptions> = {},
): Worker<T, R> {
  const existing = _workers.get(name) as Worker<T, R> | undefined;
  if (existing) return existing;
  const w = new Worker<T, R>(name, processor, {
    connection: connection(),
    concurrency: 4,
    ...opts,
  });
  w.on("failed", (job, err) =>
    console.error(`[worker:${name}] job ${job?.id} failed:`, err.message),
  );
  w.on("error", (err) => console.error(`[worker:${name}]`, err));
  _workers.set(name, w as Worker);
  return w;
}

export async function initQueues(): Promise<void> {
  if (!env.REDIS_URL) {
    if (env.NODE_ENV === "production") {
      throw new Error("REDIS_URL is required in production for BullMQ");
    }
    console.warn("[queue] REDIS_URL unset — queues disabled (dev only)");
    return;
  }
  const c = connection();
  await c.ping();
  for (const name of Object.values(QUEUE_NAMES)) getQueue(name);
  console.log("[queue] initialized:", Object.values(QUEUE_NAMES).join(", "));
}

export async function shutdownQueues(): Promise<void> {
  await Promise.all([...Array.from(_workers.values()).map((w) => w.close())]);
  await Promise.all(Array.from(_queues.values()).map((q) => q.close()));
  _workers.clear();
  _queues.clear();
  if (_connection) {
    await _connection.quit().catch(() => {});
    _connection = null;
  }
}
