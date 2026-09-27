import { Job } from "bullmq";
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bullJobId, isBullSafeJobId } from "../src/lib/queue-ids.js";

/**
 * Every custom BullMQ job id the app builds must pass BullMQ's OWN
 * validation. The check below runs the installed bullmq's
 * `Job.validateOptions` (the code that threw "Custom Id cannot contain :"
 * in production) — BullMQ itself is not mocked. Only the app's queue
 * wrapper is swapped for a recorder, so the enqueue functions can be
 * called without Redis and their real job ids captured.
 */

// A Job needs a queue-like object only for key helpers; validation itself
// is pure. This stub never talks to Redis.
const stubQueue = {
  toKey: (t: string) => `bull:it:${t}`,
  qualifiedName: "bull:it",
  keys: {},
  opts: { prefix: "bull" },
  name: "it",
  client: Promise.resolve({}),
  trace: async (_s: unknown, _n: unknown, fn: () => unknown) => fn(),
};

function bullmqAccepts(jobId: string): true | string {
  const job = new Job(stubQueue as never, "n", {}, { jobId });
  try {
    (job as unknown as { validateOptions(d: unknown): void }).validateOptions(job.asJSON());
    return true;
  } catch (err) {
    return (err as Error).message;
  }
}

describe("bullJobId", () => {
  it("never contains ':' and is deterministic", () => {
    const a = bullJobId("email", "verify:6ab8:abcdef123456");
    expect(a).toBe("email-verify_6ab8_abcdef123456");
    expect(bullJobId("email", "verify:6ab8:abcdef123456")).toBe(a);
    expect(a).not.toContain(":");
  });

  it("isBullSafeJobId agrees with the real BullMQ validator", () => {
    const ids = [
      "email:verify:6ab8:abc", "auto-book:6ab8", "auto-book:6ab8:try-1", "auto-sms:6ab8",
      "import:6ab8", "m:+880171:order.rto:179", "123", "tracking-sync:repeat",
      "email-verify_6ab8_abc", "auto-book-6ab8", "auto-book-6ab8-try1",
    ];
    for (const id of ids) expect(isBullSafeJobId(id), id).toBe(bullmqAccepts(id) === true);
  });

  it("reproduces the production failure for the old formats", () => {
    expect(bullmqAccepts("email:verify:6ab802ab07d1f39602bc3068:0123456789ab")).toBe("Custom Id cannot contain :");
    expect(bullmqAccepts("auto-book:6ab89c08bf7e069343886339")).toBe("Custom Id cannot contain :");
    expect(bullmqAccepts("auto-sms:6ab89c08bf7e069343886339")).toBe("Custom Id cannot contain :");
    expect(bullmqAccepts("import:6ab89c08bf7e069343886339")).toBe("Custom Id cannot contain :");
  });
});

/* ------------------------------------------------------------------------ */
/* The real enqueue functions, with the queue wrapper recording what they    */
/* would hand to BullMQ.                                                     */
/* ------------------------------------------------------------------------ */

const captured: Array<{ queue: string; name: string; jobId: unknown }> = [];

vi.mock("../src/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/env.js")>();
  // REDIS_URL present so enqueueEmail takes the queued path (not inline).
  return { ...actual, env: { ...actual.env, REDIS_URL: "redis://recorder.invalid:6379" } };
});

vi.mock("../src/lib/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/queue.js")>();
  return {
    ...actual,
    safeEnqueue: vi.fn(async (queue: string, name: string, _data: unknown, opts: { jobId?: unknown }) => {
      captured.push({ queue, name, jobId: opts?.jobId });
      return { ok: true, jobId: opts?.jobId };
    }),
    getQueue: vi.fn((queue: string) => ({
      add: vi.fn(async (name: string, _data: unknown, opts: { jobId?: unknown }) => {
        captured.push({ queue, name, jobId: opts?.jobId });
        return { id: opts?.jobId };
      }),
    })),
  };
});

describe("every enqueue site produces an id BullMQ accepts", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("email (verify / reset / courier cancel / reconnect nudge)", async () => {
    const { enqueueEmail } = await import("../src/workers/email.worker.js");
    const m = new Types.ObjectId().toHexString();
    for (const correlationId of [`verify:${m}:0123456789ab`, `reset:${m}:0123456789ab`, `courier_cancel:${m}`, `shopify_reconnect:${m}:20358`]) {
      await enqueueEmail({ correlationId, to: "a@b.test", subject: "s", html: "<p>x</p>", tag: "t" });
    }
    expect(captured).toHaveLength(4);
    for (const c of captured) expect(bullmqAccepts(String(c.jobId)), String(c.jobId)).toBe(true);
    expect(captured[0]!.jobId).toBe(`email-verify_${m}_0123456789ab`);
  });

  it("auto-book (first attempt and fallback attempts)", async () => {
    const { enqueueAutoBook } = await import("../src/workers/automationBook.js");
    const orderId = new Types.ObjectId().toHexString();
    const base = { orderId, merchantId: new Types.ObjectId().toHexString(), userId: "u" };
    await enqueueAutoBook(base);
    await enqueueAutoBook({ ...base, attempted: ["pathao"] });
    await enqueueAutoBook({ ...base, attempted: ["pathao", "redx"] });
    expect(captured.map((c) => c.jobId)).toEqual([`auto-book-${orderId}`, `auto-book-${orderId}-try1`, `auto-book-${orderId}-try2`]);
    for (const c of captured) expect(bullmqAccepts(String(c.jobId))).toBe(true);
  });

  it("auto-sms, commerce import, risk rescore", async () => {
    const { enqueueOrderConfirmationSms } = await import("../src/workers/automationSms.js");
    const { enqueueCommerceImport } = await import("../src/workers/commerceImport.js");
    const { enqueueRescore } = await import("../src/workers/riskRecompute.js");
    const id = () => new Types.ObjectId().toHexString();
    await enqueueOrderConfirmationSms({ orderId: id(), merchantId: id(), confirmationCode: "123456" } as never);
    await enqueueCommerceImport({ importJobId: id() } as never);
    await enqueueRescore({ merchantId: id(), phone: "+8801711111111", trigger: "order.rto", triggerOrderId: id() } as never);
    expect(captured.map((c) => c.queue)).toEqual(["automation-sms", "commerce-import", "risk-recompute"]);
    for (const c of captured) {
      expect(String(c.jobId)).not.toContain(":");
      expect(bullmqAccepts(String(c.jobId)), String(c.jobId)).toBe(true);
    }
  });
});
