import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bullJobId } from "../src/lib/queue-ids.js";

/**
 * Real BullMQ 5.x against a real Redis — no mocks. Runs only when
 * BULLMQ_IT_REDIS_URL points at a DISPOSABLE Redis (it flushes the db);
 * skipped otherwise. The queue unit tests elsewhere mock BullMQ, which is
 * how "Custom Id cannot contain :" reached production unnoticed.
 *
 *   BULLMQ_IT_REDIS_URL=redis://:pass@127.0.0.1:16391/0 npx vitest run tests/bullmq-redis.integration.test.ts
 */
const url = process.env.BULLMQ_IT_REDIS_URL;

describe.skipIf(!url)("BullMQ + real Redis", () => {
  let conn: Redis;
  const name = `it-${randomUUID().slice(0, 8)}`;
  let queue: Queue;
  let events: QueueEvents;

  beforeAll(async () => {
    conn = new Redis(url!, { maxRetriesPerRequest: null });
    await conn.flushdb();
    queue = new Queue(name, { connection: conn });
    events = new QueueEvents(name, { connection: new Redis(url!, { maxRetriesPerRequest: null }) });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await events?.close();
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close();
    await conn?.flushdb();
    await conn?.quit();
  });

  it("rejects the legacy id format exactly as production did", async () => {
    await expect(queue.add("x", {}, { jobId: `auto-book:${new Types.ObjectId()}` })).rejects.toThrow("Custom Id cannot contain :");
  });

  it("accepts the new id, processes the job, and dedupes a second add", async () => {
    const jobId = bullJobId("email", `verify:${new Types.ObjectId()}:0123456789ab`);
    const a = await queue.add("send", { n: 1 }, { jobId });
    const b = await queue.add("send", { n: 2 }, { jobId }); // same logical job
    expect(a.id).toBe(jobId);
    expect(b.id).toBe(jobId);
    expect((await queue.getJobCounts("waiting")).waiting).toBe(1);

    let calls = 0;
    const worker = new Worker(name, async (job) => {
      calls++;
      return { got: (job.data as { n: number }).n };
    }, { connection: new Redis(url!, { maxRetriesPerRequest: null }) });
    const job = await queue.getJob(jobId);
    const result = await job!.waitUntilFinished(events, 15_000);
    await worker.close();
    expect(result).toEqual({ got: 1 }); // first add won; second was a no-op
    expect(calls).toBe(1);
  });

  it("retries a failing job and completes on the next attempt", async () => {
    const jobId = bullJobId("auto-book", new Types.ObjectId().toHexString());
    let calls = 0;
    const worker = new Worker(name, async () => {
      calls++;
      if (calls === 1) throw new Error("transient courier 503");
      return "booked";
    }, { connection: new Redis(url!, { maxRetriesPerRequest: null }) });
    const job = await queue.add("book", {}, { jobId, attempts: 3, backoff: { type: "fixed", delay: 100 } });
    const result = await job.waitUntilFinished(events, 15_000);
    await worker.close();
    expect(result).toBe("booked");
    expect(calls).toBe(2);
    const done = await queue.getJob(jobId);
    expect(done!.attemptsMade).toBe(2);
  });

  it("existing repeatable keys (3-part, e.g. 'tracking-sync:repeat') stay valid — left unchanged on purpose", async () => {
    await queue.add("sweep", {}, { jobId: "it-sync:repeat", repeat: { every: 60_000 } });
    const repeatables = await queue.getRepeatableJobs();
    expect(repeatables.length).toBeGreaterThanOrEqual(1);
    for (const r of repeatables) await queue.removeRepeatableByKey(r.key);
  });
});

describe.skipIf(!url)("app enqueue path + real Redis (safeEnqueue, no dead letters)", () => {
  beforeAll(async () => {
    const { ensureDb, resetDb } = await import("./helpers.js");
    await ensureDb();
    await resetDb();
    process.env.REDIS_URL = url;
    vi.resetModules(); // re-evaluate env.ts / queue.ts with REDIS_URL set
  });

  afterAll(async () => {
    const q = await import("../src/lib/queue.js");
    for (const n of [q.QUEUE_NAMES.automationBook, q.QUEUE_NAMES.email]) {
      await q.getQueue(n).obliterate({ force: true }).catch(() => {});
    }
    await q.shutdownQueues();
    delete process.env.REDIS_URL;
    const { disconnectDb } = await import("./helpers.js");
    await disconnectDb();
  });

  it("enqueueAutoBook lands one job per order on real BullMQ and writes no PendingJob", async () => {
    const { enqueueAutoBook } = await import("../src/workers/automationBook.js");
    const { getQueue, QUEUE_NAMES } = await import("../src/lib/queue.js");
    const { PendingJob } = await import("@ecom/db");
    const orderId = new Types.ObjectId().toHexString();
    const data = { orderId, merchantId: new Types.ObjectId().toHexString(), userId: "u" };
    await enqueueAutoBook(data);
    await enqueueAutoBook(data); // duplicate trigger for the same order
    const q = getQueue(QUEUE_NAMES.automationBook);
    const job = await q.getJob(`auto-book-${orderId}`);
    expect(job?.id).toBe(`auto-book-${orderId}`);
    const all = await q.getJobs(["waiting", "delayed", "active", "prioritized"]);
    expect(all.filter((j) => (j.data as { orderId?: string }).orderId === orderId)).toHaveLength(1);
    expect(await PendingJob.countDocuments({})).toBe(0);
  });

  it("enqueueEmail (verification) is queued, not dead-lettered", async () => {
    const { enqueueEmail } = await import("../src/workers/email.worker.js");
    const { getQueue, QUEUE_NAMES } = await import("../src/lib/queue.js");
    const { PendingJob } = await import("@ecom/db");
    const m = new Types.ObjectId().toHexString();
    const r = await enqueueEmail({ correlationId: `verify:${m}:0123456789ab`, to: "a@b.test", subject: "s", html: "<p/>", tag: "verify_email" });
    expect(r).toMatchObject({ enqueued: true, mode: "queued" });
    expect((await getQueue(QUEUE_NAMES.email).getJob(`email-verify_${m}_0123456789ab`))?.id).toBeTruthy();
    expect(await PendingJob.countDocuments({})).toBe(0);
  });
});
