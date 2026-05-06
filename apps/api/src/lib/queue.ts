import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from "bullmq";
import { Redis } from "ioredis";
import { PendingJob } from "@ecom/db";
import { env } from "../env.js";
import {
  consumeMerchantTokens,
  DEFAULT_BUCKET_BUDGETS,
  type BucketConfig,
} from "./merchantRateLimit.js";

export const QUEUE_NAMES = {
  verifyOrder: "verify-order",
  tracking: "tracking-sync",
  risk: "risk-recompute",
  subscription: "subscription-sweep",
  fraudWeightTuning: "fraud-weight-tuning",
  webhookProcess: "webhook-process",
  webhookRetry: "webhook-retry",
  commerceImport: "commerce-import",
  cartRecovery: "cart-recovery",
  trialReminder: "trial-reminder",
  subscriptionGrace: "subscription-grace",
  automationBook: "automation-book",
  automationWatchdog: "automation-watchdog",
  automationSms: "automation-sms",
  automationStale: "automation-stale",
  awbReconcile: "awb-reconcile",
  /** Polling fallback for upstream order sync — runs alongside webhooks. */
  orderSync: "order-sync",
  /** DLQ replay sweeper — drains PendingJob rows back onto BullMQ. */
  pendingJobReplay: "pending-job-replay",
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
  // Queue-wait-time observability. `active` fires when a worker picks a job
  // off the queue; the difference between job.processedOn (pickup) and
  // job.timestamp (enqueue) is real wall-clock backlog latency. We only log
  // when waitMs crosses a threshold so steady-state throughput stays quiet —
  // anything over 5s on a transactional queue is a backlog signal worth
  // alerting on; tail spikes show up as outliers in the log stream.
  w.on("active", (job) => {
    if (!job) return;
    const waitMs = (job.processedOn ?? Date.now()) - job.timestamp;
    if (waitMs >= 5_000) {
      console.warn(
        JSON.stringify({
          evt: "queue.wait_time",
          queue: name,
          jobId: job.id,
          jobName: job.name,
          waitMs,
          attemptsMade: job.attemptsMade,
        }),
      );
    }
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


/**
 * Per-process counters for enqueue outcomes. Useful for ops dashboards
 * + tests. Reset on restart; aggregate via merchant Notification rows for
 * cross-process visibility.
 *
 *   failures        — final hard failure (Redis AND Mongo unreachable).
 *                     The only outcome where the caller's `ok: false`
 *                     means a job was actually dropped.
 *   retryRecovered  — Redis throw on attempt N, success on attempt N+1.
 *                     Indicates a flapping Redis worth investigating.
 *   deadLettered    — Redis was persistently unreachable; the job was
 *                     persisted to PendingJob for replay. From the
 *                     caller's perspective `ok: true` — the system has
 *                     guaranteed eventual delivery.
 *   replayed        — sweeper successfully drained a deadLettered row
 *                     back onto BullMQ.
 *   exhausted       — replay exceeded MAX_REPLAY_ATTEMPTS.
 */
type EnqueueCounter =
  | "failures"
  | "retryRecovered"
  | "deadLettered"
  | "replayed"
  | "exhausted";

const _counters: Record<EnqueueCounter, Map<string, number>> = {
  failures: new Map(),
  retryRecovered: new Map(),
  deadLettered: new Map(),
  replayed: new Map(),
  exhausted: new Map(),
};

function bump(counter: EnqueueCounter, queueName: string): void {
  _counters[counter].set(queueName, (_counters[counter].get(queueName) ?? 0) + 1);
}

export function getEnqueueFailureCount(queueName: QueueName): number {
  return _counters.failures.get(queueName) ?? 0;
}

export function getEnqueueCounters(queueName: QueueName): Record<EnqueueCounter, number> {
  return {
    failures: _counters.failures.get(queueName) ?? 0,
    retryRecovered: _counters.retryRecovered.get(queueName) ?? 0,
    deadLettered: _counters.deadLettered.get(queueName) ?? 0,
    replayed: _counters.replayed.get(queueName) ?? 0,
    exhausted: _counters.exhausted.get(queueName) ?? 0,
  };
}

/** Snapshot for the admin /system page — every queue's counters in one shot. */
export function snapshotEnqueueCounters(): Record<
  string,
  Record<EnqueueCounter, number>
> {
  const out: Record<string, Record<EnqueueCounter, number>> = {};
  const queueSet = new Set<string>();
  for (const map of Object.values(_counters)) {
    for (const k of map.keys()) queueSet.add(k);
  }
  for (const q of queueSet) {
    out[q] = {
      failures: _counters.failures.get(q) ?? 0,
      retryRecovered: _counters.retryRecovered.get(q) ?? 0,
      deadLettered: _counters.deadLettered.get(q) ?? 0,
      replayed: _counters.replayed.get(q) ?? 0,
      exhausted: _counters.exhausted.get(q) ?? 0,
    };
  }
  return out;
}

/** Test helper. Resets every in-memory enqueue counter. */
export function __resetEnqueueFailureCounters(): void {
  for (const map of Object.values(_counters)) map.clear();
}

/** Test-only hook: forces the next N enqueue attempts to throw. */
let _testFailNextAttempts = 0;
export function __testFailNextAttempts(n: number): void {
  _testFailNextAttempts = n;
}
function consumeTestFailure(): boolean {
  if (_testFailNextAttempts > 0) {
    _testFailNextAttempts--;
    return true;
  }
  return false;
}

/**
 * Sweeper-side counter hooks. The DLQ replay worker calls these so the
 * /admin/system snapshot stays coherent with the failure side. Kept as
 * loose `__bumpX` exports rather than re-exporting `bump` directly so
 * the public surface only exposes the snapshot reader.
 */
export function __bumpReplayed(queueName: QueueName): void {
  bump("replayed", queueName);
}
export function __bumpExhausted(queueName: QueueName): void {
  bump("exhausted", queueName);
}

export interface SafeEnqueueContext {
  /**
   * Merchant ObjectId hex string, when available. Notification fans out
   * to this merchant; required for SMS escalation. Anonymous (system)
   * enqueues — like the watchdog re-enqueueing across merchants — can
   * pass it per-job and we still notify scoped to the right merchant.
   */
  merchantId?: string;
  /** Optional order id for the notification body / dedupeKey. */
  orderId?: string;
  /** Short human label, e.g. "auto-book" or "confirmation SMS". */
  description?: string;
  /**
   * When true (and `merchantId` is set), the per-merchant token bucket is
   * consulted before the job hits the queue. On budget exhaustion the
   * caller gets `{ ok: false, error: "rate_limited" }` and the job is
   * either deferred (BullMQ `delay`) or dropped — no other merchant pays
   * for one merchant's burst.
   *
   * Defaults to true: most queues serve user-driven traffic and should be
   * fair across tenants. Set to false on system-internal sweeps (the
   * watchdog re-enqueues in batch and isn't billable to one merchant).
   */
  enforceMerchantQuota?: boolean;
  /** Override the default bucket config for this queue. */
  bucketConfig?: BucketConfig;
}

/**
 * `safeEnqueue` outcome. The discriminated union encodes the THREE distinct
 * states a caller might want to react to:
 *
 *   { ok: true, jobId }                       — Redis accepted on first try.
 *   { ok: true, jobId, recovered: true }      — Redis transient hiccup; one
 *                                                of the in-process retries
 *                                                succeeded. The job is on
 *                                                the queue, but the flap is
 *                                                worth investigating.
 *   { ok: true, deadLettered: true,           — Redis was persistently
 *     pendingJobId }                            unreachable; we persisted
 *                                                the job to Mongo. The
 *                                                replay sweeper will land it
 *                                                on BullMQ once Redis is
 *                                                healthy. From the caller's
 *                                                perspective, the work is
 *                                                ACCEPTED — not lost.
 *   { ok: false, error,                       — Catastrophic: BOTH Redis
 *     originalError? }                          AND Mongo are unreachable.
 *                                                The only state where the
 *                                                caller MUST take action.
 *
 * Callers wrap `safeEnqueue` in `void` are no longer at risk of silent loss:
 * the dead-letter is the safety net.
 */
export type SafeEnqueueResult =
  | { ok: true; jobId?: string; recovered?: boolean }
  | { ok: true; deadLettered: true; pendingJobId: string }
  | { ok: false; error: string; originalError?: string };

const REDIS_RETRY_DELAYS_MS = [50, 200, 500] as const;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function attemptEnqueue(
  queueName: QueueName,
  jobName: string,
  data: unknown,
  opts: JobsOptions,
): Promise<{ id?: string }> {
  if (consumeTestFailure()) {
    throw new Error("test_forced_enqueue_failure");
  }
  const queue = getQueue(queueName);
  const job = await queue.add(jobName, data, opts);
  return { id: job?.id };
}

/**
 * Enqueue with safety net.
 *
 * Pipeline:
 *   1. Per-merchant token bucket (fairness)
 *   2. Up to 3 attempts to land the job on Redis (50/200/500ms backoff).
 *      Most "Redis hiccup" transients clear inside ~750ms.
 *   3. If Redis is still rejecting, persist the job description to a
 *      Mongo-backed PendingJob row; the replay sweeper drains it later.
 *   4. If Mongo also rejects, return `ok: false` and fire the merchant
 *      alert. This is the only path that loses work — and it requires
 *      both the queue store AND the primary database to be down.
 *
 * The function NEVER throws — every failure path returns a `SafeEnqueueResult`
 * with a stable shape.
 */
export async function safeEnqueue(
  queueName: QueueName,
  jobName: string,
  data: unknown,
  opts: JobsOptions,
  ctx: SafeEnqueueContext = {},
): Promise<SafeEnqueueResult> {
  // Per-merchant fairness — only enforced when we have a merchantId AND the
  // caller hasn't opted out (system sweeps). The bucket fails open on Redis
  // outage, so this never makes a healthy queue worse on a bad infra day.
  if (ctx.merchantId && ctx.enforceMerchantQuota !== false) {
    const config =
      ctx.bucketConfig ??
      DEFAULT_BUCKET_BUDGETS[queueName] ??
      DEFAULT_BUCKET_BUDGETS.default!;
    const result = await consumeMerchantTokens(
      queueName,
      ctx.merchantId,
      config,
    );
    if (!result.allowed) {
      // Defer rather than drop — BullMQ's `delay` puts the job in the queue
      // with a future activation time, so it eventually runs without a
      // caller-side retry loop. Capped at 30s so a runaway merchant gets
      // throttled, not silently archived.
      const deferOpts: JobsOptions = {
        ...opts,
        delay: Math.min(30_000, Math.max(opts.delay ?? 0, result.retryAfterMs)),
      };
      const throttled = await tryWithBackoff(queueName, jobName, data, deferOpts);
      if (throttled.kind === "queued") {
        console.warn(
          JSON.stringify({
            evt: "queue.merchant_throttled",
            queue: queueName,
            merchantId: ctx.merchantId,
            retryAfterMs: result.retryAfterMs,
            remainingTokens: result.remaining,
            capacity: config.capacity,
            refillPerSecond: config.refillPerSecond,
            deferMs: deferOpts.delay,
            jobId: throttled.jobId,
            description: ctx.description,
            recovered: throttled.recovered,
          }),
        );
        return throttled.recovered
          ? { ok: true, jobId: throttled.jobId, recovered: true }
          : { ok: true, jobId: throttled.jobId };
      }
      // Redis still down even after merchant throttling; fall through to
      // the dead-letter path with the deferred opts intact.
      return safeEnqueueFailure(queueName, jobName, data, deferOpts, ctx, throttled.error);
    }
  }
  const attempt = await tryWithBackoff(queueName, jobName, data, opts);
  if (attempt.kind === "queued") {
    return attempt.recovered
      ? { ok: true, jobId: attempt.jobId, recovered: true }
      : { ok: true, jobId: attempt.jobId };
  }
  return safeEnqueueFailure(queueName, jobName, data, opts, ctx, attempt.error);
}

type EnqueueAttempt =
  | { kind: "queued"; jobId?: string; recovered: boolean }
  | { kind: "failed"; error: unknown };

async function tryWithBackoff(
  queueName: QueueName,
  jobName: string,
  data: unknown,
  opts: JobsOptions,
): Promise<EnqueueAttempt> {
  let lastErr: unknown = null;
  for (let i = 0; i < REDIS_RETRY_DELAYS_MS.length; i++) {
    try {
      const job = await attemptEnqueue(queueName, jobName, data, opts);
      const recovered = i > 0;
      if (recovered) bump("retryRecovered", queueName);
      return { kind: "queued", jobId: job.id, recovered };
    } catch (err) {
      lastErr = err;
      if (i < REDIS_RETRY_DELAYS_MS.length - 1) {
        await sleep(REDIS_RETRY_DELAYS_MS[i]!);
      }
    }
  }
  return { kind: "failed", error: lastErr };
}

/**
 * Dead-letter path. Persists the (queueName, jobName, data, opts, ctx)
 * tuple so the replay sweeper can retry once Redis recovers. Returns
 * `ok: true, deadLettered: true` from the caller's perspective —
 * eventual delivery is guaranteed by the sweeper.
 *
 * Falls through to a hard `ok: false` only when Mongo also refuses the
 * write (extremely rare; would require both Redis AND Mongo to be down).
 */
async function safeEnqueueFailure(
  queueName: QueueName,
  jobName: string,
  data: unknown,
  opts: JobsOptions,
  ctx: SafeEnqueueContext,
  err: unknown,
): Promise<SafeEnqueueResult> {
  const originalMessage = err instanceof Error ? err.message : String(err);
  bump("failures", queueName);
  console.error(
    JSON.stringify({
      evt: "queue.enqueue_failed",
      queue: queueName,
      job: jobName,
      merchantId: ctx.merchantId,
      orderId: ctx.orderId,
      description: ctx.description,
      error: originalMessage,
    }),
  );

  // Try to dead-letter to Mongo. The sweeper picks this up.
  let pendingJobId: string | null = null;
  let mongoErr: unknown = null;
  try {
    const doc = await PendingJob.create({
      queueName,
      jobName,
      data: serializePayload(data),
      jobOpts: serializePayload(opts),
      ctx: serializePayload({
        merchantId: ctx.merchantId,
        orderId: ctx.orderId,
        description: ctx.description,
      }),
      status: "pending",
      attempts: 0,
      lastError: originalMessage.slice(0, 1000),
      nextAttemptAt: new Date(Date.now() + 30_000),
    });
    pendingJobId = String(doc._id);
    bump("deadLettered", queueName);
    console.warn(
      JSON.stringify({
        evt: "queue.dead_lettered",
        queue: queueName,
        job: jobName,
        merchantId: ctx.merchantId,
        orderId: ctx.orderId,
        pendingJobId,
        error: originalMessage,
      }),
    );
  } catch (m) {
    mongoErr = m;
  }

  // Notify merchant — once per hour per (queue, merchant). The notification
  // body wording differs between dead-lettered (still going to run) and
  // hard-failed (lost) so an on-call merchant gets the right urgency cue.
  if (ctx.merchantId) {
    await emitFailureNotification(
      queueName,
      jobName,
      ctx,
      pendingJobId !== null ? "dead_lettered" : "hard_failed",
    ).catch((notifyErr) =>
      console.error(
        "[queue:safeEnqueue] notify failed:",
        (notifyErr as Error).message,
      ),
    );
  }

  if (pendingJobId !== null) {
    return { ok: true, deadLettered: true, pendingJobId };
  }

  // Both Redis AND Mongo unreachable. The caller's `ok: false` branch is
  // load-bearing here — no fallback storage available.
  const mongoMessage = mongoErr instanceof Error ? mongoErr.message : String(mongoErr);
  return {
    ok: false,
    error: `redis+mongo unavailable: ${mongoMessage}`,
    originalError: originalMessage,
  };
}

/**
 * Recursively scrubs ObjectId / Date / Buffer / function values so the
 * payload is a clean BSON-friendly tree. BullMQ already requires its
 * payload to be JSON-serializable, so this is mostly defensive — but
 * `Mixed` Mongo schemas accept anything, and we'd rather not store an
 * exotic shape that future readers can't make sense of.
 */
function serializePayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "function") return undefined;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(serializePayload);
  if (typeof value === "object") {
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializePayload(v);
    }
    return out;
  }
  return value;
}

async function emitFailureNotification(
  queueName: QueueName,
  jobName: string,
  ctx: SafeEnqueueContext,
  kind: "dead_lettered" | "hard_failed",
): Promise<void> {
  const { dispatchNotification } = await import("./notifications.js");
  const { Types } = await import("mongoose");
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  if (!ctx.merchantId) return;
  await dispatchNotification({
    merchantId: new Types.ObjectId(ctx.merchantId),
    kind: "queue.enqueue_failed",
    severity: "critical",
    title:
      kind === "dead_lettered"
        ? "Background job queue degraded"
        : "Background job storage unreachable",
    body:
      kind === "dead_lettered"
        ? `Could not immediately enqueue ${ctx.description ?? jobName}. The work has been saved and will run automatically when the queue recovers.`
        : `Could not enqueue ${ctx.description ?? jobName}, and the dead-letter store is also unreachable. Operations have been alerted; please retry the action shortly.`,
    dedupeKey: `queue_enqueue_failed:${queueName}:${ctx.merchantId}:${kind}:${hourBucket}`,
  });
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
