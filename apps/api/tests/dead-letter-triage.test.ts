import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Notification, PendingJob } from "@ecom/db";
import { classifyDeadLetter, EMAIL_TOKEN_TTL_MS } from "../src/lib/dead-letter-triage.js";
import { LEGACY_UNSAFE_JOB_ID, sweepPendingJobs } from "../src/workers/pendingJobReplay.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";

const now = new Date("2026-09-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const oid = () => new Types.ObjectId().toHexString();

describe("classifyDeadLetter — automatic courier booking", () => {
  const row = (ageH: number) => ({
    queueName: "automation-book",
    jobName: "auto-book",
    createdAt: hoursAgo(ageH),
    data: { orderId: oid(), merchantId: oid(), userId: "u" },
  });
  const bookable = { status: "confirmed", hasTrackingNumber: false };

  it("never offers a replay for orders that moved on", () => {
    const f = (order: object | null, extra: object = {}) =>
      classifyDeadLetter(row(1), { now, order: order as never, merchantAutoBookEnabled: true, ...extra }).category;
    expect(f(null)).toBe("order_missing");
    expect(f({ status: "confirmed", hasTrackingNumber: true })).toBe("already_booked");
    expect(f({ status: "delivered", hasTrackingNumber: false })).toBe("order_terminal");
    expect(f({ status: "cancelled", hasTrackingNumber: false })).toBe("order_terminal");
    expect(f({ status: "rto", hasTrackingNumber: false })).toBe("order_terminal");
    expect(f({ status: "shipped", hasTrackingNumber: false })).toBe("order_not_actionable");
    expect(f(bookable, { merchantAutoBookEnabled: false })).toBe("automation_disabled");
  });

  it("is stale after the age limit even when otherwise bookable", () => {
    expect(classifyDeadLetter(row(25), { now, order: bookable, merchantAutoBookEnabled: true }).category).toBe("stale");
    expect(classifyDeadLetter(row(2), { now, order: bookable, merchantAutoBookEnabled: true }).category).toBe("safe_candidate");
  });

  it("rejects rows without ids", () => {
    expect(classifyDeadLetter({ ...row(1), data: {} }, { now }).category).toBe("invalid");
  });
});

describe("classifyDeadLetter — email and other queues", () => {
  it("expires verification and reset links on their real lifetimes", () => {
    const email = (job: string, ageMs: number) =>
      classifyDeadLetter({ queueName: "email", jobName: job, createdAt: new Date(now.getTime() - ageMs), data: {} }, { now }).category;
    expect(email("password_reset", EMAIL_TOKEN_TTL_MS.password_reset! + 1)).toBe("token_expired");
    expect(email("password_reset", 10 * 60_000)).toBe("safe_candidate");
    expect(email("verify_email", EMAIL_TOKEN_TTL_MS.verify_email! + 1)).toBe("token_expired");
    expect(email("shopify_reconnect_nudge", 48 * 3_600_000)).toBe("stale");
  });

  it("unknown queues are not guessed", () => {
    expect(classifyDeadLetter({ queueName: "mystery", jobName: "x", createdAt: now, data: {} }, { now }).category).toBe("unsupported_queue");
  });
});

describe("replay sweeper parks legacy unsafe job ids", () => {
  beforeAll(ensureDb);
  afterAll(disconnectDb);
  beforeEach(resetDb);

  it("parks the row once — no replay, no merchant alert", async () => {
    const merchantId = oid();
    const legacy = await PendingJob.create({
      queueName: "automation-book",
      jobName: "auto-book",
      data: { orderId: oid(), merchantId, userId: "u" },
      jobOpts: { jobId: `auto-book:${oid()}`, attempts: 3 },
      ctx: { merchantId, description: "auto-book" },
      status: "pending",
      attempts: 4, // one short of MAX_REPLAY_ATTEMPTS: the old path would alert next
      nextAttemptAt: new Date(Date.now() - 1000),
    });
    const r = await sweepPendingJobs(10);
    expect(r.parkedLegacy).toBe(1);
    expect(r.replayed).toBe(0);
    expect(r.exhausted).toBe(0);
    const after = await PendingJob.findById(legacy._id).lean();
    expect(after).toMatchObject({ status: "exhausted", lastError: LEGACY_UNSAFE_JOB_ID });
    expect(await Notification.countDocuments({})).toBe(0);

    // A second tick does not pick it up again.
    const r2 = await sweepPendingJobs(10);
    expect(r2.picked).toBe(0);
  });
});
