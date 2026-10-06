import type { Types } from "mongoose";
import { FraudPrediction, Merchant, Order, type OrderLifecycle } from "@ecom/db";
import { enqueueAutoBook, MAX_AUTO_BOOK_AGE_MS } from "../workers/automationBook.js";
import { enqueueOrderConfirmationSms } from "../workers/automationSms.js";
import { decideAutomationAction, type AutomationAction } from "./automation.js";
import { entitledAutomationConfig } from "./entitlements.js";
import { writeAudit } from "./audit.js";
import { fireFraudAlert } from "./alerts.js";
import { notifyNewOrder } from "./merchant-notices.js";
import { scoreIntentForOrder } from "./intent.js";
import { env } from "../env.js";
import type { RiskResult } from "../server/risk.js";

/**
 * The canonical post-create pipeline: what happens to EVERY order once it
 * has been created and committed, whatever created it —
 *
 *   landing checkout · dashboard order · Shopify / WooCommerce / custom-API
 *   store order (webhook, order sync, replay) · store history import
 *
 * Order creation itself (validation, idempotency, quota, the insert, the
 * stock reservation) stays with each source; they all call this right
 * after a NEW order is committed, never for a duplicate and never when
 * quota or validation stopped the create. This module only orchestrates
 * the existing domain services, in this order:
 *
 *   1. claim         — atomic, merchant-scoped stamp of `order.lifecycle`;
 *                      a second call for the same order does nothing
 *   2. prediction    — fraud-prediction ledger row (unique per order)
 *   3. automation    — LIVE only: the merchant's automation decision under
 *                      their plan's entitlement (auto-confirm, confirmation
 *                      SMS, auto-book), exactly as before
 *   4. risk audit    — LIVE only
 *   5. review alert  — high risk (deduped per order)
 *   6. new-order     — LIVE customer orders not already announced by (5)
 *   7. identity      — stitch prior sessions; for customer-placed orders
 *                      then intent scoring (flagged) — a dashboard order
 *                      has no buyer session to score
 *
 * `historical_import` orders (a store-history import, or a store order that
 * reaches us long after it was placed) are recorded, scored and alerted on,
 * but never trigger live automation: no auto-confirm, no confirmation SMS,
 * no auto-book, no "new order" notice. CSV uploads do not use this pipeline
 * (they never did; see orders.bulkUpload).
 *
 * Every step is best-effort and isolated: the order is already committed,
 * so nothing here throws or rolls it back.
 */

/** Where the order came from — `Order.source.channel` / `sourceProvider` vocabulary. */
export type OrderSourceKind = "dashboard" | "landing_page" | "shopify" | "woocommerce" | "custom_api";

/**
 * A store order is a live sale only while it is fresh: one placed longer
 * ago than automatic booking may act on (24h) is a backfill — the first
 * order-sync poll, a late delivery, a replay of a held order.
 */
export const MAX_LIVE_ORDER_AGE_MS = MAX_AUTO_BOOK_AGE_MS;

export function storeOrderLifecycle(placedAt: Date | string | null | undefined, now: number = Date.now()): OrderLifecycle {
  if (!placedAt) return "live"; // just arrived, no upstream timestamp to say otherwise
  const t = new Date(placedAt).getTime();
  return Number.isFinite(t) && now - t > MAX_LIVE_ORDER_AGE_MS ? "historical_import" : "live";
}

export interface PostCreateContext {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
  lifecycle: OrderLifecycle;
  source: OrderSourceKind;
  /** The merchant's customer placed it (checkout, store) — a live one is announced as new. */
  customerPlaced: boolean;
  /** The risk computed when the order was created. */
  risk: Pick<RiskResult, "level" | "riskScore" | "reasons" | "signals" | "pRto" | "customerTier" | "weightsVersion">;
  /** User on whose behalf automation (auto-book) acts. */
  userId: string;
  /** Buyer email when the source knows it (identity stitching). */
  customerEmail?: string | null;
}

export interface PostCreateOutcome {
  /** False when the order was already processed, or is not this merchant's. */
  ran: boolean;
  lifecycle?: OrderLifecycle;
  automation?: AutomationAction | "skipped_historical" | "failed";
  reviewAlerted?: boolean;
}

export async function processOrderAfterCreate(ctx: PostCreateContext): Promise<PostCreateOutcome> {
  const { merchantId, risk } = ctx;
  // 1. Claim — the run-once guard and the tenant guard in one write.
  let order: {
    _id: Types.ObjectId;
    orderNumber: string;
    customer: { phone: string; district?: string | null };
    order: { cod: number; total?: number | null; currency?: string | null };
  } | null;
  try {
    order = await Order.findOneAndUpdate(
      { _id: ctx.orderId, merchantId, lifecycle: { $exists: false } },
      { $set: { lifecycle: { kind: ctx.lifecycle, source: ctx.source, processedAt: new Date() } } },
      { new: true, projection: { orderNumber: 1, customer: 1, "order.cod": 1, "order.total": 1, "order.currency": 1 } },
    ).lean();
  } catch (err) {
    console.error(JSON.stringify({ evt: "order.post_create_claim_failed", orderId: String(ctx.orderId), error: (err as Error).message?.slice(0, 200) }));
    return { ran: false };
  }
  if (!order) return { ran: false };

  const outcome: PostCreateOutcome = { ran: true, lifecycle: ctx.lifecycle };
  try {
    // 2. Feedback-loop ledger — captured at scoring time, outcome stamped later.
    void FraudPrediction.create({
      merchantId,
      orderId: order._id,
      riskScore: risk.riskScore,
      pRto: risk.pRto,
      levelPredicted: risk.level,
      customerTier: risk.customerTier,
      signals: risk.signals.map((s) => ({ key: s.key, weight: s.weight })),
      weightsVersion: risk.weightsVersion,
    }).catch((err) => console.error("[fraud-prediction] write failed", (err as Error).message));

    // 3. Automation — live orders only.
    outcome.automation = ctx.lifecycle === "live" ? await runAutomation(ctx, order) : "skipped_historical";

    // 4. Risk audit (live; imports keep their own ingest audit).
    if (ctx.lifecycle === "live") {
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "risk.scored",
        subjectType: "order",
        subjectId: order._id,
        meta: { level: risk.level, score: risk.riskScore, reasons: risk.reasons },
      });
    }

    // 5. Review alert — awaited so the inbox row exists before the caller returns.
    let reviewAlerted = false;
    if (risk.level === "high") {
      reviewAlerted = await fireFraudAlert({
        merchantId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        phone: order.customer.phone,
        riskScore: risk.riskScore,
        level: risk.level,
        reasons: risk.reasons,
        kind: "fraud.pending_review",
      });
    }
    outcome.reviewAlerted = reviewAlerted;

    // 6. A live customer order is news to the merchant (one they typed in, or an import, is not).
    if (ctx.lifecycle === "live" && ctx.customerPlaced && !reviewAlerted) {
      await notifyNewOrder({
        merchantId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        total: order.order?.total ?? undefined,
        currency: order.order?.currency ?? undefined,
        district: order.customer?.district ?? undefined,
        source: ctx.source,
      });
    }

    // 7. Identity stitching, then intent scoring — fire-and-forget, each isolated.
    void (async () => {
      try {
        const { resolveIdentityForOrder } = await import("../server/ingest.js");
        await resolveIdentityForOrder({ merchantId, orderId: order._id, phone: order.customer.phone, email: ctx.customerEmail ?? undefined });
      } catch (err) {
        console.error("[order-lifecycle] identity resolution failed", (err as Error).message);
      }
      if (env.INTENT_SCORING_ENABLED && ctx.customerPlaced) {
        try {
          await scoreIntentForOrder({ merchantId, orderId: order._id });
        } catch (err) {
          console.error("[order-lifecycle] intent scoring failed", (err as Error).message);
        }
      }
    })();
  } catch (err) {
    // The order is committed — a failing step must never undo it or reach the caller.
    console.error(JSON.stringify({ evt: "order.post_create_failed", orderId: String(order._id), error: (err as Error).message?.slice(0, 200) }));
  }
  console.log(
    JSON.stringify({
      evt: "order.post_create",
      merchantId: String(merchantId),
      orderId: String(order._id),
      source: ctx.source,
      lifecycle: ctx.lifecycle,
      automation: outcome.automation ?? null,
      reviewAlerted: outcome.reviewAlerted ?? false,
    }),
  );
  return outcome;
}

/**
 * The merchant's automation decision for a fresh live order (unchanged
 * engine + plan entitlement): auto-confirm, confirmation SMS for the buyer,
 * auto-book. Persisted best-effort; booking and SMS are queued, never inline.
 */
async function runAutomation(
  ctx: PostCreateContext,
  order: { _id: Types.ObjectId; orderNumber: string; customer: { phone: string }; order: { cod: number } },
): Promise<AutomationAction | "failed"> {
  const { merchantId, risk } = ctx;
  try {
    const merchant = await Merchant.findById(merchantId).select("automationConfig couriers subscription.tier").lean();
    // Full-auto / auto-book run only on a plan that includes them.
    const automationCfg = entitledAutomationConfig(
      merchant?.subscription?.tier,
      (merchant as { automationConfig?: Record<string, unknown> } | null)?.automationConfig ?? {},
    );
    const decision = decideAutomationAction(risk.level, risk.riskScore, automationCfg as never);
    if (decision.action === "no_op") return decision.action;

    const set: Record<string, unknown> = {
      "automation.state": decision.state,
      "automation.decidedBy": "system",
      "automation.decidedAt": new Date(),
      "automation.reason": decision.reason.slice(0, 200),
    };
    let confirmationCode: string | undefined;
    if (decision.state === "auto_confirmed") {
      set["automation.confirmedAt"] = new Date();
      set["order.status"] = "confirmed";
    } else if (decision.state === "pending_confirmation") {
      // A code so an inbound "YES 123456" reply maps to exactly this order.
      confirmationCode = String(Math.floor(10000000 + Math.random() * 90000000));
      set["automation.confirmationCode"] = confirmationCode;
      set["automation.confirmationChannel"] = "sms";
      // confirmationSentAt is stamped by the SMS worker once the gateway accepts it.
    }
    await Order.updateOne({ _id: order._id, merchantId }, { $set: set });

    // Pending-confirmation SMS — queued with retries; one job per order.
    if (decision.state === "pending_confirmation" && confirmationCode) {
      void enqueueOrderConfirmationSms({
        orderId: String(order._id),
        merchantId: String(merchantId),
        phone: order.customer.phone,
        orderNumber: order.orderNumber,
        codAmount: order.order.cod,
        confirmationCode,
      }).catch((err) => console.error("[automation] enqueue confirm SMS failed:", (err as Error).message));
    }
    void writeAudit({
      merchantId,
      actorId: merchantId,
      actorType: "system",
      action: `automation.${decision.action}`,
      subjectType: "order",
      subjectId: order._id,
      meta: { state: decision.state, reason: decision.reason, riskScore: risk.riskScore },
    });

    // Auto-book: queued (retries, courier fallback, booking-failed alert in the worker).
    if (decision.shouldAutoBook) {
      const courierName =
        (automationCfg as { autoBookCourier?: string }).autoBookCourier ??
        ((merchant as { couriers?: Array<{ name: string; enabled?: boolean }> } | null)?.couriers ?? []).find((c) => c.enabled !== false)?.name;
      if (courierName) {
        void enqueueAutoBook({
          orderId: String(order._id),
          merchantId: String(merchantId),
          userId: ctx.userId,
          courier: courierName,
        }).catch((err) => console.error("[automation] enqueueAutoBook failed:", (err as Error).message));
      }
    }
    return decision.action;
  } catch (err) {
    console.error("[automation] evaluation failed", (err as Error).message);
    return "failed";
  }
}
