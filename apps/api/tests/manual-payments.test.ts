import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { Payment } from "@ecom/db";
import {
  checkManualPaymentSubmitGuard,
  listManualPaymentOptions,
} from "../src/lib/manual-payments.js";
import { createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

describe("listManualPaymentOptions", () => {
  beforeEach(() => {
    delete process.env.PAY_BKASH_NUMBER;
    delete process.env.PAY_NAGAD_NUMBER;
    delete process.env.PAY_BANK_INFO;
    delete process.env.PAY_BKASH_TYPE;
    delete process.env.PAY_NAGAD_TYPE;
    vi.resetModules();
  });

  it("returns three options regardless, with `enabled` reflecting env", async () => {
    process.env.PAY_BKASH_NUMBER = "01700000000";
    process.env.PAY_BKASH_TYPE = "Send Money";
    vi.resetModules();
    const m = await import("../src/lib/manual-payments.js");
    const opts = m.listManualPaymentOptions();
    expect(opts.map((o) => o.method)).toEqual(["bkash", "nagad", "bank_transfer"]);
    expect(opts.find((o) => o.method === "bkash")!.enabled).toBe(true);
    expect(opts.find((o) => o.method === "bkash")!.destination).toBe("01700000000");
    expect(opts.find((o) => o.method === "bkash")!.hint).toBe("Send Money");
    expect(opts.find((o) => o.method === "nagad")!.enabled).toBe(false);
    expect(opts.find((o) => o.method === "bank_transfer")!.enabled).toBe(false);
  });

  it("each option carries a non-empty step list", () => {
    const opts = listManualPaymentOptions();
    for (const o of opts) {
      expect(o.instructions.length).toBeGreaterThan(0);
      for (const step of o.instructions) {
        expect(step.length).toBeGreaterThan(5);
      }
    }
  });
});

describe("checkManualPaymentSubmitGuard", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
  });
  afterAll(disconnectDb);

  it("permits the first submission for a fresh merchant", async () => {
    const m = await createMerchant();
    const r = await checkManualPaymentSubmitGuard({
      merchantId: m._id as Types.ObjectId,
      method: "bkash",
      txnId: "TX-1",
    });
    expect(r.ok).toBe(true);
  });

  it("blocks once the daily cap is reached", async () => {
    const m = await createMerchant();
    // PAY_MANUAL_DAILY_CAP defaults to 3 — pre-create 3 manual rows.
    for (let i = 0; i < 3; i += 1) {
      await Payment.create({
        merchantId: m._id,
        plan: "starter",
        amount: 999,
        currency: "BDT",
        method: "bkash",
        provider: "manual",
        txnId: `T${i}`,
        status: "pending",
      });
    }
    const r = await checkManualPaymentSubmitGuard({
      merchantId: m._id as Types.ObjectId,
      method: "bkash",
      txnId: "TX-NEW",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("daily_cap");
    }
  });

  it("rejects a duplicate txnId for the same method", async () => {
    const m = await createMerchant();
    await Payment.create({
      merchantId: m._id,
      plan: "starter",
      amount: 999,
      currency: "BDT",
      method: "bkash",
      provider: "manual",
      txnId: "DUP-1",
      status: "pending",
    });
    const r = await checkManualPaymentSubmitGuard({
      merchantId: m._id as Types.ObjectId,
      method: "bkash",
      txnId: "DUP-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("duplicate_txn");
    }
  });

  it("does NOT collide on the same txnId once the prior row is rejected", async () => {
    const m = await createMerchant();
    await Payment.create({
      merchantId: m._id,
      plan: "starter",
      amount: 999,
      currency: "BDT",
      method: "bkash",
      provider: "manual",
      txnId: "REJECTED-1",
      status: "rejected",
    });
    const r = await checkManualPaymentSubmitGuard({
      merchantId: m._id as Types.ObjectId,
      method: "bkash",
      txnId: "REJECTED-1",
    });
    expect(r.ok).toBe(true);
  });

  it("counts only this merchant for the cap (tenant-isolated)", async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    for (let i = 0; i < 3; i += 1) {
      await Payment.create({
        merchantId: a._id,
        plan: "starter",
        amount: 999,
        currency: "BDT",
        method: "bkash",
        provider: "manual",
        txnId: `A-${i}`,
        status: "pending",
      });
    }
    // Merchant B has zero rows — should still be allowed.
    const r = await checkManualPaymentSubmitGuard({
      merchantId: b._id as Types.ObjectId,
      method: "bkash",
      txnId: "B-NEW",
    });
    expect(r.ok).toBe(true);
  });

  it("ignores Stripe rows when computing the manual cap", async () => {
    const m = await createMerchant();
    // 5 stripe-provider rows — should not count.
    for (let i = 0; i < 5; i += 1) {
      await Payment.create({
        merchantId: m._id,
        plan: "starter",
        amount: 999,
        currency: "BDT",
        method: "card",
        provider: "stripe",
        txnId: `S-${i}`,
        status: "approved",
      });
    }
    const r = await checkManualPaymentSubmitGuard({
      merchantId: m._id as Types.ObjectId,
      method: "bkash",
      txnId: "M-1",
    });
    expect(r.ok).toBe(true);
  });
});
