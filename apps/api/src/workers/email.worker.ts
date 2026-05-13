import type { Job } from "bullmq";
import { env } from "../env.js";
import { QUEUE_NAMES, registerWorker, safeEnqueue } from "../lib/queue.js";
import { sendEmail } from "../lib/email.js";

/**
 * Reliable transactional-email outbound.
 *
 * Replaces the previous `void sendEmail(...)` fire-and-forget pattern with
 * a BullMQ job. Five attempts on exponential backoff (5s, 10s, 20s, 40s,
 * 80s — ~155s total) before a final failure. A Redis outage at enqueue
 * time falls through `safeEnqueue` to a `PendingJob` row that the generic
 * replay sweeper picks up once Redis is healthy — so the only way to
 * actually lose an email is for BOTH Redis AND Mongo to be down at
 * enqueue time AND for Resend to keep refusing throughout the retry
 * window. The transactional surface no longer drops mail on a 30-second
 * provider blip.
 *
 * Idempotency: `jobId = email:<correlationId>`. Re-enqueueing the same
 * logical send (signup spam-clicks "resend verify", a Stripe webhook
 * replay) collapses on BullMQ's jobId uniqueness — no duplicate Resend
 * call, no duplicate inbox entry within the retention window.
 *
 * Dev fallback: when `REDIS_URL` is unset (typical local), `enqueueEmail`
 * calls `sendEmail` inline so the existing dev-stdout log path keeps
 * surfacing verify / reset links during local signup. Production has
 * `REDIS_URL` required by the env schema so the inline path is
 * unreachable there.
 *
 * Templates are PRE-RENDERED at the callsite (`buildVerifyEmail` etc.)
 * and passed in as plain `subject`/`html`/`text`. The worker does not
 * touch branding or templates — it is purely a delivery wrapper.
 */

const EMAIL_JOB_OPTS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { count: 500, age: 24 * 3600 },
  removeOnFail: { count: 1_000, age: 7 * 24 * 3600 },
};

export interface EmailJobData {
  /** Stable per-logical-send key. Same value across retries; same value
   *  across re-enqueues of the same logical send. Used as `jobId` for
   *  BullMQ-level dedupe. */
  correlationId: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  tag?: string;
}

export interface EmailJobResult {
  ok: boolean;
  providerId?: string;
  skipped?: boolean;
}

export interface EnqueueEmailArgs {
  correlationId: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  tag?: string;
}

export type EnqueueEmailMode =
  | "queued"
  | "inline"
  | "dead_lettered"
  | "failed";

export interface EnqueueEmailResult {
  /** True when the send is durably accepted (BullMQ or PendingJob). False
   *  for the dev inline path (where success or failure is synchronous)
   *  and for catastrophic Redis+Mongo outage. */
  enqueued: boolean;
  mode: EnqueueEmailMode;
  jobId?: string;
  pendingJobId?: string;
  error?: string;
}

/** Mask the local-part for log lines so transcripts don't leak full
 *  inboxes. First 2 chars + `***` + `@domain`. */
function maskEmail(addr: string): string {
  const at = addr.indexOf("@");
  if (at <= 0) return "***";
  return `${addr.slice(0, Math.min(2, at))}***${addr.slice(at)}`;
}

/**
 * Enqueue a pre-rendered transactional email for resilient delivery.
 *
 * Returns synchronously (~5–20ms typical) after the job is on BullMQ or
 * dead-lettered to Mongo. Callers wrap in `await` — the response no
 * longer blocks on Resend HTTP latency.
 *
 * `correlationId` is the single most important parameter — it MUST be
 * stable per logical send so BullMQ can dedupe re-enqueues. Construct it
 * from durable IDs already in scope (merchantId + token-hash prefix,
 * Stripe eventId, payment doc id, etc.). Never use random / now() —
 * that defeats the dedupe.
 */
export async function enqueueEmail(
  args: EnqueueEmailArgs,
): Promise<EnqueueEmailResult> {
  // Dev fallback — no Redis means no BullMQ. Send inline so the existing
  // stdout-only dev mode in `sendEmail` still surfaces the verify and
  // reset URLs for local signup testing. Production enforces REDIS_URL
  // via the env schema, so this branch is unreachable there.
  if (!env.REDIS_URL) {
    const result = await sendEmail({
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      tag: args.tag,
    });
    return {
      enqueued: false,
      mode: "inline",
      error: result.ok ? undefined : result.error,
    };
  }

  const payload: EmailJobData = {
    correlationId: args.correlationId,
    to: args.to,
    subject: args.subject,
    html: args.html,
    text: args.text,
    tag: args.tag,
  };

  const result = await safeEnqueue(
    QUEUE_NAMES.email,
    args.tag ?? "send-email",
    payload,
    {
      ...EMAIL_JOB_OPTS,
      jobId: `email:${args.correlationId}`,
    },
    {
      description: `email:${args.tag ?? "untagged"}`,
      // Email sends cross merchant boundaries (admin alerts span all
      // ops staff; trial reminders aren't merchant-action-triggered).
      // Opt out of per-merchant token-bucket fairness — a busy day on
      // one merchant should not throttle dunning for another.
      enforceMerchantQuota: false,
    },
  );

  if (!result.ok) {
    console.error(
      JSON.stringify({
        evt: "email.enqueue_failed",
        cid: args.correlationId,
        tag: args.tag,
        to: maskEmail(args.to),
        error: result.error,
      }),
    );
    return { enqueued: false, mode: "failed", error: result.error };
  }
  if ("deadLettered" in result) {
    console.warn(
      JSON.stringify({
        evt: "email.dead_lettered",
        cid: args.correlationId,
        tag: args.tag,
        to: maskEmail(args.to),
        pendingJobId: result.pendingJobId,
      }),
    );
    return {
      enqueued: true,
      mode: "dead_lettered",
      pendingJobId: result.pendingJobId,
    };
  }
  return { enqueued: true, mode: "queued", jobId: result.jobId };
}

async function processEmailJob(data: EmailJobData): Promise<EmailJobResult> {
  const result = await sendEmail({
    to: data.to,
    subject: data.subject,
    html: data.html,
    text: data.text,
    tag: data.tag,
  });
  if (!result.ok) {
    // Throw — BullMQ counts the attempt and re-enqueues per
    // EMAIL_JOB_OPTS.backoff. Resend 5xx and network errors funnel here.
    throw new Error(result.error ?? "resend_unknown");
  }
  return {
    ok: true,
    providerId: result.id,
    skipped: result.skipped,
  };
}

export function registerEmailWorker() {
  const worker = registerWorker<EmailJobData, EmailJobResult>(
    QUEUE_NAMES.email,
    async (job: Job<EmailJobData>) => {
      const data = job.data;
      const startMs = Date.now();
      const attempt = (job.attemptsMade ?? 0) + 1;
      const result = await processEmailJob(data);
      console.log(
        JSON.stringify({
          evt: "email.sent",
          cid: data.correlationId,
          tag: data.tag,
          providerId: result.providerId,
          skipped: result.skipped ?? false,
          attempt,
          durMs: Date.now() - startMs,
        }),
      );
      return result;
    },
    { concurrency: 4 },
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? EMAIL_JOB_OPTS.attempts;
    const attemptsMade = job.attemptsMade ?? 0;
    const exhausted = attemptsMade >= attempts;
    const data = job.data ?? ({} as Partial<EmailJobData>);
    console.warn(
      JSON.stringify({
        evt: exhausted ? "email.failed_final" : "email.retry",
        cid: data.correlationId,
        tag: data.tag,
        to: data.to ? maskEmail(data.to) : undefined,
        attempt: attemptsMade,
        max: attempts,
        error: err.message?.slice(0, 500),
      }),
    );
  });

  return worker;
}

export const __TEST = { EMAIL_JOB_OPTS };
