import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AuditLog, Merchant, Payment } from "@ecom/db";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import {
  invalidateAdminProfile,
} from "../src/lib/admin-rbac.js";
import { issueStepupToken } from "../src/lib/admin-stepup.js";
import { computeAuditHash, verifyAuditChain } from "../src/lib/audit.js";
import {
  computeMetadataHash,
  computeProofHash,
  normalizeTxnId,
  scorePaymentRisk,
} from "../src/lib/manual-payments.js";
import { runAnomalyDetection } from "../src/lib/anomaly.js";

/**
 * Bootstrap a fully-credentialed admin merchant. By default we hand over
 * super_admin (which implies all permissions); pass narrower scopes to
 * test scope-specific failures.
 */
async function createAdmin(opts?: {
  scopes?: ("super_admin" | "finance_admin" | "support_admin")[];
}) {
  const m = await createMerchant({ role: "admin" });
  await Merchant.updateOne(
    { _id: m._id },
    { $set: { adminScopes: opts?.scopes ?? ["super_admin"] } },
  );
  invalidateAdminProfile(String(m._id));
  return m;
}

async function freshStepup(
  userId: string,
  permission:
    | "payment.approve"
    | "payment.reject"
    | "merchant.suspend"
    | "fraud.override"
    | "admin.grant_scope"
    | "admin.revoke_scope",
) {
  const { token } = await issueStepupToken(userId, permission);
  return token;
}

async function submitTestPayment(merchantId: Types.ObjectId, overrides: Partial<{
  amount: number;
  txnId: string;
  proofHash: string;
  metadataHash: string;
  riskScore: number;
  requiresDualApproval: boolean;
  status: "pending" | "reviewed" | "approved";
}> = {}) {
  return Payment.create({
    merchantId,
    plan: "growth",
    amount: overrides.amount ?? 999,
    currency: "BDT",
    method: "bkash",
    txnId: overrides.txnId ?? "TX1",
    txnIdNorm: overrides.txnId
      ? normalizeTxnId(overrides.txnId)
      : normalizeTxnId("TX1"),
    metadataHash: overrides.metadataHash ?? "metahash1",
    proofHash: overrides.proofHash,
    riskScore: overrides.riskScore ?? 0,
    requiresDualApproval: overrides.requiresDualApproval ?? false,
    status: overrides.status ?? "pending",
    provider: "manual",
  });
}

describe("admin RBAC + step-up", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("non-admin merchant cannot reach admin routes", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    await expect(caller.adminBilling.listPendingPayments()).rejects.toThrow(
      /admin role required/,
    );
  });

  it("admin without finance scope cannot list pending payments", async () => {
    const admin = await createAdmin({ scopes: ["support_admin"] });
    const caller = callerFor(authUserFor(admin));
    await expect(caller.adminBilling.listPendingPayments()).rejects.toThrow(
      /missing scope/,
    );
  });

  it("finance admin CAN list pending payments", async () => {
    const admin = await createAdmin({ scopes: ["finance_admin"] });
    const caller = callerFor(authUserFor(admin));
    const result = await caller.adminBilling.listPendingPayments();
    expect(Array.isArray(result)).toBe(true);
  });

  it("super_admin implies every other scope", async () => {
    const admin = await createAdmin({ scopes: ["super_admin"] });
    const caller = callerFor(authUserFor(admin));
    expect(Array.isArray(await caller.adminBilling.listPendingPayments())).toBe(
      true,
    );
    const me = await caller.adminAccess.whoami();
    expect(me.scopes).toContain("super_admin");
  });

  it("unauthorized attempts emit an audit row", async () => {
    const admin = await createAdmin({ scopes: ["support_admin"] });
    const caller = callerFor(authUserFor(admin));
    await expect(
      caller.adminBilling.listPendingPayments(),
    ).rejects.toThrow(/missing scope/);
    // The audit write is fire-and-forget; give Mongoose a tick.
    await new Promise((r) => setTimeout(r, 50));
    const row = await AuditLog.findOne({
      action: "admin.unauthorized_attempt",
      actorId: admin._id,
    }).lean();
    expect(row).toBeTruthy();
    expect((row?.meta as { permission?: string })?.permission).toBe(
      "payment.review",
    );
  });

  it("approvePayment without confirmationToken rejects", async () => {
    const admin = await createAdmin();
    const merchant = await createMerchant({ status: "trial" });
    const payment = await submitTestPayment(merchant._id, {
      status: "reviewed",
    });
    const caller = callerFor(authUserFor(admin));
    await expect(
      caller.adminBilling.approvePayment({
        paymentId: String(payment._id),
        periodDays: 30,
        confirmationToken: "deadbeefdead",
      }),
    ).rejects.toThrow(/step-up confirmation/);
  });

  it("approvePayment cannot reuse a step-up token", async () => {
    const admin = await createAdmin();
    const merchant = await createMerchant({ status: "trial" });
    const p1 = await submitTestPayment(merchant._id, {
      status: "reviewed",
      txnId: "T-A",
    });
    const p2 = await submitTestPayment(merchant._id, {
      status: "reviewed",
      txnId: "T-B",
      metadataHash: "metahash2",
    });
    const token = await freshStepup(String(admin._id), "payment.approve");
    const caller = callerFor(authUserFor(admin));
    const ok1 = await caller.adminBilling.approvePayment({
      paymentId: String(p1._id),
      periodDays: 30,
      confirmationToken: token,
    });
    expect(ok1.status).toBe("approved");
    await expect(
      caller.adminBilling.approvePayment({
        paymentId: String(p2._id),
        periodDays: 30,
        confirmationToken: token,
      }),
    ).rejects.toThrow(/step-up confirmation/);
  });

  it("approvePayment requires the payment to be reviewed first", async () => {
    const admin = await createAdmin();
    const merchant = await createMerchant();
    const payment = await submitTestPayment(merchant._id, { status: "pending" });
    const token = await freshStepup(String(admin._id), "payment.approve");
    const caller = callerFor(authUserFor(admin));
    await expect(
      caller.adminBilling.approvePayment({
        paymentId: String(payment._id),
        periodDays: 30,
        confirmationToken: token,
      }),
    ).rejects.toThrow(/mark this payment as reviewed/);
  });
});

describe("admin payment approval workflow", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("low-risk payment: review then single approval activates", async () => {
    const admin = await createAdmin();
    const merchant = await createMerchant({ status: "trial" });
    const payment = await submitTestPayment(merchant._id);
    const caller = callerFor(authUserFor(admin));
    const reviewed = await caller.adminBilling.markReviewed({
      paymentId: String(payment._id),
    });
    expect(reviewed.status).toBe("reviewed");
    const token = await freshStepup(String(admin._id), "payment.approve");
    const approved = await caller.adminBilling.approvePayment({
      paymentId: String(payment._id),
      periodDays: 30,
      confirmationToken: token,
    });
    expect(approved.status).toBe("approved");
    expect(approved.stage).toBe("final");
    const updated = await Merchant.findById(merchant._id).lean();
    expect(updated?.subscription?.status).toBe("active");
  });

  it("high-risk payment: requires dual approval from different admins", async () => {
    const admin1 = await createAdmin({ scopes: ["finance_admin"] });
    const admin2 = await createAdmin({ scopes: ["finance_admin"] });
    const merchant = await createMerchant({ status: "trial" });
    const payment = await submitTestPayment(merchant._id, {
      requiresDualApproval: true,
      riskScore: 75,
      status: "reviewed",
    });

    // First admin approves
    const t1 = await freshStepup(String(admin1._id), "payment.approve");
    const c1 = callerFor(authUserFor(admin1));
    const stage1 = await c1.adminBilling.approvePayment({
      paymentId: String(payment._id),
      periodDays: 30,
      confirmationToken: t1,
    });
    expect(stage1.stage).toBe("first_approval");
    expect(stage1.status).toBe("reviewed");

    // Same admin trying twice: blocked
    const t1b = await freshStepup(String(admin1._id), "payment.approve");
    await expect(
      c1.adminBilling.approvePayment({
        paymentId: String(payment._id),
        periodDays: 30,
        confirmationToken: t1b,
      }),
    ).rejects.toThrow(/second admin/);

    // Different admin completes the dual approval
    const t2 = await freshStepup(String(admin2._id), "payment.approve");
    const c2 = callerFor(authUserFor(admin2));
    const stage2 = await c2.adminBilling.approvePayment({
      paymentId: String(payment._id),
      periodDays: 30,
      confirmationToken: t2,
    });
    expect(stage2.stage).toBe("final");
    expect(stage2.status).toBe("approved");
  });
});

describe("manual payment hardening", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("normalizeTxnId lowercases and trims", () => {
    expect(normalizeTxnId("  TX-12345  ")).toBe("tx-12345");
    expect(normalizeTxnId("ABC 123")).toBe("abc123");
    expect(normalizeTxnId(null)).toBe("");
  });

  it("computeProofHash collides only on identical bytes", () => {
    const a = computeProofHash({ data: "aGVsbG8=" });
    const b = computeProofHash({ data: "aGVsbG8=" });
    const c = computeProofHash({ data: "d29ybGQ=" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(computeProofHash(null)).toBeNull();
  });

  it("computeMetadataHash is stable under whitespace / casing changes to phone", () => {
    const a = computeMetadataHash({
      method: "bkash",
      txnIdNorm: "tx1",
      senderPhone: "+8801700000001",
      amount: 999,
    });
    const b = computeMetadataHash({
      method: "bkash",
      txnIdNorm: "tx1",
      senderPhone: "+880-170-000-0001",
      amount: 999,
    });
    expect(a).toBe(b);
  });

  it("scorePaymentRisk fires cross-merchant proof reuse", async () => {
    const m1 = await createMerchant();
    const m2 = await createMerchant();
    await Payment.create({
      merchantId: m1._id,
      plan: "growth",
      amount: 999,
      method: "bkash",
      proofHash: "shared-proof-hash",
      txnIdNorm: "tx1",
      metadataHash: "meta1",
      status: "pending",
      provider: "manual",
    });
    const result = await scorePaymentRisk({
      merchantId: m2._id as Types.ObjectId,
      method: "bkash",
      txnIdNorm: "tx2",
      proofHash: "shared-proof-hash",
      metadataHash: "meta2",
      hasProof: true,
      amount: 999,
      expectedAmount: 999,
      senderPhone: "+8801700000001",
      merchantAgeDays: 30,
    });
    expect(result.reasons).toContain("proof_file_reused_across_merchants");
    expect(result.score).toBeGreaterThanOrEqual(35);
  });

  it("scorePaymentRisk: cross-merchant txnId + metadata both fire", async () => {
    const m1 = await createMerchant();
    const m2 = await createMerchant();
    // Seed a high-value pending payment from m1 with the colliding hashes.
    await Payment.create({
      merchantId: m1._id,
      plan: "growth",
      amount: 6000,
      method: "bkash",
      txnIdNorm: "duplicate-tx",
      metadataHash: "shared-meta-hash",
      status: "pending",
      provider: "manual",
    });
    // m2 attempts to claim the same txn + metadata at high value with no
    // proof attached → triple-collision (txn + metadata) plus "no proof
    // high value" (>5000) plus "high_value_payment" (>=5000). Sum easily
    // crosses the 60-point dual-approval threshold.
    const result = await scorePaymentRisk({
      merchantId: m2._id as Types.ObjectId,
      method: "bkash",
      txnIdNorm: "duplicate-tx",
      proofHash: null,
      metadataHash: "shared-meta-hash",
      hasProof: false,
      amount: 6000,
      expectedAmount: 6000,
      senderPhone: "+8801700000001",
      merchantAgeDays: 30,
    });
    expect(result.reasons).toContain("txn_id_reused_across_merchants");
    expect(result.reasons).toContain("metadata_reused_across_merchants");
    expect(result.requiresDualApproval).toBe(true);
  });

  it("submitPayment hard-blocks cross-merchant metadata reuse", async () => {
    const m1 = await createMerchant({ status: "trial" });
    const m2 = await createMerchant({ status: "trial" });
    const c1 = callerFor(authUserFor(m1));
    const c2 = callerFor(authUserFor(m2));
    await c1.billing.submitPayment({
      plan: "starter",
      method: "bkash",
      amount: 999,
      txnId: "BX-100",
      senderPhone: "+8801700000099",
    });
    await expect(
      c2.billing.submitPayment({
        plan: "starter",
        method: "bkash",
        amount: 999,
        txnId: "BX-100", // same txn → cross-merchant guard
        senderPhone: "+8801700000099",
      }),
    ).rejects.toThrow();
  });

  it("submitPayment computes risk + persists fingerprints", async () => {
    const m1 = await createMerchant({ status: "trial" });
    const m2 = await createMerchant({ status: "trial" });
    const c1 = callerFor(authUserFor(m1));
    await c1.billing.submitPayment({
      plan: "starter",
      method: "bkash",
      amount: 999,
      txnId: "BX-200",
      senderPhone: "+8801700000200",
    });
    const c2 = callerFor(authUserFor(m2));
    const submitted = await c2.billing.submitPayment({
      plan: "starter",
      method: "bkash",
      amount: 999,
      txnId: "BX-201",
      senderPhone: "+8801700000201",
    });
    const row = await Payment.findById(submitted.id).lean();
    expect(row?.metadataHash).toBeTruthy();
    expect(row?.txnIdNorm).toBe("bx-201");
  });
});

describe("audit log immutability + chain", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("refuses updateOne on an existing row", async () => {
    const merchant = await createMerchant();
    await AuditLog.create({
      merchantId: merchant._id,
      action: "payment.submitted",
      subjectType: "payment",
      subjectId: new Types.ObjectId(),
      at: new Date(),
      selfHash: "x".repeat(64),
      prevHash: "0".repeat(64),
    });
    await expect(
      AuditLog.updateOne(
        { merchantId: merchant._id },
        { $set: { action: "payment.approved" } },
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses deleteOne / deleteMany", async () => {
    const merchant = await createMerchant();
    await AuditLog.create({
      merchantId: merchant._id,
      action: "payment.submitted",
      subjectType: "payment",
      subjectId: new Types.ObjectId(),
      at: new Date(),
    });
    await expect(
      AuditLog.deleteOne({ merchantId: merchant._id }),
    ).rejects.toThrow(/append-only/);
    await expect(AuditLog.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it("refuses re-saving an existing document", async () => {
    const merchant = await createMerchant();
    const row = await AuditLog.create({
      merchantId: merchant._id,
      action: "payment.submitted",
      subjectType: "payment",
      subjectId: new Types.ObjectId(),
      at: new Date(),
    });
    row.action = "payment.approved";
    await expect(row.save()).rejects.toThrow(/append-only/);
  });

  it("computeAuditHash is deterministic and field-sensitive", () => {
    const at = new Date("2025-01-01T00:00:00Z");
    const subjectId = new Types.ObjectId();
    const a = computeAuditHash({
      action: "payment.approved",
      subjectType: "payment",
      subjectId,
      at,
      prevHash: "0".repeat(64),
    });
    const b = computeAuditHash({
      action: "payment.approved",
      subjectType: "payment",
      subjectId,
      at,
      prevHash: "0".repeat(64),
    });
    expect(a).toBe(b);
    const c = computeAuditHash({
      action: "payment.rejected",
      subjectType: "payment",
      subjectId,
      at,
      prevHash: "0".repeat(64),
    });
    expect(c).not.toBe(a);
  });

  it("verifyAuditChain detects tampering", async () => {
    // Write three legitimate admin-flavored audits via the workflow.
    const admin = await createAdmin();
    const merchant = await createMerchant({ status: "trial" });
    const payment = await submitTestPayment(merchant._id);
    const caller = callerFor(authUserFor(admin));
    await caller.adminBilling.markReviewed({ paymentId: String(payment._id) });
    const token = await freshStepup(String(admin._id), "payment.approve");
    await caller.adminBilling.approvePayment({
      paymentId: String(payment._id),
      periodDays: 30,
      confirmationToken: token,
    });
    // Chain should verify clean.
    const before = await verifyAuditChain({});
    expect(before.ok).toBe(true);

    // Tamper with a row using direct collection access (bypasses hooks).
    const coll = AuditLog.collection;
    const target = await coll.findOne({ action: "payment.approved" });
    if (!target) throw new Error("expected target row");
    await coll.updateOne(
      { _id: target._id },
      { $set: { meta: { tampered: true } } },
    );

    const after = await verifyAuditChain({});
    expect(after.ok).toBe(false);
    expect(after.firstBreakAt).toBeTruthy();
    expect(after.message).toMatch(/selfHash mismatch|prevHash chain broken/);
  });
});

describe("anomaly detection", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("payment spike fires alert when short-window count clears the floor", async () => {
    const merchant = await createMerchant();
    // 12 payments in the last hour — clears floor (10) and absent baseline.
    for (let i = 0; i < 12; i++) {
      await Payment.create({
        merchantId: merchant._id,
        plan: "growth",
        amount: 999,
        method: "bkash",
        status: "pending",
        provider: "manual",
        createdAt: new Date(Date.now() - 5 * 60_000 * (i + 1)),
      } as never);
    }
    const fired = await runAnomalyDetection();
    const kinds = fired.map((f) => f.kind);
    expect(kinds).toContain("payment_spike");
    const audit = await AuditLog.findOne({
      action: "alert.fired",
      "meta.kind": "payment_spike",
    }).lean();
    expect(audit).toBeTruthy();
  });

  it("alert.fired dedupes within the same hour bucket", async () => {
    const merchant = await createMerchant();
    for (let i = 0; i < 12; i++) {
      await Payment.create({
        merchantId: merchant._id,
        plan: "growth",
        amount: 999,
        method: "bkash",
        status: "pending",
        provider: "manual",
      } as never);
    }
    const first = await runAnomalyDetection();
    const second = await runAnomalyDetection();
    const firstKinds = first.map((a) => a.kind);
    const secondKinds = second.map((a) => a.kind);
    expect(firstKinds).toContain("payment_spike");
    expect(secondKinds).not.toContain("payment_spike");
  });
});

describe("admin scope grants", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("super_admin can grant scopes on another merchant", async () => {
    const root = await createAdmin({ scopes: ["super_admin"] });
    const subject = await createMerchant();
    const caller = callerFor(authUserFor(root));
    const result = await caller.adminAccess.grantScopes({
      targetMerchantId: String(subject._id),
      scopes: ["finance_admin"],
    });
    expect(result.role).toBe("admin");
    expect(result.scopes).toEqual(["finance_admin"]);
  });

  it("non-super admin cannot grant scopes", async () => {
    const finance = await createAdmin({ scopes: ["finance_admin"] });
    const subject = await createMerchant();
    const caller = callerFor(authUserFor(finance));
    await expect(
      caller.adminAccess.grantScopes({
        targetMerchantId: String(subject._id),
        scopes: ["support_admin"],
      }),
    ).rejects.toThrow(/missing scope|admin role required/);
  });

  it("super_admin cannot modify their own scopes", async () => {
    const root = await createAdmin({ scopes: ["super_admin"] });
    const caller = callerFor(authUserFor(root));
    await expect(
      caller.adminAccess.grantScopes({
        targetMerchantId: String(root._id),
        scopes: [],
      }),
    ).rejects.toThrow(/cannot modify your own scopes/);
  });
});
