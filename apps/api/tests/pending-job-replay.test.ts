import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingJob } from "@ecom/db";
import { disconnectDb, resetDb } from "./helpers.js";

/**
 * DLQ replay sweeper integration tests. Uses the real Mongo connection
 * (PendingJob persists there) but stubs BullMQ so we control whether the
 * "queue" accepts or rejects each replay attempt.
 *
 * The mocking strategy mirrors `queue-reliability.test.ts` — vi.doMock
 * + vi.resetModules so each spec gets a clean queue.ts instance bound to
 * the test's bullmq stub.
 */

beforeEach(async () => {
  await resetDb();
  vi.resetModules();
});

afterAll(disconnectDb);

function stubEnv() {
  vi.doMock("../src/env.js", () => ({
    env: { REDIS_URL: "redis://stub:6379", NODE_ENV: "test" },
  }));
}

function stubRedis() {
  vi.doMock("ioredis", () => ({
    Redis: class {
      on() {
        return this;
      }
      async ping() {}
      async quit() {}
    },
  }));
}

function stubBullmq(addImpl: (() => Promise<{ id: string }>) | (() => never)) {
  vi.doMock("bullmq", () => ({
    Queue: class {
      on() {
        return this;
      }
      async add() {
        return await addImpl();
      }
      async close() {}
    },
    Worker: class {
      on() {
        return this;
      }
      async close() {}
    },
  }));
}

describe("pendingJobReplay sweeper", () => {
  it("replays a pending row onto the queue and deletes it on success", async () => {
    stubEnv();
    stubRedis();
    let acceptedJob: { name: string; data: unknown } | null = null;
    stubBullmq(async () => {
      // Capture the replay payload so we can assert it round-trips.
      acceptedJob = { name: "stand-in", data: null };
      return { id: "replayed-job-1" };
    });

    // Seed a row that's due for replay
    const seeded = await PendingJob.create({
      queueName: "automation-book",
      jobName: "auto-book",
      data: { orderId: "abc-123" },
      jobOpts: {},
      ctx: { merchantId: "507f1f77bcf86cd799439011", description: "auto-book" },
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1000),
    });

    const { sweepPendingJobs } = await import(
      "../src/workers/pendingJobReplay.js"
    );
    const result = await sweepPendingJobs(50);

    expect(result.picked).toBe(1);
    expect(result.replayed).toBe(1);
    expect(result.reFailed).toBe(0);
    expect(acceptedJob).not.toBeNull();
    const stillThere = await PendingJob.findById(seeded._id);
    expect(stillThere).toBeNull();
  });

  it("on failure, bumps attempts + applies exponential backoff", async () => {
    stubEnv();
    stubRedis();
    stubBullmq(async () => {
      throw new Error("ECONNREFUSED localhost:6379");
    });

    const seeded = await PendingJob.create({
      queueName: "automation-book",
      jobName: "auto-book",
      data: {},
      jobOpts: {},
      ctx: {},
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1000),
    });

    const { sweepPendingJobs } = await import(
      "../src/workers/pendingJobReplay.js"
    );
    const result = await sweepPendingJobs(50);

    expect(result.replayed).toBe(0);
    expect(result.reFailed).toBe(1);
    const after = await PendingJob.findById(seeded._id);
    expect(after).toBeTruthy();
    expect(after!.attempts).toBe(1);
    expect(after!.status).toBe("pending");
    expect(after!.lastError).toMatch(/ECONNREFUSED/);
    // 1-min backoff for attempt 1
    const delta = (after!.nextAttemptAt as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(50_000);
    expect(delta).toBeLessThan(70_000);
  });

  it("flips to exhausted after MAX_REPLAY_ATTEMPTS", async () => {
    stubEnv();
    stubRedis();
    stubBullmq(async () => {
      throw new Error("ECONNREFUSED");
    });

    // Seed at attempts = 4 — next failure is the 5th, which exhausts.
    const seeded = await PendingJob.create({
      queueName: "automation-book",
      jobName: "auto-book",
      data: {},
      jobOpts: {},
      ctx: { merchantId: "507f1f77bcf86cd799439011", description: "auto-book" },
      status: "pending",
      attempts: 4,
      nextAttemptAt: new Date(Date.now() - 1000),
    });

    // Mock dispatchNotification so the exhaust alert doesn't fail on missing wiring
    vi.doMock("../src/lib/notifications.js", () => ({
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    }));

    const { sweepPendingJobs } = await import(
      "../src/workers/pendingJobReplay.js"
    );
    const result = await sweepPendingJobs(50);

    expect(result.exhausted).toBe(1);
    const after = await PendingJob.findById(seeded._id);
    expect(after!.status).toBe("exhausted");
    expect(after!.attempts).toBe(5);
  });

  it("only picks rows whose nextAttemptAt has passed", async () => {
    stubEnv();
    stubRedis();
    stubBullmq(async () => ({ id: "j" }));

    // One due, one not due
    await PendingJob.create({
      queueName: "automation-book",
      jobName: "due",
      data: {},
      jobOpts: {},
      ctx: {},
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 5_000),
    });
    await PendingJob.create({
      queueName: "automation-book",
      jobName: "future",
      data: {},
      jobOpts: {},
      ctx: {},
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });

    const { sweepPendingJobs } = await import(
      "../src/workers/pendingJobReplay.js"
    );
    const result = await sweepPendingJobs(50);
    expect(result.picked).toBe(1);
    expect(result.replayed).toBe(1);
  });

  it("ignores exhausted rows on subsequent ticks", async () => {
    stubEnv();
    stubRedis();
    stubBullmq(async () => ({ id: "j" }));

    await PendingJob.create({
      queueName: "automation-book",
      jobName: "stuck",
      data: {},
      jobOpts: {},
      ctx: {},
      status: "exhausted",
      attempts: 5,
      nextAttemptAt: new Date(Date.now() - 1000),
    });

    const { sweepPendingJobs } = await import(
      "../src/workers/pendingJobReplay.js"
    );
    const result = await sweepPendingJobs(50);
    expect(result.picked).toBe(0);
    expect(result.replayed).toBe(0);
  });
});

describe("nextDeadline backoff schedule", () => {
  it("scales attempts 1-5 to bounded backoffs", async () => {
    const { __TEST } = await import("../src/workers/pendingJobReplay.js");
    const now = Date.now();
    const t1 = __TEST.nextDeadline(1).getTime() - now;
    const t5 = __TEST.nextDeadline(5).getTime() - now;
    const t99 = __TEST.nextDeadline(99).getTime() - now;
    expect(t1).toBeLessThan(__TEST.BACKOFF_BY_ATTEMPT_MS[1]!);
    expect(t5).toBeGreaterThan(__TEST.BACKOFF_BY_ATTEMPT_MS[3]!);
    // attempt > 5 saturates at the max bucket
    expect(t99).toBeGreaterThan(0);
    expect(t99).toBeLessThanOrEqual(__TEST.BACKOFF_BY_ATTEMPT_MS[4]! + 1);
  });
});
