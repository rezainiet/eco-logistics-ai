import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Merchant, Payment, Usage } from "@ecom/db";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import { invalidateSubscriptionCache } from "../src/server/trpc.js";

async function setTier(
  merchantId: unknown,
  tier: "starter" | "growth" | "scale" | "enterprise",
  status: "trial" | "active" | "past_due" | "paused" | "cancelled" = "active",
) {
  await Merchant.updateOne(
    { _id: merchantId as never },
    {
      $set: {
        "subscription.tier": tier,
        "subscription.status": status,
        "subscription.currentPeriodEnd":
          status === "active" ? new Date(Date.now() + 30 * 86400_000) : null,
      },
    },
  );
  invalidateSubscriptionCache(String(merchantId));
}

const cleanOrder = {
  customer: {
    name: "Karim Ahmed",
    phone: "+8801700000001",
    address: "Road 2, House 5",
    district: "Dhaka",
  },
  items: [{ name: "Shirt", quantity: 1, price: 500 }],
  cod: 500,
};

describe("billingRouter", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("listPlans returns all four tiers with catalogue prices", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const plans = await caller.billing.listPlans();
    expect(plans.map((p) => p.tier)).toEqual(["starter", "growth", "scale", "enterprise"]);
    expect(plans[0]!.priceBDT).toBeGreaterThan(0);
    expect(plans[3]!.features.fraudReview).toBe(true);
    expect(plans[0]!.features.fraudReview).toBe(false);
  });

  it("getPlan returns the merchant's current plan + subscription snapshot", async () => {
    const m = await createMerchant({ tier: "scale" });
    const caller = callerFor(authUserFor(m));
    const res = await caller.billing.getPlan();
    expect(res.plan.tier).toBe("scale");
    expect(res.subscription.status).toBe("active");
    expect(res.plan.features.courierLimit).toBe(6);
  });

  it("getUsage reports zero meters for a brand-new merchant", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const res = await caller.billing.getUsage();
    for (const meter of res.meters) {
      expect(meter.used).toBe(0);
      expect(meter.blocked).toBe(false);
    }
  });

  it("createOrder increments ordersCreated usage counter", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    await caller.orders.createOrder(cleanOrder);
    await caller.orders.createOrder({
      ...cleanOrder,
      customer: { ...cleanOrder.customer, phone: "+8801700000002" },
    });
    const usage = await caller.billing.getUsage();
    const orders = usage.meters.find((x) => x.metric === "ordersCreated");
    expect(orders?.used).toBe(2);
  });

  it("enforces the starter order quota", async () => {
    const m = await createMerchant({ tier: "starter" });
    // Force the counter past starter's 300/mo cap.
    await Usage.create({
      merchantId: m._id,
      period: new Date().toISOString().slice(0, 7),
      ordersCreated: 300,
    });
    const caller = callerFor(authUserFor(m));
    await expect(caller.orders.createOrder(cleanOrder)).rejects.toThrowError(/quota reached/i);
  });

  it("blocks fraud review on the starter plan", async () => {
    const m = await createMerchant({ tier: "starter" });
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.fraud.listPendingReviews({ cursor: null, limit: 25, filter: "all_open" }),
    ).rejects.toThrowError(/not available on the Starter plan/i);
  });

  it("allows fraud review on growth+ plans", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const res = await caller.fraud.listPendingReviews({
      cursor: null,
      limit: 25,
      filter: "all_open",
    });
    expect(res.total).toBe(0);
  });

  it("past_due subscription blocks billable procedures", async () => {
    const m = await createMerchant({ tier: "growth", status: "past_due" });
    const caller = callerFor(authUserFor(m));
    await expect(caller.orders.createOrder(cleanOrder)).rejects.toThrowError(
      /subscription_past_due/i,
    );
  });

  it("expired trial blocks billable procedures", async () => {
    const m = await createMerchant({
      tier: "starter",
      status: "trial",
      trialEndsAt: new Date(Date.now() - 86400_000),
    });
    const caller = callerFor(authUserFor(m));
    await expect(caller.orders.createOrder(cleanOrder)).rejects.toThrowError(/trial_expired/i);
  });

  it("submitPayment creates a pending record and flags subscription.pendingPaymentId", async () => {
    const m = await createMerchant({ tier: "starter" });
    const caller = callerFor(authUserFor(m));
    const res = await caller.billing.submitPayment({
      plan: "growth",
      method: "bkash",
      amount: 2499,
      txnId: "TXN123",
      senderPhone: "+8801700000000",
    });
    expect(res.status).toBe("pending");

    const fresh = await Merchant.findById(m._id).lean();
    expect(fresh?.subscription?.pendingPaymentId).toBeTruthy();

    const payments = await Payment.find({ merchantId: m._id }).lean();
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe("pending");
  });

  it("submitPayment rejects amount below plan minimum", async () => {
    const m = await createMerchant({ tier: "starter" });
    const caller = callerFor(authUserFor(m));
    await expect(
      caller.billing.submitPayment({
        plan: "enterprise",
        method: "bkash",
        amount: 100,
      }),
    ).rejects.toThrowError(/amount below minimum/i);
  });

  it("admin approvePayment activates subscription and sets currentPeriodEnd", async () => {
    const merchant = await createMerchant({ tier: "starter", status: "trial" });
    const admin = await createMerchant({ role: "admin", email: "admin@test.com" });

    const merchantCaller = callerFor(authUserFor(merchant));
    const adminCaller = callerFor(authUserFor(admin));

    const submission = await merchantCaller.billing.submitPayment({
      plan: "growth",
      method: "bkash",
      amount: 2499,
      txnId: "TXN-APPROVE",
    });

    const res = await adminCaller.adminBilling.approvePayment({
      paymentId: submission.id,
      periodDays: 30,
    });
    expect(res.status).toBe("approved");
    expect(res.plan).toBe("growth");

    const fresh = await Merchant.findById(merchant._id).lean();
    expect(fresh?.subscription?.tier).toBe("growth");
    expect(fresh?.subscription?.status).toBe("active");
    expect(fresh?.subscription?.currentPeriodEnd).toBeTruthy();
    expect(fresh?.subscription?.pendingPaymentId).toBeFalsy();
  });

  it("admin rejectPayment clears the pending flag and adds a reviewer note", async () => {
    const merchant = await createMerchant({ tier: "starter", status: "trial" });
    const admin = await createMerchant({ role: "admin", email: "admin2@test.com" });

    const merchantCaller = callerFor(authUserFor(merchant));
    const adminCaller = callerFor(authUserFor(admin));

    const submission = await merchantCaller.billing.submitPayment({
      plan: "growth",
      method: "bkash",
      amount: 2499,
    });

    await adminCaller.adminBilling.rejectPayment({
      paymentId: submission.id,
      reason: "Receipt does not match",
    });

    const fresh = await Merchant.findById(merchant._id).lean();
    expect(fresh?.subscription?.pendingPaymentId).toBeFalsy();

    const payment = await Payment.findById(submission.id).lean();
    expect(payment?.status).toBe("rejected");
    expect(payment?.reviewerNote).toBe("Receipt does not match");
  });

  it("admin extendSubscription pushes currentPeriodEnd forward", async () => {
    const merchant = await createMerchant({ tier: "growth", status: "active" });
    const admin = await createMerchant({ role: "admin", email: "admin3@test.com" });
    const adminCaller = callerFor(authUserFor(admin));

    const before = await Merchant.findById(merchant._id).lean();
    const beforeEnd = before?.subscription?.currentPeriodEnd?.getTime() ?? 0;

    const res = await adminCaller.adminBilling.extendSubscription({
      merchantId: String(merchant._id),
      days: 60,
    });
    expect(res.currentPeriodEnd.getTime()).toBeGreaterThan(beforeEnd);
  });

  it("admin changePlan flips merchant tier without a payment", async () => {
    const merchant = await createMerchant({ tier: "starter" });
    const admin = await createMerchant({ role: "admin", email: "admin4@test.com" });
    const adminCaller = callerFor(authUserFor(admin));

    await adminCaller.adminBilling.changePlan({
      merchantId: String(merchant._id),
      tier: "scale",
    });

    const fresh = await Merchant.findById(merchant._id).lean();
    expect(fresh?.subscription?.tier).toBe("scale");
    expect(fresh?.subscription?.rate).toBeGreaterThan(0);
  });

  it("merchant role cannot call adminBilling routes", async () => {
    const merchant = await createMerchant({ tier: "starter" });
    const caller = callerFor(authUserFor(merchant));
    await expect(
      caller.adminBilling.listPendingPayments({ status: "pending", limit: 10 }),
    ).rejects.toThrowError(/admin role required/i);
  });
});
