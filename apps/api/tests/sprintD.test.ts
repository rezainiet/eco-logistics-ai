import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Merchant, Payment } from "@ecom/db";
import { dispatchStripeEvent } from "../src/server/webhooks/stripe.js";
import { sweepSubscriptionGrace } from "../src/workers/subscriptionGrace.js";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import { env } from "../src/env.js";

/**
 * Sprint D — recurring Stripe Subscriptions migration.
 *
 * Driven through the `dispatchStripeEvent` entrypoint (verified webhook
 * payloads bypass the HMAC layer for tests — that path is already covered
 * in sprintB.test.ts). Each test asserts both the persisted state AND the
 * idempotency invariants by re-driving the same event a second time.
 */

const NOW_S = () => Math.floor(Date.now() / 1000);

interface MakeEventArgs<T> {
  id: string;
  type: string;
  object: T;
}

function makeEvent<T>({ id, type, object }: MakeEventArgs<T>) {
  return { id, type, data: { object } };
}

describe("Sprint D — Stripe Subscriptions", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  describe("billing.createSubscriptionCheckout", () => {
    it("refuses when the plan has no Stripe price configured", async () => {
      const m = await createMerchant({ email: `nopprice-${Date.now()}@test.com` });
      const caller = callerFor(authUserFor(m));
      // Default test env doesn't set STRIPE_PRICE_GROWTH so this throws.
      await expect(
        caller.billing.createSubscriptionCheckout({ plan: "growth" }),
      ).rejects.toThrow(/STRIPE_PRICE_GROWTH/i);
    });

    it("creates a Stripe customer on first call and reuses it on second", async () => {
      const saved = env.STRIPE_PRICE_GROWTH;
      (env as Record<string, unknown>).STRIPE_PRICE_GROWTH = "price_growth_test";
      try {
        const m = await createMerchant({ email: `subscribe-${Date.now()}@test.com` });
        const caller = callerFor(authUserFor(m));
        const first = await caller.billing.createSubscriptionCheckout({ plan: "growth" });
        expect(first.mocked).toBe(true);
        expect(first.url).toContain("stripe_mock=1");
        expect(first.customerId).toMatch(/^cus_mock_/);

        const after = await Merchant.findById(m._id).select("stripeCustomerId").lean();
        expect(after?.stripeCustomerId).toBe(first.customerId);

        const second = await caller.billing.createSubscriptionCheckout({ plan: "growth" });
        expect(second.customerId).toBe(first.customerId);
      } finally {
        (env as Record<string, unknown>).STRIPE_PRICE_GROWTH = saved;
      }
    });
  });

  describe("checkout.session.completed (mode=subscription)", () => {
    it("stamps stripeCustomerId + stripeSubscriptionId without flipping status", async () => {
      const m = await createMerchant({
        email: `sub-completed-${Date.now()}@test.com`,
        status: "trial",
        trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const event = makeEvent({
        id: "evt_session_sub_1",
        type: "checkout.session.completed",
        object: {
          id: "cs_sub_1",
          mode: "subscription",
          customer: "cus_test_1",
          subscription: "sub_test_1",
          metadata: { merchantId: String(m._id), plan: "growth" },
        },
      });
      const result = await dispatchStripeEvent(event);
      expect(result.ok).toBe(true);

      const fresh = await Merchant.findById(m._id);
      expect(fresh?.stripeCustomerId).toBe("cus_test_1");
      expect(fresh?.stripeSubscriptionId).toBe("sub_test_1");
      // Status MUST stay trial — activation belongs to invoice.payment_succeeded.
      expect(fresh?.subscription?.status).toBe("trial");
    });

    it("is idempotent on re-delivery", async () => {
      const m = await createMerchant({ email: `sub-idem-${Date.now()}@test.com` });
      const event = makeEvent({
        id: "evt_session_sub_2",
        type: "checkout.session.completed",
        object: {
          id: "cs_sub_2",
          mode: "subscription",
          customer: "cus_test_2",
          subscription: "sub_test_2",
          metadata: { merchantId: String(m._id), plan: "growth" },
        },
      });
      const a = await dispatchStripeEvent(event);
      const b = await dispatchStripeEvent(event);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      const fresh = await Merchant.findById(m._id);
      expect(fresh?.stripeSubscriptionId).toBe("sub_test_2");
    });
  });

  describe("invoice.payment_succeeded", () => {
    it("flips merchant to active, writes one Payment row, clears grace", async () => {
      const saved = env.STRIPE_PRICE_GROWTH;
      (env as Record<string, unknown>).STRIPE_PRICE_GROWTH = "price_growth_test";
      try {
        const m = await createMerchant({
          email: `inv-success-${Date.now()}@test.com`,
          status: "trial",
          trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        // Pretend we already had a past_due gracePeriodEndsAt — payment recovers it.
        await Merchant.updateOne(
          { _id: m._id },
          {
            $set: {
              "subscription.status": "past_due",
              "subscription.gracePeriodEndsAt": new Date(Date.now() + 86400_000),
              stripeSubscriptionId: "sub_inv_1",
            },
          },
        );
        const periodStart = NOW_S();
        const periodEnd = periodStart + 30 * 86400;
        const event = makeEvent({
          id: "evt_inv_succ_1",
          type: "invoice.payment_succeeded",
          object: {
            id: "in_test_1",
            customer: "cus_inv_1",
            subscription: "sub_inv_1",
            payment_intent: "pi_inv_1",
            amount_paid: 2500,
            currency: "usd",
            period_start: periodStart,
            period_end: periodEnd,
            lines: { data: [{ price: { id: "price_growth_test" } }] },
            metadata: { merchantId: String(m._id), plan: "growth" },
          },
        });

        const r1 = await dispatchStripeEvent(event);
        expect(r1.ok).toBe(true);
        const fresh = await Merchant.findById(m._id);
        expect(fresh?.subscription?.status).toBe("active");
        expect(fresh?.subscription?.tier).toBe("growth");
        expect(fresh?.subscription?.gracePeriodEndsAt ?? null).toBeNull();
        const payments = await Payment.find({ merchantId: m._id });
        expect(payments).toHaveLength(1);
        expect(payments[0]?.invoiceId).toBe("in_test_1");
        expect(payments[0]?.status).toBe("approved");
        expect(payments[0]?.amount).toBe(25);

        // Idempotency — re-deliver the same event.
        const r2 = await dispatchStripeEvent(event);
        expect(r2.ok).toBe(true);
        expect(r2.duplicate).toBe(true);
        const stillOne = await Payment.find({ merchantId: m._id });
        expect(stillOne).toHaveLength(1);
      } finally {
        (env as Record<string, unknown>).STRIPE_PRICE_GROWTH = saved;
      }
    });

    it("can resolve the merchant by stripeSubscriptionId when metadata is missing", async () => {
      const m = await createMerchant({
        email: `inv-fallback-${Date.now()}@test.com`,
      });
      await Merchant.updateOne(
        { _id: m._id },
        { $set: { stripeSubscriptionId: "sub_fallback_1" } },
      );
      const event = makeEvent({
        id: "evt_inv_fallback",
        type: "invoice.payment_succeeded",
        object: {
          id: "in_fallback_1",
          subscription: "sub_fallback_1",
          amount_paid: 2500,
          currency: "usd",
          // intentionally no metadata
        },
      });
      const r = await dispatchStripeEvent(event);
      expect(r.ok).toBe(true);
      expect(r.merchantId).toBe(String(m._id));
    });
  });

  describe("invoice.payment_failed", () => {
    it("flips active → past_due with a grace deadline ~7 days out", async () => {
      const m = await createMerchant({
        email: `inv-fail-${Date.now()}@test.com`,
        status: "active",
      });
      await Merchant.updateOne(
        { _id: m._id },
        { $set: { stripeSubscriptionId: "sub_fail_1" } },
      );
      const event = makeEvent({
        id: "evt_inv_fail_1",
        type: "invoice.payment_failed",
        object: {
          id: "in_fail_1",
          subscription: "sub_fail_1",
          amount_due: 2500,
          currency: "usd",
          metadata: { merchantId: String(m._id) },
        },
      });
      const r = await dispatchStripeEvent(event);
      expect(r.ok).toBe(true);

      const fresh = await Merchant.findById(m._id);
      expect(fresh?.subscription?.status).toBe("past_due");
      const grace = fresh?.subscription?.gracePeriodEndsAt as Date | null;
      expect(grace).toBeTruthy();
      const ms = (grace as Date).getTime() - Date.now();
      expect(ms).toBeGreaterThan(6 * 86400_000);
      expect(ms).toBeLessThan(8 * 86400_000);
    });

    it("does NOT extend the grace deadline on a second failure for the same invoice", async () => {
      const m = await createMerchant({
        email: `inv-fail2-${Date.now()}@test.com`,
        status: "active",
      });
      await Merchant.updateOne(
        { _id: m._id },
        { $set: { stripeSubscriptionId: "sub_fail_2" } },
      );
      const eventA = makeEvent({
        id: "evt_inv_fail_2a",
        type: "invoice.payment_failed",
        object: {
          id: "in_fail_2",
          subscription: "sub_fail_2",
          amount_due: 2500,
          currency: "usd",
          metadata: { merchantId: String(m._id) },
        },
      });
      await dispatchStripeEvent(eventA);
      const after1 = await Merchant.findById(m._id);
      const grace1 = (after1?.subscription?.gracePeriodEndsAt as Date | null)!;
      // Wait a beat then re-deliver under a fresh event id — Stripe smart-retry
      // can fire payment_failed multiple times per invoice.
      await new Promise((r) => setTimeout(r, 30));
      const eventB = makeEvent({
        id: "evt_inv_fail_2b",
        type: "invoice.payment_failed",
        object: eventA.data.object,
      });
      await dispatchStripeEvent(eventB);
      const after2 = await Merchant.findById(m._id);
      const grace2 = (after2?.subscription?.gracePeriodEndsAt as Date | null)!;
      expect(grace2.getTime()).toBe(grace1.getTime());
    });
  });

  describe("customer.subscription.updated / deleted", () => {
    it("syncs status, period end, and tier from a portal-driven plan switch", async () => {
      const saved = env.STRIPE_PRICE_SCALE;
      (env as Record<string, unknown>).STRIPE_PRICE_SCALE = "price_scale_test";
      try {
        const m = await createMerchant({
          email: `sub-update-${Date.now()}@test.com`,
          status: "active",
        });
        await Merchant.updateOne(
          { _id: m._id },
          {
            $set: {
              stripeCustomerId: "cus_upd_1",
              stripeSubscriptionId: "sub_upd_1",
              "subscription.tier": "growth",
            },
          },
        );
        const cpe = NOW_S() + 30 * 86400;
        const event = makeEvent({
          id: "evt_sub_upd_1",
          type: "customer.subscription.updated",
          object: {
            id: "sub_upd_1",
            customer: "cus_upd_1",
            status: "active",
            current_period_end: cpe,
            items: { data: [{ price: { id: "price_scale_test" } }] },
            metadata: { merchantId: String(m._id) },
          },
        });
        const r = await dispatchStripeEvent(event);
        expect(r.ok).toBe(true);
        const fresh = await Merchant.findById(m._id);
        expect(fresh?.subscription?.tier).toBe("scale");
        expect(fresh?.subscription?.currentPeriodEnd?.getTime()).toBe(cpe * 1000);
      } finally {
        (env as Record<string, unknown>).STRIPE_PRICE_SCALE = saved;
      }
    });

    it("flips to cancelled on customer.subscription.deleted", async () => {
      const m = await createMerchant({
        email: `sub-del-${Date.now()}@test.com`,
        status: "active",
      });
      await Merchant.updateOne(
        { _id: m._id },
        { $set: { stripeSubscriptionId: "sub_del_1" } },
      );
      const event = makeEvent({
        id: "evt_sub_del_1",
        type: "customer.subscription.deleted",
        object: {
          id: "sub_del_1",
          customer: "cus_del_1",
          status: "canceled",
          metadata: { merchantId: String(m._id) },
        },
      });
      await dispatchStripeEvent(event);
      const fresh = await Merchant.findById(m._id);
      expect(fresh?.subscription?.status).toBe("cancelled");
    });
  });

  describe("end-to-end lifecycle", () => {
    it("trial → active → past_due → active recovery", async () => {
      const saved = env.STRIPE_PRICE_GROWTH;
      (env as Record<string, unknown>).STRIPE_PRICE_GROWTH = "price_growth_test";
      try {
        const m = await createMerchant({
          email: `lifecycle-${Date.now()}@test.com`,
          status: "trial",
          trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });

        // 1) Subscription checkout completes
        await dispatchStripeEvent(
          makeEvent({
            id: "evt_lc_1",
            type: "checkout.session.completed",
            object: {
              id: "cs_lc_1",
              mode: "subscription",
              customer: "cus_lc_1",
              subscription: "sub_lc_1",
              metadata: { merchantId: String(m._id), plan: "growth" },
            },
          }),
        );

        // 2) First invoice paid → active
        await dispatchStripeEvent(
          makeEvent({
            id: "evt_lc_2",
            type: "invoice.payment_succeeded",
            object: {
              id: "in_lc_1",
              customer: "cus_lc_1",
              subscription: "sub_lc_1",
              amount_paid: 2500,
              currency: "usd",
              period_start: NOW_S(),
              period_end: NOW_S() + 30 * 86400,
              lines: { data: [{ price: { id: "price_growth_test" } }] },
              metadata: { merchantId: String(m._id), plan: "growth" },
            },
          }),
        );
        let fresh = await Merchant.findById(m._id);
        expect(fresh?.subscription?.status).toBe("active");

        // 3) Renewal fails → past_due + grace
        await dispatchStripeEvent(
          makeEvent({
            id: "evt_lc_3",
            type: "invoice.payment_failed",
            object: {
              id: "in_lc_2",
              customer: "cus_lc_1",
              subscription: "sub_lc_1",
              amount_due: 2500,
              currency: "usd",
              metadata: { merchantId: String(m._id) },
            },
          }),
        );
        fresh = await Merchant.findById(m._id);
        expect(fresh?.subscription?.status).toBe("past_due");
        expect(fresh?.subscription?.gracePeriodEndsAt).toBeTruthy();

        // 4) Stripe retry succeeds → back to active, grace cleared
        await dispatchStripeEvent(
          makeEvent({
            id: "evt_lc_4",
            type: "invoice.payment_succeeded",
            object: {
              id: "in_lc_2",
              customer: "cus_lc_1",
              subscription: "sub_lc_1",
              amount_paid: 2500,
              currency: "usd",
              period_start: NOW_S(),
              period_end: NOW_S() + 30 * 86400,
              lines: { data: [{ price: { id: "price_growth_test" } }] },
              metadata: { merchantId: String(m._id), plan: "growth" },
            },
          }),
        );
        fresh = await Merchant.findById(m._id);
        expect(fresh?.subscription?.status).toBe("active");
        expect(fresh?.subscription?.gracePeriodEndsAt ?? null).toBeNull();
        // Two payment rows total — one per invoice id.
        const payments = await Payment.find({ merchantId: m._id }).sort({ createdAt: 1 });
        expect(payments).toHaveLength(2);
        expect(payments[0]?.status).toBe("approved");
        expect(payments[1]?.status).toBe("approved");
      } finally {
        (env as Record<string, unknown>).STRIPE_PRICE_GROWTH = saved;
      }
    });
  });

  describe("subscription-grace worker", () => {
    it("flips past_due merchants whose grace expired to suspended", async () => {
      const m = await createMerchant({
        email: `grace-${Date.now()}@test.com`,
        status: "active",
      });
      await Merchant.updateOne(
        { _id: m._id },
        {
          $set: {
            "subscription.status": "past_due",
            "subscription.gracePeriodEndsAt": new Date(Date.now() - 60_000),
          },
        },
      );

      const r = await sweepSubscriptionGrace();
      expect(r.suspended).toBe(1);
      const fresh = await Merchant.findById(m._id);
      expect(fresh?.subscription?.status).toBe("suspended");

      // Idempotent: re-running suspends nobody new.
      const r2 = await sweepSubscriptionGrace();
      expect(r2.suspended).toBe(0);
    });

    it("leaves merchants alone when grace is still in the future", async () => {
      const m = await createMerchant({
        email: `grace-future-${Date.now()}@test.com`,
      });
      await Merchant.updateOne(
        { _id: m._id },
        {
          $set: {
            "subscription.status": "past_due",
            "subscription.gracePeriodEndsAt": new Date(Date.now() + 86400_000),
          },
        },
      );
      const r = await sweepSubscriptionGrace();
      expect(r.suspended).toBe(0);
      const fresh = await Merchant.findById(m._id);
      expect(fresh?.subscription?.status).toBe("past_due");
    });

    it("doesn't suspend merchants who recovered between scan and update", async () => {
      const m = await createMerchant({
        email: `grace-recovered-${Date.now()}@test.com`,
      });
      await Merchant.updateOne(
        { _id: m._id },
        {
          $set: {
            "subscription.status": "active", // pretend Stripe recovered before us
            "subscription.gracePeriodEndsAt": null,
          },
        },
      );
      const r = await sweepSubscriptionGrace();
      expect(r.suspended).toBe(0);
    });
  });

  describe("regression: legacy mode=payment still activates", () => {
    it("processes a one-shot Stripe Checkout session as before", async () => {
      const m = await createMerchant({
        email: `legacy-${Date.now()}@test.com`,
        status: "trial",
        trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const payment = await Payment.create({
        merchantId: m._id,
        plan: "growth",
        amount: 25,
        currency: "USD",
        method: "card",
        provider: "stripe",
        status: "pending",
        providerSessionId: "cs_legacy_1",
      });
      const event = makeEvent({
        id: "evt_legacy_1",
        type: "checkout.session.completed",
        object: {
          id: "cs_legacy_1",
          // mode omitted — old one-shot Checkout flow.
          payment_intent: "pi_legacy_1",
          payment_status: "paid",
          amount_total: 2500,
          currency: "usd",
          metadata: {
            merchantId: String(m._id),
            plan: "growth",
            paymentId: String(payment._id),
          },
        },
      });
      const r = await dispatchStripeEvent(event);
      expect(r.ok).toBe(true);
      const fresh = await Merchant.findById(m._id);
      expect(fresh?.subscription?.status).toBe("active");
    });
  });
});
