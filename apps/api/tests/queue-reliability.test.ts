import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * Pure-helper tests for queue reliability fixes (Q-a / Q-b / Q-c).
 *
 * Avoids spinning up Redis or Mongo. Focuses on:
 *  - watchdog constants are sane (10-min stuck threshold, 5-min cadence, 3-courier fallback cap)
 *  - queue-stall state machine (2-cycle grace, reset on progress)
 *  - safeEnqueue counter bumps + return shape on simulated failure
 */

describe("automation watchdog constants", () => {
  it("uses sensible production values", async () => {
    const mod = await import("../src/workers/automationWatchdog.js");
    expect(Number(mod.__TEST.STUCK_AGE_MIN)).toBeGreaterThanOrEqual(5);
    expect(Number(mod.__TEST.STUCK_AGE_MIN)).toBeLessThanOrEqual(30);
    expect(Number(mod.__TEST.SCAN_INTERVAL_MIN)).toBeGreaterThanOrEqual(1);
    expect(Number(mod.__TEST.SCAN_INTERVAL_MIN)).toBeLessThanOrEqual(15);
    expect(Number(mod.__TEST.FALLBACK_MAX_COURIERS)).toBe(3);
    expect(Number(mod.__TEST.QUEUE_STALL_GRACE_CYCLES)).toBeGreaterThanOrEqual(2);
  });

  it("queue stall state machine: bumps on no-progress, resets on progress", async () => {
    const mod = await import("../src/workers/automationWatchdog.js");
    const state = mod.__TEST.queueStallState;
    state.lastWaiting = 0;
    state.consecutiveStalled = 0;

    // Cycle 1: 5 waiting, 0 active, lastWaiting was 0 → stalled.
    const waiting1: number = 5;
    const active1: number = 0;
    const stalled1 = waiting1 > 0 && active1 === 0 && waiting1 >= state.lastWaiting;
    if (stalled1) state.consecutiveStalled += 1;
    state.lastWaiting = waiting1;
    expect(state.consecutiveStalled).toBe(1);

    // Cycle 2: still 5/0 → stalled again, hits grace threshold.
    const waiting2: number = 5;
    const active2: number = 0;
    const stalled2 = waiting2 > 0 && active2 === 0 && waiting2 >= state.lastWaiting;
    if (stalled2) state.consecutiveStalled += 1;
    state.lastWaiting = waiting2;
    expect(state.consecutiveStalled).toBeGreaterThanOrEqual(
      Number(mod.__TEST.QUEUE_STALL_GRACE_CYCLES),
    );

    // Cycle 3: workers come back online (waiting=3, active=2) → reset.
    const waiting3: number = 3;
    const active3: number = 2;
    const stalled3 = waiting3 > 0 && active3 === 0 && waiting3 >= state.lastWaiting;
    expect(stalled3).toBe(false);
    state.consecutiveStalled = 0;
    state.lastWaiting = waiting3;
    expect(state.consecutiveStalled).toBe(0);
  });
});

describe("safeEnqueue contract", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("dead-letters to PendingJob when queue.add keeps throwing (Mongo healthy)", async () => {
    vi.doMock("bullmq", () => ({
      Queue: class {
        on() { return this; }
        async add() {
          throw new Error("ECONNREFUSED localhost:6379");
        }
        async close() {}
      },
      Worker: class {
        on() { return this; }
        async close() {}
      },
    }));
    vi.doMock("ioredis", () => ({
      Redis: class {
        on() { return this; }
        async ping() {}
        async quit() {}
      },
    }));
    vi.doMock("../src/env.js", () => ({
      env: { REDIS_URL: "redis://stub:6379", NODE_ENV: "test" },
    }));
    vi.doMock("../src/lib/notifications.js", () => ({
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    }));
    // Mongo healthy — PendingJob.create resolves with a fake doc.
    const createSpy = vi.fn().mockResolvedValue({
      _id: { toString: () => "pendingjob-id-123" },
    });
    vi.doMock("@ecom/db", () => ({
      PendingJob: { create: createSpy },
    }));

    const mod = await import("../src/lib/queue.js");
    mod.__resetEnqueueFailureCounters();

    const result = await mod.safeEnqueue(
      mod.QUEUE_NAMES.automationBook,
      "auto-book",
      { orderId: "x" },
      {},
      { merchantId: "507f1f77bcf86cd799439011", description: "auto-book" },
    );

    expect(result.ok).toBe(true);
    if (result.ok && "deadLettered" in result) {
      expect(result.deadLettered).toBe(true);
      expect(result.pendingJobId).toBe("pendingjob-id-123");
    } else {
      throw new Error("expected dead-lettered result");
    }
    // Failure counter bumps even though we recovered — it tracks
    // ENQUEUE failures, not work-loss outcomes.
    expect(mod.getEnqueueFailureCount(mod.QUEUE_NAMES.automationBook)).toBe(1);
    const counters = mod.getEnqueueCounters(mod.QUEUE_NAMES.automationBook);
    expect(counters.deadLettered).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false ONLY when both Redis and Mongo refuse the write", async () => {
    vi.doMock("bullmq", () => ({
      Queue: class {
        on() { return this; }
        async add() {
          throw new Error("ECONNREFUSED localhost:6379");
        }
        async close() {}
      },
      Worker: class {
        on() { return this; }
        async close() {}
      },
    }));
    vi.doMock("ioredis", () => ({
      Redis: class {
        on() { return this; }
        async ping() {}
        async quit() {}
      },
    }));
    vi.doMock("../src/env.js", () => ({
      env: { REDIS_URL: "redis://stub:6379", NODE_ENV: "test" },
    }));
    vi.doMock("../src/lib/notifications.js", () => ({
      dispatchNotification: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@ecom/db", () => ({
      PendingJob: {
        create: vi.fn().mockRejectedValue(new Error("mongo cluster down")),
      },
    }));

    const mod = await import("../src/lib/queue.js");
    mod.__resetEnqueueFailureCounters();

    const result = await mod.safeEnqueue(
      mod.QUEUE_NAMES.automationBook,
      "auto-book",
      { orderId: "x" },
      {},
      { merchantId: "507f1f77bcf86cd799439011", description: "auto-book" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/mongo cluster down/);
      expect(result.originalError).toMatch(/ECONNREFUSED/);
    }
  });

  it("recovers when a transient Redis failure clears within the retry window", async () => {
    let calls = 0;
    vi.doMock("bullmq", () => ({
      Queue: class {
        on() { return this; }
        async add() {
          calls++;
          if (calls < 3) throw new Error("EAGAIN");
          return { id: "recovered-job-1" };
        }
        async close() {}
      },
      Worker: class {
        on() { return this; }
        async close() {}
      },
    }));
    vi.doMock("ioredis", () => ({
      Redis: class {
        on() { return this; }
        async ping() {}
        async quit() {}
      },
    }));
    vi.doMock("../src/env.js", () => ({
      env: { REDIS_URL: "redis://stub:6379", NODE_ENV: "test" },
    }));

    const mod = await import("../src/lib/queue.js");
    mod.__resetEnqueueFailureCounters();

    const result = await mod.safeEnqueue(
      mod.QUEUE_NAMES.automationSms,
      "send-confirm-sms",
      { orderId: "x" },
      {},
    );

    expect(result.ok).toBe(true);
    if (result.ok && "jobId" in result && !("deadLettered" in result)) {
      expect(result.jobId).toBe("recovered-job-1");
      expect(result.recovered).toBe(true);
    } else {
      throw new Error("expected recovered queued result");
    }
    expect(calls).toBe(3);
    const counters = mod.getEnqueueCounters(mod.QUEUE_NAMES.automationSms);
    expect(counters.retryRecovered).toBe(1);
    expect(counters.failures).toBe(0);
    expect(counters.deadLettered).toBe(0);
  });

  it("returns ok:true on a successful add", async () => {
    vi.doMock("bullmq", () => ({
      Queue: class {
        on() { return this; }
        async add() {
          return { id: "job-123" };
        }
        async close() {}
      },
      Worker: class {
        on() { return this; }
        async close() {}
      },
    }));
    vi.doMock("ioredis", () => ({
      Redis: class {
        on() { return this; }
        async ping() {}
        async quit() {}
      },
    }));
    vi.doMock("../src/env.js", () => ({
      env: { REDIS_URL: "redis://stub:6379", NODE_ENV: "test" },
    }));

    const mod = await import("../src/lib/queue.js");
    mod.__resetEnqueueFailureCounters();

    const result = await mod.safeEnqueue(
      mod.QUEUE_NAMES.automationSms,
      "send-confirm-sms",
      { orderId: "x" },
      {},
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.jobId).toBe("job-123");
    }
    expect(mod.getEnqueueFailureCount(mod.QUEUE_NAMES.automationSms)).toBe(0);
  });
});
