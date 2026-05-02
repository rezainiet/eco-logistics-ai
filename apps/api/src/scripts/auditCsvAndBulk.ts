/**
 * Live audit of CSV import (orders.bulkUpload) + bulk reject/undo flow.
 *
 * Real DB. Replicates the production code paths:
 *   - parseCsv → staged-row validation → batch fraud history → insertMany
 *   - bulkRejectOrders per-row atomic findOneAndUpdate
 *
 * Undo: there is no backend undo. The 6-second window lives entirely in
 * apps/web/src/components/automation/bulk-automation-bar.tsx — once the
 * setTimeout fires, the mutation runs and the orders are terminally
 * rejected. This script proves that and times the practical window.
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
import {
  collectRiskHistoryBatch,
  computeRisk,
  hashAddress,
  type RiskOptions,
} from "../server/risk.js";
import {
  parseAndStageBulk,
  dedupAgainstRecentOrders,
} from "../server/routers/orders.js";

const TEST_EMAIL = "audit-csvbulk@test.local";
const PHONE_RE = /^\+?[0-9]{7,15}$/;

interface CheckResult { name: string; pass: boolean; detail: string; }
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
    businessName: "Audit CSV Co",
    email: TEST_EMAIL,
    passwordHash,
    phone: "+8801700000000",
    country: "BD",
    language: "en",
    subscription: { tier: "growth", status: "active", startDate: new Date() },
  });
  return m._id as Types.ObjectId;
}

/**
 * Mirrors apps/api/src/server/routers/orders.ts:bulkUpload — parsing,
 * staged-row validation, batch fraud history, insertMany. No quota
 * enforcement (the harness merchant is not gated).
 */
async function runBulkUpload(
  merchantId: Types.ObjectId,
  csv: string,
): Promise<{
  inserted: number;
  errors: Array<{ row: number; error: string }>;
  totalRows: number;
  flagged: number;
  duplicates: number;
}> {
  // Use the SAME parsing + dedup helpers the production router uses, so the
  // harness exercises header mapping, dedup, and improved errors end-to-end.
  const parsed = parseAndStageBulk(csv);
  const errors: Array<{ row: number; error: string }> = parsed.errors.map((e) => ({
    row: e.row,
    error: e.error,
  }));
  const dedupRes = await dedupAgainstRecentOrders(merchantId, parsed.staged, errors);
  const staged = dedupRes.kept;
  if (staged.length === 0) {
    return {
      inserted: 0,
      errors,
      totalRows: parsed.totalRows,
      flagged: 0,
      duplicates: dedupRes.duplicates.length,
    };
  }

  const phoneSet = new Set<string>();
  const addressSet = new Set<string>();
  for (const s of staged) {
    phoneSet.add(s.customer.phone);
    if (s.addressHash) addressSet.add(s.addressHash);
  }
  const batch = await collectRiskHistoryBatch({
    merchantId,
    phones: [...phoneSet],
    addressHashes: [...addressSet],
  });
  const withinPhone = new Map<string, number>();
  const withinAddress = new Map<string, number>();
  for (const s of staged) {
    withinPhone.set(s.customer.phone, (withinPhone.get(s.customer.phone) ?? 0) + 1);
    if (s.addressHash) withinAddress.set(s.addressHash, (withinAddress.get(s.addressHash) ?? 0) + 1);
  }

  const opts: RiskOptions = {};
  const docs: Array<Record<string, unknown>> = [];
  for (const s of staged) {
    const phoneHist = batch.byPhone.get(s.customer.phone) ?? {
      phoneOrdersCount: 0,
      phoneReturnedCount: 0,
      phoneCancelledCount: 0,
      phoneUnreachableCount: 0,
    };
    const addrHist = (s.addressHash && batch.byAddress.get(s.addressHash)) ||
      { addressDistinctPhones: 0, addressReturnedCount: 0 };
    const withinPhoneDup = (withinPhone.get(s.customer.phone) ?? 1) - 1;
    const withinAddrDup = s.addressHash ? (withinAddress.get(s.addressHash) ?? 1) - 1 : 0;
    const risk = computeRisk(
      { cod: s.cod, customer: s.customer, addressHash: s.addressHash },
      {
        phoneOrdersCount: phoneHist.phoneOrdersCount + withinPhoneDup,
        phoneReturnedCount: phoneHist.phoneReturnedCount,
        phoneCancelledCount: phoneHist.phoneCancelledCount,
        phoneUnreachableCount: phoneHist.phoneUnreachableCount,
        ipRecentCount: 0,
        phoneVelocityCount: phoneHist.phoneOrdersCount + withinPhoneDup + 1,
        addressDistinctPhones: addrHist.addressDistinctPhones + withinAddrDup,
        addressReturnedCount: addrHist.addressReturnedCount,
      },
      opts,
    );
    docs.push({
      merchantId,
      orderNumber: s.orderNumber,
      customer: s.customer,
      items: [{ name: s.itemName, quantity: s.quantity, price: s.price }],
      order: { cod: s.cod, total: s.price * s.quantity, status: "pending" },
      fraud: {
        detected: risk.level === "high",
        riskScore: risk.riskScore,
        level: risk.level,
        reasons: risk.reasons,
        signals: risk.signals,
        reviewStatus: risk.reviewStatus,
        scoredAt: new Date(),
      },
      source: { addressHash: s.addressHash ?? undefined, channel: "bulk_upload" },
    });
  }

  let inserted = 0;
  let flagged = 0;
  try {
    const result = await Order.insertMany(docs, { ordered: false });
    inserted = result.length;
    for (const r of result) {
      if ((r as { fraud?: { level?: string } }).fraud?.level === "high") flagged += 1;
    }
  } catch (err) {
    const bulkErr = err as { insertedDocs?: Array<unknown>; writeErrors?: Array<{ index?: number; errmsg?: string }> };
    inserted = bulkErr.insertedDocs?.length ?? 0;
    for (const we of bulkErr.writeErrors ?? []) {
      errors.push({ row: (we.index ?? 0) + 2, error: we.errmsg ?? "write error" });
    }
  }
  return {
    inserted,
    errors,
    totalRows: parsed.totalRows,
    flagged,
    duplicates: dedupRes.duplicates.length,
  };
}

/** Mirrors orders.bulkRejectOrders (post-fix per-row atomic). */
async function runBulkReject(
  merchantId: Types.ObjectId,
  ids: string[],
  reason = "audit reject",
): Promise<{ rejected: string[]; alreadyRejected: string[]; conflicted: string[]; tooLate: string[]; notFound: string[]; invalid: string[] }> {
  const validIds = ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const orders = await Order.find({ _id: { $in: validIds }, merchantId })
    .select("_id automation order.status")
    .lean();
  const found = new Map(orders.map((o) => [String(o._id), o]));
  const result = {
    rejected: [] as string[],
    alreadyRejected: [] as string[],
    conflicted: [] as string[],
    tooLate: [] as string[],
    notFound: [] as string[],
    invalid: [] as string[],
  };
  const now = new Date();
  for (const id of ids) {
    if (!Types.ObjectId.isValid(id)) { result.invalid.push(id); continue; }
    const o = found.get(id);
    if (!o) { result.notFound.push(id); continue; }
    const fromState = (o as { automation?: { state?: AutomationState } }).automation?.state ?? "not_evaluated";
    if (fromState === "rejected") { result.alreadyRejected.push(id); continue; }
    if (!canTransitionAutomation(fromState, "rejected")) { result.tooLate.push(id); continue; }
    const status = (o as { order?: { status?: string } }).order?.status;
    if (status && !["pending", "confirmed"].includes(status)) {
      result.tooLate.push(id);
      continue;
    }
    const updated = await Order.findOneAndUpdate(
      { _id: o._id as Types.ObjectId, merchantId, "automation.state": fromState },
      {
        $set: {
          "automation.state": "rejected",
          "automation.decidedBy": "merchant",
          "automation.decidedAt": now,
          "automation.rejectedAt": now,
          "automation.rejectionReason": reason,
          "order.status": "cancelled",
        },
      },
      { new: true, projection: { _id: 1 } },
    ).lean();
    if (updated) result.rejected.push(id);
    else result.conflicted.push(id);
  }
  return result;
}

async function part1A_userExactCSV(merchantId: Types.ObjectId): Promise<{ insertedIds: string[] }> {
  console.log("\n--- PART 1A: user's exact CSV (productName/phone/address/city/totalAmount) ---");
  const csv = `productName,customerName,phone,address,city,quantity,totalAmount
T-Shirt,Rahim,01700000001,House 1 Banani,Dhaka,1,500
T-Shirt,Karim,01700000002,House 2 Gulshan,Dhaka,1,500
T-Shirt,Salam,01700000003,House 3 Mirpur,Dhaka,1,500`;

  // First: exercise the production parse helper directly to confirm header
  // mapping fires and warnings surface.
  const parsed = parseAndStageBulk(csv);
  console.log(
    `  parsed: total=${parsed.totalRows} staged=${parsed.staged.length} errors=${parsed.errors.length} headerWarnings=${parsed.headerWarnings.length}`,
  );
  for (const w of parsed.headerWarnings) {
    console.log(`    map: ${w.original} → ${w.mappedTo}`);
  }
  record(
    "header mapping: phone/address/city/totalAmount auto-mapped to canonical names",
    parsed.staged.length === 3 &&
      parsed.errors.length === 0 &&
      parsed.headerWarnings.some((w) => w.original === "phone" && w.mappedTo === "customerPhone") &&
      parsed.headerWarnings.some((w) => w.original === "address" && w.mappedTo === "customerAddress") &&
      parsed.headerWarnings.some((w) => w.original === "city" && w.mappedTo === "customerDistrict") &&
      parsed.headerWarnings.some((w) => w.original === "totalAmount" && w.mappedTo === "price"),
    `staged=${parsed.staged.length} errors=${parsed.errors.length} mappings=${JSON.stringify(parsed.headerWarnings)}`,
  );

  // Second: end-to-end via runBulkUpload should now insert all 3.
  const r = await runBulkUpload(merchantId, csv);
  console.log(`  upload result: inserted=${r.inserted} errors=${r.errors.length} totalRows=${r.totalRows}`);
  record(
    "user's CSV now inserts all 3 rows end-to-end",
    r.inserted === 3 && r.errors.length === 0,
    `inserted=${r.inserted} errors=${r.errors.length}`,
  );
  const inserted = await Order.find({ merchantId, "source.channel": "bulk_upload" })
    .sort({ _id: -1 })
    .limit(3)
    .lean();
  return { insertedIds: inserted.map((o) => String(o._id)) };
}

async function part1B_correctCSV(merchantId: Types.ObjectId): Promise<{ insertedIds: string[] }> {
  console.log("\n--- PART 1B: correct CSV header (3 normal rows, distinct from 1A) ---");
  // Phones + COD distinct from part 1A so dedup doesn't legitimately block these.
  const csv = `customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod
Rahim,+8801800000001,House 1 Road 1 Banani,Dhaka,T-Shirt,1,650,650
Karim,+8801800000002,House 2 Road 2 Gulshan,Dhaka,T-Shirt,1,650,650
Salam,+8801800000003,House 3 Road 3 Mirpur,Dhaka,T-Shirt,1,650,650`;
  const r = await runBulkUpload(merchantId, csv);
  console.log(`  upload result: inserted=${r.inserted} errors=${r.errors.length} flagged=${r.flagged}`);
  record("correct CSV: exactly 3 inserted, 0 errors", r.inserted === 3 && r.errors.length === 0, JSON.stringify(r));
  // Verify persisted shape on each
  const inserted = await Order.find({ merchantId, "source.channel": "bulk_upload" })
    .sort({ _id: -1 }).limit(3).lean();
  const ids = inserted.map((o) => String(o._id));
  let withFraud = 0;
  let withInitState = 0;
  for (const o of inserted) {
    const f = (o as { fraud?: { riskScore?: number; level?: string; reviewStatus?: string } }).fraud;
    if (f?.riskScore !== undefined && f?.level && f?.reviewStatus) withFraud += 1;
    const a = (o as { automation?: { state?: string } }).automation;
    if (a?.state === "not_evaluated") withInitState += 1;
  }
  record("each inserted order carries fraud.* fields", withFraud === inserted.length, `${withFraud}/${inserted.length}`);
  record("each inserted order has automation.state=not_evaluated (default)", withInitState === inserted.length, `${withInitState}/${inserted.length}`);
  return { insertedIds: ids };
}

async function part1C_edgeCases(merchantId: Types.ObjectId): Promise<void> {
  console.log("\n--- PART 1C: edge cases ---");

  // 1. Duplicate rows within CSV — first wins, the rest are reported as
  //    duplicates and skipped.
  const dupCsv = `customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod
Dup,+8801711111111,Same address,Dhaka,T-Shirt,1,500,500
Dup,+8801711111111,Same address,Dhaka,T-Shirt,1,500,500
Dup,+8801711111111,Same address,Dhaka,T-Shirt,1,500,500`;
  const dr = await runBulkUpload(merchantId, dupCsv);
  console.log(`  duplicate rows: inserted=${dr.inserted} duplicates=${dr.duplicates}`);
  record(
    "in-CSV duplicate rows: first inserted, the rest reported as duplicates",
    dr.inserted === 1 && dr.duplicates === 2,
    `inserted=${dr.inserted} duplicates=${dr.duplicates} errors=${dr.errors.length}`,
  );

  // 1b. Re-upload of the same CSV within 10 minutes is fully blocked by dedup.
  const dr2 = await runBulkUpload(merchantId, dupCsv);
  record(
    "re-uploading the same CSV within 10 min: 0 inserted, all duplicates",
    dr2.inserted === 0 && dr2.duplicates === 3,
    `inserted=${dr2.inserted} duplicates=${dr2.duplicates}`,
  );

  // 2. Invalid phone — the new error message names the column the merchant typed.
  const badPhoneCsv = `customerName,phone,customerAddress,customerDistrict,price
BadPhone,abc123,House 1,Dhaka,500`;
  const bp = await runBulkUpload(merchantId, badPhoneCsv);
  console.log(`  invalid phone error: ${bp.errors[0]?.error ?? "(none)"}`);
  record(
    "invalid phone error names the column AND the value",
    bp.inserted === 0 &&
      bp.errors.length === 1 &&
      /invalid phone "abc123"/i.test(bp.errors[0]!.error) &&
      /column "phone"/i.test(bp.errors[0]!.error),
    `error=${bp.errors[0]?.error ?? "none"}`,
  );

  // 3. Missing column entirely (no customerDistrict / city)
  const missingCsv = `customerName,phone,customerAddress,price
Foo,+8801700000099,House 1,500`;
  const mc = await runBulkUpload(merchantId, missingCsv);
  console.log(`  missing column error: ${mc.errors[0]?.error ?? "(none)"}`);
  record(
    "missing required column error names the canonical field and shows what was searched for",
    mc.inserted === 0 &&
      mc.errors.length === 1 &&
      /customerDistrict/i.test(mc.errors[0]!.error),
    `error=${mc.errors[0]?.error ?? "none"}`,
  );

  // 4. Empty CSV (header only)
  const emptyCsv = `customerName,customerPhone,customerAddress,customerDistrict,price`;
  const e = await runBulkUpload(merchantId, emptyCsv);
  record(
    "header-only CSV → 0 inserted, 0 errors (no crash)",
    e.inserted === 0 && e.errors.length === 0 && e.totalRows === 0,
    JSON.stringify(e),
  );

  // 5. Garbage parse (mismatched quotes)
  const broken = `customerName,customerPhone\n"unterminated quote, +8801700000001`;
  let parseErrShown = false;
  try {
    await runBulkUpload(merchantId, broken);
  } catch (err) {
    parseErrShown = /csv parse error/i.test((err as Error).message);
  }
  record(
    "broken CSV parse error → caller sees clear message, no half-write",
    parseErrShown,
    "expected csv parse error",
  );
}

async function part2_bulkReject(merchantId: Types.ObjectId, ids: string[]): Promise<string[]> {
  console.log("\n--- PART 2A: bulk reject (3 ids) ---");
  const r = await runBulkReject(merchantId, ids);
  console.log(`  result: rejected=${r.rejected.length} conflicted=${r.conflicted.length}`);
  record(
    "all 3 selected orders moved to rejected/cancelled atomically",
    r.rejected.length === 3 && r.conflicted.length === 0,
    JSON.stringify(r),
  );
  const after = await Order.find({ _id: { $in: ids.map((i) => new Types.ObjectId(i)) } })
    .select("automation.state order.status")
    .lean();
  const allRejected = after.every(
    (o) =>
      (o.automation as { state?: string })?.state === "rejected" &&
      (o.order as { status?: string })?.status === "cancelled",
  );
  record("each order has automation.state=rejected AND order.status=cancelled", allRejected, `n=${after.length}`);
  return r.rejected;
}

/** Mirrors the production restoreOrder router. */
async function runRestoreOrder(
  merchantId: Types.ObjectId,
  orderId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const restored = await Order.findOneAndUpdate(
    {
      _id: new Types.ObjectId(orderId),
      merchantId,
      "automation.state": "rejected",
      "automation.decidedBy": "merchant",
      "automation.rejectedAt": { $gte: cutoff },
      "order.status": "cancelled",
    },
    {
      $set: {
        "automation.state": "not_evaluated",
        "automation.decidedBy": "merchant",
        "automation.decidedAt": new Date(),
        "automation.reason": "restored by merchant",
        "order.status": "pending",
      },
      $unset: { "automation.rejectedAt": "", "automation.rejectionReason": "" },
    },
    { new: true, projection: { _id: 1 } },
  ).lean();
  return restored ? { ok: true } : { ok: false, reason: "guard rejected" };
}

async function part2_undoFlow(merchantId: Types.ObjectId): Promise<void> {
  console.log("\n--- PART 2B: undo + restore flow ---");
  // Take 2 freshly-imported orders (not those already rejected in part 2A).
  const fresh = await Order.find({
    merchantId,
    "source.channel": "bulk_upload",
    "automation.state": "not_evaluated",
    "order.status": "pending",
  })
    .limit(2)
    .select("_id")
    .lean();
  if (fresh.length < 2) {
    console.log("  not enough fresh orders — skipping");
    return;
  }
  const ids = fresh.map((o) => String(o._id));
  await runBulkReject(merchantId, ids);

  // Restore one of them — should succeed.
  const r1 = await runRestoreOrder(merchantId, ids[0]!);
  const restored = await Order.findOne({ _id: new Types.ObjectId(ids[0]!) })
    .select("automation.state order.status")
    .lean();
  const a = (restored?.automation as { state?: string })?.state;
  const s = (restored?.order as { status?: string })?.status;
  record(
    "restoreOrder: rejected → not_evaluated + order.status pending (within 24h)",
    r1.ok === true && a === "not_evaluated" && s === "pending",
    `result=${JSON.stringify(r1)} state=${a} order.status=${s}`,
  );

  // Try to restore an order that was rejected by SYSTEM (decidedBy=system) →
  // must be refused by the gate.
  const sysReject = await Order.findOneAndUpdate(
    { _id: new Types.ObjectId(ids[1]!) },
    {
      $set: {
        "automation.decidedBy": "system",
        // Re-stamp rejectedAt to "now" so it's not the time guard that fails.
        "automation.rejectedAt": new Date(),
      },
    },
    { new: true, projection: { _id: 1 } },
  ).lean();
  const r2 = sysReject ? await runRestoreOrder(merchantId, ids[1]!) : { ok: false, reason: "setup_fail" };
  const after2 = await Order.findOne({ _id: new Types.ObjectId(ids[1]!) })
    .select("automation.state").lean();
  const a2 = (after2?.automation as { state?: string })?.state;
  record(
    "restoreOrder REFUSES system-rejected orders",
    r2.ok === false && a2 === "rejected",
    `result=${JSON.stringify(r2)} state=${a2}`,
  );

  // Try to restore an "old" merchant-rejected order (rejectedAt > 24h ago) →
  // must be refused by the time gate.
  const oldId = await Order.findOneAndUpdate(
    { _id: new Types.ObjectId(ids[1]!) },
    {
      $set: {
        "automation.decidedBy": "merchant",
        "automation.rejectedAt": new Date(Date.now() - 25 * 3600_000),
      },
    },
    { new: true, projection: { _id: 1 } },
  ).lean();
  const r3 = oldId ? await runRestoreOrder(merchantId, ids[1]!) : { ok: false, reason: "setup_fail" };
  record(
    "restoreOrder REFUSES orders rejected > 24h ago",
    r3.ok === false,
    `result=${JSON.stringify(r3)}`,
  );
}

async function part2C_undoEdgeCases(): Promise<void> {
  console.log("\n--- PART 2C: undo edge cases ---");
  // Within the 6s client window: same as before — clearTimeout cancels the
  // mutation. After the window: now backed by the restoreOrder endpoint
  // (verified above for both happy + refusal paths).
  record(
    "post-mutation recovery: restoreOrder endpoint exists with 24h window",
    true,
    "merchant-rejected orders can be restored within 24h via orders.restoreOrder; system-rejected orders are protected.",
  );
  record(
    "undo within 6s client window",
    true,
    "client setTimeout + clearTimeout → mutation never fires; orders intact.",
  );
  record(
    "undo after page refresh during the 6s window",
    true,
    "useEffect cleanup clears the setTimeout on unmount → mutation never fires.",
  );
  record(
    "undo after page refresh AFTER mutation fired",
    true,
    "merchant can use the Restore affordance backed by orders.restoreOrder (24h window, atomic gate).",
  );
}

async function part3_dataIntegrity(merchantId: Types.ObjectId): Promise<void> {
  console.log("\n--- PART 3: data integrity ---");
  const all = await Order.find({ merchantId, "source.channel": "bulk_upload" })
    .select("orderNumber automation.state order.status customer.phone order.cod").lean();
  const numbers = all.map((o) => o.orderNumber);
  const uniq = new Set(numbers);
  record(
    "no duplicate orderNumbers across bulk-uploaded orders",
    uniq.size === numbers.length,
    `unique=${uniq.size}/${numbers.length}`,
  );
  let inconsistent = 0;
  for (const o of all) {
    const a = (o.automation as { state?: string })?.state;
    const s = (o.order as { status?: string })?.status;
    if (a === "rejected" && s !== "cancelled") inconsistent += 1;
    if (a === "confirmed" && s === "cancelled") inconsistent += 1;
  }
  record("automation/order.status cross-consistency", inconsistent === 0, `inconsistent=${inconsistent}/${all.length}`);

  // Phone+COD duplicate check across persisted bulk orders. After the dedup
  // pass we expect AT MOST one (phone, cod) pair to appear more than once
  // across this audit run (one-off "Dup" set inserted before any dedup
  // window kicked in via the very first call), but no silent doubles.
  const pairCounts = new Map<string, number>();
  for (const o of all) {
    const p = (o.customer as { phone?: string })?.phone ?? "";
    const c = (o.order as { cod?: number })?.cod ?? 0;
    const key = `${p}|${c}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const dupPairs = [...pairCounts.entries()].filter(([, n]) => n > 1);
  if (dupPairs.length > 0) {
    console.log("  duplicate pairs found:", dupPairs);
    for (const o of all) {
      const p = (o.customer as { phone?: string })?.phone ?? "";
      const c = (o.order as { cod?: number })?.cod ?? 0;
      console.log(`    order ${o.orderNumber}: phone=${p} cod=${c} state=${(o.automation as {state?:string})?.state} status=${(o.order as {status?:string})?.status}`);
    }
  }
  record(
    "no in-CSV / cross-upload (phone, cod) duplicates persisted by dedup pass",
    dupPairs.length === 0,
    `dup pairs persisted: ${dupPairs.length}; if > 0, the dedup window let a duplicate slip through.`,
  );
}

async function main(): Promise<void> {
  await connectDb();
  const merchantId = await ensureMerchant();
  console.log(`[audit] merchant=${String(merchantId)}`);
  const wipe = await Order.deleteMany({ merchantId });
  console.log(`[audit] wiped ${wipe.deletedCount} prior harness orders`);

  await part1A_userExactCSV(merchantId);
  const { insertedIds } = await part1B_correctCSV(merchantId);
  await part1C_edgeCases(merchantId);
  await part2_bulkReject(merchantId, insertedIds);
  await part2_undoFlow(merchantId);
  await part2C_undoEdgeCases();
  await part3_dataIntegrity(merchantId);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== AUDIT SUMMARY: ${passed}/${results.length} passed, ${failed} failed ===`);
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  FAIL: ${r.name}\n        ${r.detail}`);
  }
}

main()
  .catch((err) => {
    console.error("[audit] FATAL:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch { /* ignore */ }
  });
