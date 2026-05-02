/**
 * Live audit harness for the order-automation state machine.
 *
 * Real DB, real updateOnes, real sweeper. Exercises:
 *   - Flow A: pending_confirmation → confirmed (manual)
 *   - Flow B: pending_confirmation → requires_review/rejected (timeout sweep)
 *   - Invalid transitions
 *   - Idempotency (double-confirm, double-sweep)
 *   - Concurrency (confirm + sweep race)
 *
 * Mirrors the exact updateOne payloads from
 *   apps/api/src/server/routers/orders.ts  (confirmOrder/rejectOrder)
 *   apps/api/src/workers/automationStale.ts  (sweepStalePendingConfirmations)
 *
 * so the audit reflects production behavior, not idealized behavior.
 */

import "dotenv/config";
import { Types } from "mongoose";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Merchant, Order } from "@ecom/db";
import { connectDb } from "../lib/db.js";
import {
  canTransitionAutomation,
  type AutomationState,
} from "../lib/automation.js";
import { sweepStalePendingConfirmations } from "../workers/automationStale.js";

const TEST_EMAIL = "audit-asm@test.local";

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}
const results: CheckResult[] = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function ensureMerchant(): Promise<Types.ObjectId> {
  const existing = await Merchant.findOne({ email: TEST_EMAIL }).select("_id");
  if (existing) return existing._id as Types.ObjectId;
  const passwordHash = await bcrypt.hash("password123", 10);
  const m = await Merchant.create({
    businessName: "Audit ASM Co",
    email: TEST_EMAIL,
    passwordHash,
    phone: "+8801700000000",
    country: "BD",
    language: "en",
    subscription: { tier: "growth", status: "active", startDate: new Date() },
  });
  return m._id as Types.ObjectId;
}

async function makePendingConfirmationOrder(
  merchantId: Types.ObjectId,
  ageHours = 0,
): Promise<Types.ObjectId> {
  const created = ageHours > 0 ? new Date(Date.now() - ageHours * 3600_000) : new Date();
  const o = await Order.create({
    merchantId,
    orderNumber: `ASM-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
    customer: {
      name: "Test Customer",
      phone: "+8801711111112",
      address: "House 1, Road 1",
      district: "Dhaka",
    },
    items: [{ name: "thing", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "pending" },
    automation: {
      state: "pending_confirmation",
      decidedBy: "system",
      decidedAt: created,
      reason: "audit harness",
      confirmationCode: "12345678",
      confirmationSentAt: created,
      confirmationDeliveryStatus: "delivered",
    },
    fraud: { reviewStatus: "not_required", level: "low", riskScore: 25 },
    source: { channel: "dashboard" },
  });
  if (ageHours > 0) {
    // Mongoose ignores user-supplied createdAt on .create() — backfill it.
    await Order.collection.updateOne(
      { _id: o._id },
      { $set: { createdAt: created } },
    );
  }
  return o._id as Types.ObjectId;
}

/**
 * Mirrors apps/api/src/server/routers/orders.ts:confirmOrder verbatim,
 * including the from-state filter on the write. If you change one, change
 * the other.
 */
async function confirmOrderProductionPath(
  merchantId: Types.ObjectId,
  _id: Types.ObjectId,
): Promise<
  | { ok: true; idempotent: boolean }
  | { ok: false; reason: string; code?: "conflict" | "not_found" | "blocked" }
> {
  const order = await Order.findOne({ _id, merchantId })
    .select("automation order.status")
    .lean<{ automation?: { state?: AutomationState }; order?: { status?: string } }>();
  if (!order) return { ok: false, reason: "not_found", code: "not_found" };
  const fromState = order.automation?.state ?? "not_evaluated";
  if (!canTransitionAutomation(fromState, "confirmed")) {
    return { ok: false, reason: `cannot confirm from "${fromState}"`, code: "blocked" };
  }
  if (fromState === "confirmed" || fromState === "auto_confirmed") {
    return { ok: true, idempotent: true };
  }
  const now = new Date();
  const set: Record<string, unknown> = {
    "automation.state": "confirmed",
    "automation.decidedBy": "merchant",
    "automation.decidedAt": now,
    "automation.confirmedAt": now,
    "automation.reason": "audit confirm",
  };
  if (order.order?.status === "pending") set["order.status"] = "confirmed";
  // Atomic — from-state in the filter closes the TOCTOU window.
  const updated = await Order.findOneAndUpdate(
    { _id, merchantId, "automation.state": fromState },
    { $set: set },
    { new: true, projection: { _id: 1 } },
  ).lean();
  if (!updated) {
    return { ok: false, reason: "state changed in background", code: "conflict" };
  }
  return { ok: true, idempotent: false };
}

async function part2_flowA_manualConfirmation(merchantId: Types.ObjectId): Promise<void> {
  console.log("\n--- PART 2: Flow A — manual confirm ---");
  const id = await makePendingConfirmationOrder(merchantId);
  const before = await Order.findById(id).select("automation order.status").lean();
  const beforeState = (before?.automation as { state?: string })?.state;
  record("Flow A: precondition", beforeState === "pending_confirmation", `start state=${beforeState}`);

  const r1 = await confirmOrderProductionPath(merchantId, id);
  record("Flow A: confirm allowed", r1.ok && !("idempotent" in r1 && r1.idempotent), JSON.stringify(r1));

  const after = await Order.findById(id).select("automation order.status").lean();
  const a = after?.automation as { state?: string; decidedBy?: string; confirmedAt?: Date; reason?: string };
  const o = (after?.order as { status?: string });
  record(
    "Flow A: side effects",
    a?.state === "confirmed" &&
      a?.decidedBy === "merchant" &&
      !!a?.confirmedAt &&
      o?.status === "confirmed",
    `state=${a?.state} decidedBy=${a?.decidedBy} confirmedAt=${!!a?.confirmedAt} order.status=${o?.status}`,
  );
}

async function part3_flowB_noReplyTimeout(merchantId: Types.ObjectId): Promise<void> {
  console.log("\n--- PART 3: Flow B — no-reply timeout ---");

  // Case B1: 25h old → between STALE_AFTER (24h) and EXPIRE_AFTER (72h) → notify only.
  const stale = await makePendingConfirmationOrder(merchantId, 25);
  // Case B2: 80h old → past EXPIRE_AFTER → auto-cancel + state=rejected.
  const expired = await makePendingConfirmationOrder(merchantId, 80);

  const r = await sweepStalePendingConfirmations();
  console.log(`  sweep result: scanned=${r.scanned} notified=${r.notified} expired=${r.expired}`);

  const staleAfter = await Order.findById(stale).select("automation order.status fraud").lean();
  const expiredAfter = await Order.findById(expired).select("automation order.status fraud").lean();

  const sa = staleAfter?.automation as { state?: string; reason?: string };
  const so = staleAfter?.order as { status?: string };
  record(
    "Flow B: 25h order — state still pending_confirmation, just notified",
    sa?.state === "pending_confirmation" && so?.status === "pending",
    `state=${sa?.state} order.status=${so?.status}`,
  );

  const ea = expiredAfter?.automation as { state?: string; rejectionReason?: string };
  const eo = expiredAfter?.order as { status?: string };
  record(
    "Flow B: 80h order → state=rejected + order.status=cancelled",
    ea?.state === "rejected" && eo?.status === "cancelled",
    `state=${ea?.state} order.status=${eo?.status} reason=${ea?.rejectionReason?.slice(0, 60)}`,
  );

  // Sub-check: does the production sweep update fraud.reviewStatus?
  const ef = (expiredAfter?.fraud as { reviewStatus?: string })?.reviewStatus;
  record(
    "Flow B: expired order — fraud.reviewStatus updated for queue?",
    ef === "pending_call" || ef === "rejected",
    `fraud.reviewStatus=${ef ?? "(unset)"}`,
  );
}

async function part4_invalidTransitions(): Promise<void> {
  console.log("\n--- PART 4: invalid transition guards ---");

  // automation-state level
  record(
    "automation: pending_confirmation → confirmed allowed",
    canTransitionAutomation("pending_confirmation", "confirmed") === true,
    "expected true",
  );
  record(
    "automation: pending_confirmation → cancelled blocked (cancelled is not a state)",
    canTransitionAutomation("pending_confirmation", "cancelled" as AutomationState) === false,
    "automation has no cancelled state — should be false",
  );
  record(
    "automation: pending_confirmation → delivered blocked",
    canTransitionAutomation("pending_confirmation", "delivered" as AutomationState) === false,
    "delivered is not an automation state — should be false",
  );
  record(
    "automation: confirmed → pending_confirmation blocked",
    canTransitionAutomation("confirmed", "pending_confirmation") === false,
    "no backwards transition — should be false",
  );
  record(
    "automation: rejected is terminal",
    canTransitionAutomation("rejected", "confirmed") === false &&
      canTransitionAutomation("rejected", "pending_confirmation") === false,
    "no outgoing edges from rejected",
  );
  record(
    "automation: same-state idempotency",
    canTransitionAutomation("confirmed", "confirmed") === true,
    "expected true (early-return idempotency)",
  );
}

async function part5_idempotency(merchantId: Types.ObjectId): Promise<void> {
  console.log("\n--- PART 5: idempotency ---");

  // Double-confirm
  const id = await makePendingConfirmationOrder(merchantId);
  const r1 = await confirmOrderProductionPath(merchantId, id);
  const after1 = await Order.findById(id).select("automation").lean();
  const t1 = ((after1?.automation as { confirmedAt?: Date })?.confirmedAt ?? new Date(0)).getTime();
  await new Promise((r) => setTimeout(r, 10));
  const r2 = await confirmOrderProductionPath(merchantId, id);
  const after2 = await Order.findById(id).select("automation").lean();
  const t2 = ((after2?.automation as { confirmedAt?: Date })?.confirmedAt ?? new Date(0)).getTime();
  record(
    "double-confirm: second call is idempotent",
    "ok" in r2 && r2.ok && r2.idempotent === true && t1 === t2,
    `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} confirmedAt unchanged=${t1 === t2}`,
  );

  // Double-sweep on a 25h-old order
  const stale = await makePendingConfirmationOrder(merchantId, 25);
  const a = await sweepStalePendingConfirmations();
  const b = await sweepStalePendingConfirmations();
  const after = await Order.findById(stale).select("automation").lean();
  const aState = (after?.automation as { state?: string })?.state;
  record(
    "double-sweep on 25h order: state stable",
    aState === "pending_confirmation",
    `state=${aState} (sweep1: notified=${a.notified} expired=${a.expired}; sweep2: notified=${b.notified} expired=${b.expired})`,
  );

  // Double-sweep on an 80h-old order — second sweep must not double-cancel
  const old = await makePendingConfirmationOrder(merchantId, 80);
  const c = await sweepStalePendingConfirmations();
  const beforeStatus = await Order.findById(old).select("automation order.status").lean();
  const d = await sweepStalePendingConfirmations();
  const afterStatus = await Order.findById(old).select("automation order.status").lean();
  const cState = (beforeStatus?.automation as { state?: string })?.state;
  const dState = (afterStatus?.automation as { state?: string })?.state;
  record(
    "double-sweep on 80h order: stays rejected + cancelled, no second write",
    cState === "rejected" && dState === "rejected" && d.expired === 0,
    `after sweep1: state=${cState} expired=${c.expired}; after sweep2: state=${dState} expired=${d.expired}`,
  );
}

async function part6_concurrency(merchantId: Types.ObjectId): Promise<void> {
  console.log("\n--- PART 6: concurrency ---");

  // Race A: confirm vs sweep on an 80h order
  const id = await makePendingConfirmationOrder(merchantId, 80);
  const [confirmRes, sweepRes] = await Promise.all([
    confirmOrderProductionPath(merchantId, id),
    sweepStalePendingConfirmations(),
  ]);
  const after = await Order.findById(id).select("automation order.status").lean();
  const a = after?.automation as { state?: string; decidedBy?: string };
  const o = after?.order as { status?: string };
  console.log(
    `  race A — confirm:${JSON.stringify(confirmRes)}  sweep:expired=${sweepRes.expired}  → final state=${a?.state} order.status=${o?.status}`,
  );
  // Determinism: outcome should be either ALL-confirmed or ALL-rejected, never mixed.
  const confirmedCoherent =
    a?.state === "confirmed" && o?.status === "confirmed";
  const rejectedCoherent =
    a?.state === "rejected" && o?.status === "cancelled";
  record(
    "race A: final state internally consistent (no torn write)",
    confirmedCoherent || rejectedCoherent,
    `state=${a?.state} order.status=${o?.status} decidedBy=${a?.decidedBy}`,
  );

  // Race B: TOCTOU — the test forces a stale-read then races the sweep in
  // before the confirm write. With the production from-state filter, the
  // late confirm MUST fail with conflict and the sweep's rejected state
  // MUST survive.
  const id2 = await makePendingConfirmationOrder(merchantId, 80);
  // Pre-read (the merchant's click started here).
  await Order.findOne({ _id: id2, merchantId }).select("automation order.status").lean();
  // Sweeper races in.
  await sweepStalePendingConfirmations();
  // Late merchant click completes — the production code path now refuses.
  const lateConfirm = await confirmOrderProductionPath(merchantId, id2);
  const final = await Order.findById(id2).select("automation order.status").lean();
  const fa = final?.automation as { state?: string; decidedBy?: string };
  const fo = final?.order as { status?: string };
  record(
    "race B (TOCTOU): late merchant confirm cannot overwrite sweep-rejected order",
    fa?.state === "rejected" &&
      fo?.status === "cancelled" &&
      "ok" in lateConfirm &&
      lateConfirm.ok === false &&
      lateConfirm.code === "blocked", // fromState was already "rejected", so transition blocked at the guard
    `final state=${fa?.state} order.status=${fo?.status} lateConfirm=${JSON.stringify(lateConfirm)}`,
  );

  // Race C: TOCTOU where the read CATCHES the order in pending_confirmation
  // but the sweep races in BETWEEN read and write. This is the case the
  // findOneAndUpdate filter actually defends against — the guard alone
  // wouldn't help because the in-memory check sees a legal transition.
  const id3 = await makePendingConfirmationOrder(merchantId, 80);
  const stale = await Order.findOne({ _id: id3, merchantId })
    .select("automation order.status")
    .lean<{ automation?: { state?: AutomationState }; order?: { status?: string } }>();
  const staleFromState = stale?.automation?.state ?? "not_evaluated";
  // Sweep flips it under us.
  await sweepStalePendingConfirmations();
  // Now do the write the way the router does (with from-state filter).
  const writeRes = await Order.findOneAndUpdate(
    { _id: id3, merchantId, "automation.state": staleFromState },
    {
      $set: {
        "automation.state": "confirmed",
        "automation.decidedBy": "merchant",
        "automation.confirmedAt": new Date(),
      },
    },
    { new: true, projection: { _id: 1 } },
  ).lean();
  const finalC = await Order.findById(id3).select("automation order.status").lean();
  const fac = finalC?.automation as { state?: string };
  const foc = finalC?.order as { status?: string };
  record(
    "race C: stale-read confirm with from-state filter is rejected by Mongo",
    writeRes === null && fac?.state === "rejected" && foc?.status === "cancelled",
    `writeRes=${writeRes === null ? "null (good)" : "wrote (BAD)"} final state=${fac?.state} order.status=${foc?.status}`,
  );
}

async function part7_dataIntegrity(merchantId: Types.ObjectId): Promise<void> {
  console.log("\n--- PART 7: data integrity sweep ---");
  const orders = await Order.find({ merchantId, orderNumber: /^ASM-/ })
    .select("order.status automation.state fraud.reviewStatus")
    .lean();
  const validOrderStatus = new Set([
    "pending",
    "confirmed",
    "packed",
    "shipped",
    "in_transit",
    "delivered",
    "cancelled",
    "rto",
  ]);
  const validAutoState = new Set([
    "not_evaluated",
    "auto_confirmed",
    "pending_confirmation",
    "confirmed",
    "rejected",
    "requires_review",
  ]);
  let badStatus = 0;
  let badState = 0;
  let inconsistent = 0;
  for (const o of orders) {
    const s = (o.order as { status?: string })?.status ?? "";
    const a = (o.automation as { state?: string })?.state ?? "";
    if (!validOrderStatus.has(s)) badStatus += 1;
    if (!validAutoState.has(a)) badState += 1;
    // Cross-consistency: if automation=rejected, order.status MUST be cancelled.
    if (a === "rejected" && s !== "cancelled") inconsistent += 1;
    // If automation=confirmed/auto_confirmed, order.status must NOT be cancelled.
    if ((a === "confirmed" || a === "auto_confirmed") && s === "cancelled") inconsistent += 1;
  }
  record(
    "every persisted order has a valid order.status",
    badStatus === 0,
    `bad=${badStatus}/${orders.length}`,
  );
  record(
    "every persisted order has a valid automation.state",
    badState === 0,
    `bad=${badState}/${orders.length}`,
  );
  record(
    "automation/order.status cross-consistency",
    inconsistent === 0,
    `inconsistent=${inconsistent}/${orders.length}`,
  );
}

async function main(): Promise<void> {
  await connectDb();
  const merchantId = await ensureMerchant();
  console.log(`[audit] merchant=${String(merchantId)}`);
  // Wipe prior harness orders so reruns are clean.
  const wipe = await Order.deleteMany({ merchantId, orderNumber: /^ASM-/ });
  console.log(`[audit] wiped ${wipe.deletedCount} prior harness orders`);

  await part2_flowA_manualConfirmation(merchantId);
  await part3_flowB_noReplyTimeout(merchantId);
  await part4_invalidTransitions();
  await part5_idempotency(merchantId);
  await part6_concurrency(merchantId);
  await part7_dataIntegrity(merchantId);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== AUDIT SUMMARY: ${passed}/${results.length} passed, ${failed} failed ===`);
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  FAIL: ${r.name}`);
    console.log(`        ${r.detail}`);
  }
}

main()
  .catch((err) => {
    console.error("[audit] FATAL:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
  });
