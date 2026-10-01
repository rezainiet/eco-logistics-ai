import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AuditLog, Order, RecoveryTask, TrackingSession } from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { sweepCartRecovery } from "../src/workers/cartRecovery.js";
import { canTransitionRecovery } from "../src/server/routers/recovery.js";
import {
  decodeReviewCursor,
  encodeReviewCursor,
} from "../src/server/routers/fraud.js";

const HOUR = 60 * 60 * 1000;

let phoneSeq = 0;
async function seedSessions(
  merchantId: Types.ObjectId,
  n: number,
  opts: { lastSeenAgoMs?: number; prefix?: string; extra?: Record<string, unknown> } = {},
) {
  const base = Date.now() - (opts.lastSeenAgoMs ?? 2 * HOUR);
  const docs = Array.from({ length: n }, (_, i) => ({
    merchantId,
    sessionId: `${opts.prefix ?? "sess"}-${String(i).padStart(4, "0")}`,
    firstSeenAt: new Date(base - i * 1000 - 60_000),
    lastSeenAt: new Date(base - i * 1000),
    abandonedCart: true,
    converted: false,
    addToCartCount: 2,
    checkoutSubmitCount: 0,
    phone: `+88017${String(10_000_000 + phoneSeq++).slice(-8)}`,
    ...(opts.extra ?? {}),
  }));
  await TrackingSession.insertMany(docs);
  return docs.map((d) => d.sessionId);
}

// ---------------------------------------------------------------- CR-2
describe("cart-recovery sweep — no starvation, idempotent, tenant-scoped (CR-2)", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("an older untasked candidate is selected even behind 250 newer already-tasked ones", async () => {
    const m = await createMerchant();
    const mid = m._id as Types.ObjectId;
    const newer = await seedSessions(mid, 250, { lastSeenAgoMs: 1 * HOUR, prefix: "new" });
    await RecoveryTask.insertMany(
      newer.map((sessionId) => ({ merchantId: mid, sessionId, abandonedAt: new Date(), status: "pending" })),
    );
    const [older] = await seedSessions(mid, 1, { lastSeenAgoMs: 3 * 24 * HOUR, prefix: "old" });

    const res = await sweepCartRecovery();
    expect(res.created).toBe(1);
    expect(res.alreadyTasked).toBe(250);
    expect(await RecoveryTask.exists({ merchantId: mid, sessionId: older })).toBeTruthy();
  });

  it("a backlog larger than one tick's budget drains completely over successive ticks", async () => {
    const m = await createMerchant();
    const mid = m._id as Types.ObjectId;
    await seedSessions(mid, 205);
    const created: number[] = [];
    for (let i = 0; i < 4; i++) created.push((await sweepCartRecovery({ maxCreatePerMerchant: 100 })).created);
    expect(created).toEqual([100, 100, 5, 0]);
    expect(await RecoveryTask.countDocuments({ merchantId: mid })).toBe(205);
  });

  it("oldest eligible sessions are created first (FIFO), so none can wait forever", async () => {
    const m = await createMerchant();
    const mid = m._id as Types.ObjectId;
    const recent = await seedSessions(mid, 3, { lastSeenAgoMs: 1 * HOUR, prefix: "recent" });
    const old = await seedSessions(mid, 3, { lastSeenAgoMs: 5 * 24 * HOUR, prefix: "old" });
    await sweepCartRecovery({ maxCreatePerMerchant: 3 });
    const tasked = (await RecoveryTask.find({ merchantId: mid }).lean()).map((t) => t.sessionId).sort();
    expect(tasked).toEqual([...old].sort());
    expect(tasked.some((s) => recent.includes(s))).toBe(false);
  });

  it("repeated execution is idempotent — one task per session", async () => {
    const m = await createMerchant();
    const mid = m._id as Types.ObjectId;
    await seedSessions(mid, 7);
    const first = await sweepCartRecovery();
    const second = await sweepCartRecovery();
    expect(first.created).toBe(7);
    expect(second.created).toBe(0);
    expect(second.alreadyTasked).toBe(7);
    expect(await RecoveryTask.countDocuments({ merchantId: mid })).toBe(7);
  });

  it("concurrent sweeps can't create duplicate tasks for the same session", async () => {
    const m = await createMerchant();
    const mid = m._id as Types.ObjectId;
    await seedSessions(mid, 25);
    const [a, b] = await Promise.all([sweepCartRecovery(), sweepCartRecovery()]);
    expect(a.created + b.created).toBe(25);
    expect(await RecoveryTask.countDocuments({ merchantId: mid })).toBe(25);
  });

  it("merchants stay isolated: every task belongs to its session's merchant", async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    await seedSessions(a._id as Types.ObjectId, 2, { prefix: "a" });
    await seedSessions(b._id as Types.ObjectId, 3, { prefix: "b" });
    await sweepCartRecovery();
    expect(await RecoveryTask.countDocuments({ merchantId: a._id })).toBe(2);
    expect(await RecoveryTask.countDocuments({ merchantId: b._id })).toBe(3);
    for (const t of await RecoveryTask.find().lean()) {
      const s = await TrackingSession.findOne({ sessionId: t.sessionId }).lean();
      expect(String(s?.merchantId)).toBe(String(t.merchantId));
    }
  });

  it("still skips converted, stitched, anonymous, too-fresh and out-of-window sessions", async () => {
    const m = await createMerchant();
    const mid = m._id as Types.ObjectId;
    await seedSessions(mid, 1, { prefix: "conv", extra: { converted: true } });
    await seedSessions(mid, 1, { prefix: "stitched", extra: { resolvedOrderId: new Types.ObjectId() } });
    await seedSessions(mid, 1, { prefix: "anon", extra: { phone: null } });
    await seedSessions(mid, 1, { prefix: "fresh", lastSeenAgoMs: 5 * 60_000 });
    await seedSessions(mid, 1, { prefix: "stale", lastSeenAgoMs: 8 * 24 * HOUR });
    await seedSessions(mid, 1, { prefix: "notabandoned", extra: { abandonedCart: false } });
    await seedSessions(mid, 1, { prefix: "ok" });
    const res = await sweepCartRecovery();
    expect(res.created).toBe(1);
    expect((await RecoveryTask.findOne({ merchantId: mid }).lean())?.sessionId).toBe("ok-0000");
  });

  it("the batch audit uses the dedicated recovery action", async () => {
    const m = await createMerchant();
    await seedSessions(m._id as Types.ObjectId, 2);
    await sweepCartRecovery();
    await new Promise((r) => setTimeout(r, 100)); // writeAudit is fire-and-forget
    const row = await AuditLog.findOne({ merchantId: m._id, "meta.kind": "cart_recovery_batch" }).lean();
    expect(row?.action).toBe("recovery.tasks_created");
  });
});

// ---------------------------------------------------------------- CR-6
describe("recovery.update — transitions & ownership (CR-6)", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  async function taskFor(merchantId: Types.ObjectId, status = "pending", phone = "+8801711222333") {
    return RecoveryTask.create({
      merchantId,
      sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
      phone,
      abandonedAt: new Date(Date.now() - 2 * HOUR),
      status,
    });
  }
  async function orderFor(merchantId: Types.ObjectId, phone = "+8801711222333") {
    return Order.create({
      merchantId,
      orderNumber: `ORD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      customer: { name: "Buyer", phone, address: "House 1, Road 2", district: "Dhaka" },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "pending" },
    });
  }

  it("transition table: pending/contacted may move on; recovered/dismissed/expired are terminal", () => {
    for (const to of ["contacted", "recovered", "dismissed"] as const) {
      expect(canTransitionRecovery("pending", to)).toBe(true);
      expect(canTransitionRecovery("contacted", to)).toBe(true);
      for (const from of ["recovered", "dismissed", "expired"] as const) {
        expect(canTransitionRecovery(from, to)).toBe(false);
      }
    }
  });

  it("valid transition is accepted and audited under the recovery action", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const t = await taskFor(m._id as Types.ObjectId);
    const res = await caller.recovery.update({ id: String(t._id), status: "contacted", channel: "sms" });
    expect(res.status).toBe("contacted");
    await new Promise((r) => setTimeout(r, 100));
    const audit = await AuditLog.findOne({ merchantId: m._id, "meta.kind": "recovery_update" }).lean();
    expect(audit?.action).toBe("recovery.task_updated");
    expect(audit?.meta).toMatchObject({ fromStatus: "pending", newStatus: "contacted", channel: "sms" });
  });

  it("invalid transitions are rejected and leave the task unchanged", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    for (const status of ["recovered", "dismissed", "expired"]) {
      const t = await taskFor(m._id as Types.ObjectId, status);
      await expect(caller.recovery.update({ id: String(t._id), status: "contacted" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect((await RecoveryTask.findById(t._id).lean())?.status).toBe(status);
    }
  });

  it("same-merchant recoveredOrderId is accepted and linked", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const t = await taskFor(m._id as Types.ObjectId);
    const o = await orderFor(m._id as Types.ObjectId);
    const res = await caller.recovery.update({ id: String(t._id), status: "recovered", recoveredOrderId: String(o._id) });
    expect(res.recoveredOrderId).toBe(String(o._id));
  });

  it("cross-merchant recoveredOrderId is rejected and nothing is written", async () => {
    const a = await createMerchant({ tier: "growth" });
    const b = await createMerchant({ tier: "growth" });
    const t = await taskFor(a._id as Types.ObjectId);
    const foreign = await orderFor(b._id as Types.ObjectId);
    await expect(
      callerFor(authUserFor(a)).recovery.update({
        id: String(t._id),
        status: "recovered",
        recoveredOrderId: String(foreign._id),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const after = await RecoveryTask.findById(t._id).lean();
    expect(after?.status).toBe("pending");
    expect(after?.recoveredOrderId).toBeUndefined();
  });

  it("malformed recoveredOrderId is rejected (no longer silently ignored)", async () => {
    const m = await createMerchant({ tier: "growth" });
    const t = await taskFor(m._id as Types.ObjectId);
    await expect(
      callerFor(authUserFor(m)).recovery.update({ id: String(t._id), status: "recovered", recoveredOrderId: "nope" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("phone fallback only links this merchant's orders", async () => {
    const a = await createMerchant({ tier: "growth" });
    const b = await createMerchant({ tier: "growth" });
    const t = await taskFor(a._id as Types.ObjectId, "pending", "+8801999888777");
    await orderFor(b._id as Types.ObjectId, "+8801999888777"); // same buyer phone, other merchant
    const res = await callerFor(authUserFor(a)).recovery.update({ id: String(t._id), status: "recovered" });
    expect(res.recoveredOrderId).toBeNull();
  });

  it("tenant isolation: merchant B can't update merchant A's task", async () => {
    const a = await createMerchant({ tier: "growth" });
    const b = await createMerchant({ tier: "growth" });
    const t = await taskFor(a._id as Types.ObjectId);
    await expect(
      callerFor(authUserFor(b)).recovery.update({ id: String(t._id), status: "dismissed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await RecoveryTask.findById(t._id).lean())?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------- OV-1 / OV-2
async function reviewOrder(merchantId: Types.ObjectId, riskScore: number, reviewStatus = "pending_call") {
  return Order.create({
    merchantId,
    orderNumber: `R-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
    customer: { name: "Buyer", phone: "+8801711000000", address: "House 1, Road 2", district: "Dhaka" },
    items: [{ name: "Shirt", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "pending" },
    fraud: { riskScore, level: "high", reviewStatus },
  });
}

describe("fraud.getReviewOrder — plan gate (OV-1)", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("Starter is refused on a direct API call", async () => {
    const m = await createMerchant({ tier: "starter" });
    const o = await reviewOrder(m._id as Types.ObjectId, 80);
    await expect(callerFor(authUserFor(m)).fraud.getReviewOrder({ id: String(o._id) })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("Growth (and Pro) can read their own order", async () => {
    for (const tier of ["growth", "scale"] as const) {
      const m = await createMerchant({ tier });
      const o = await reviewOrder(m._id as Types.ObjectId, 80);
      const res = await callerFor(authUserFor(m)).fraud.getReviewOrder({ id: String(o._id) });
      expect(res.orderNumber).toBe(o.orderNumber);
    }
  });

  it("an eligible merchant still can't read another merchant's order", async () => {
    const a = await createMerchant({ tier: "growth" });
    const b = await createMerchant({ tier: "growth" });
    const foreign = await reviewOrder(b._id as Types.ObjectId, 80);
    await expect(callerFor(authUserFor(a)).fraud.getReviewOrder({ id: String(foreign._id) })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("subscription status follows the existing verification model (tier-gated, like its siblings)", async () => {
    // getReviewOrder now matches listPendingReviews / markVerified exactly:
    // the plan tier is enforced; subscription status is not (procedures are
    // protectedProcedure). Pinned here so the two can't drift apart.
    const m = await createMerchant({ tier: "growth", status: "past_due" });
    const o = await reviewOrder(m._id as Types.ObjectId, 80);
    const caller = callerFor(authUserFor(m));
    const list = await caller.fraud.listPendingReviews({ cursor: null, limit: 10, filter: "all_open" });
    expect(list.items).toHaveLength(1);
    const detail = await caller.fraud.getReviewOrder({ id: String(o._id) });
    expect(detail.orderNumber).toBe(o.orderNumber);
  });
});

describe("fraud.listPendingReviews — compound cursor (OV-2)", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  async function walk(caller: ReturnType<typeof callerFor>, limit: number) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await caller.fraud.listPendingReviews({ cursor, limit, filter: "all_open" });
      seen.push(...page.items.map((i) => i.id));
      pages += 1;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (pages > 50) throw new Error("runaway pagination");
    }
    return { seen, pages };
  }

  it("no duplicates and no skipped rows across pages (mixed scores, ties, newer low-score rows)", async () => {
    const m = await createMerchant({ tier: "growth" });
    const mid = m._id as Types.ObjectId;
    // Interleave creation so _id order and score order disagree — the case the
    // old `_id < last` cursor got wrong.
    const scores = [90, 40, 90, 70, 40, 95, 70, 40, 90, 55, 70, 95, 40];
    const created = [];
    for (const s of scores) created.push(await reviewOrder(mid, s));
    const expected = [...created]
      .sort((a, b) => b.fraud!.riskScore! - a.fraud!.riskScore! || (String(b._id) > String(a._id) ? 1 : -1))
      .map((o) => String(o._id));

    const { seen } = await walk(callerFor(authUserFor(m)), 4);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
  });

  it("equal scores page strictly by _id DESC", async () => {
    const m = await createMerchant({ tier: "growth" });
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(String((await reviewOrder(m._id as Types.ObjectId, 60))._id));
    const { seen } = await walk(callerFor(authUserFor(m)), 2);
    expect(seen).toEqual([...ids].reverse());
  });

  it("the final page is empty-safe and returns no cursor", async () => {
    const m = await createMerchant({ tier: "growth" });
    for (let i = 0; i < 4; i++) await reviewOrder(m._id as Types.ObjectId, 50 + i);
    const caller = callerFor(authUserFor(m));
    const p1 = await caller.fraud.listPendingReviews({ cursor: null, limit: 4, filter: "all_open" });
    expect(p1.items).toHaveLength(4);
    expect(p1.hasMore).toBe(false);
    expect(p1.nextCursor).toBeNull();
    const empty = await callerFor(authUserFor(await createMerchant({ tier: "growth" }))).fraud.listPendingReviews({
      cursor: null,
      limit: 4,
      filter: "all_open",
    });
    expect(empty).toMatchObject({ items: [], nextCursor: null, hasMore: false, total: 0 });
  });

  it("replaying the same cursor returns the same page (no drift, no duplicates)", async () => {
    const m = await createMerchant({ tier: "growth" });
    for (const s of [80, 60, 80, 60, 70]) await reviewOrder(m._id as Types.ObjectId, s);
    const caller = callerFor(authUserFor(m));
    const p1 = await caller.fraud.listPendingReviews({ cursor: null, limit: 2, filter: "all_open" });
    const a = await caller.fraud.listPendingReviews({ cursor: p1.nextCursor, limit: 2, filter: "all_open" });
    const b = await caller.fraud.listPendingReviews({ cursor: p1.nextCursor, limit: 2, filter: "all_open" });
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.items.some((i) => p1.items.some((j) => j.id === i.id))).toBe(false);
  });

  it("tenant isolation: another merchant's rows never appear, even with a crafted cursor", async () => {
    const a = await createMerchant({ tier: "growth" });
    const b = await createMerchant({ tier: "growth" });
    await reviewOrder(a._id as Types.ObjectId, 50);
    const foreign = await reviewOrder(b._id as Types.ObjectId, 99);
    const crafted = encodeReviewCursor({ s: 100, id: String(new Types.ObjectId()) });
    const page = await callerFor(authUserFor(a)).fraud.listPendingReviews({ cursor: crafted, limit: 10, filter: "all_open" });
    expect(page.items.map((i) => i.id)).not.toContain(String(foreign._id));
    expect(page.items).toHaveLength(1);
  });

  it("malformed cursors are rejected; legacy bare-_id cursors still work", async () => {
    const m = await createMerchant({ tier: "growth" });
    const o1 = await reviewOrder(m._id as Types.ObjectId, 90);
    const o2 = await reviewOrder(m._id as Types.ObjectId, 30);
    const caller = callerFor(authUserFor(m));
    await expect(caller.fraud.listPendingReviews({ cursor: "garbage", limit: 5, filter: "all_open" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const legacy = await caller.fraud.listPendingReviews({ cursor: String(o1._id), limit: 5, filter: "all_open" });
    expect(legacy.items.map((i) => i.id)).toEqual([String(o2._id)]);
    expect(decodeReviewCursor(encodeReviewCursor({ s: 42, id: String(o1._id) }))).toEqual({ s: 42, id: String(o1._id) });
  });
});
