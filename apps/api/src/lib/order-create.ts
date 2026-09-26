import type { Types } from "mongoose";
import { FraudPrediction, Merchant, type MerchantFraudConfig, Order } from "@ecom/db";
import { enqueueAutoBook } from "../workers/automationBook.js";
import { enqueueOrderConfirmationSms } from "../workers/automationSms.js";
import { type AutomationState, decideAutomationAction } from "./automation.js";
import { type NetworkRiskAggregate, hashPhoneForNetwork, lookupNetworkRisk } from "./fraud-network.js";
import {
  DEFAULT_WEIGHTS_VERSION,
  type RiskOptions,
  type RiskResult,
  collectRiskHistory,
  computeRisk,
  hashAddress,
} from "../server/risk.js";
import { getMerchantValueRollup } from "./merchantValueRollup.js";
import { writeAudit } from "./audit.js";
import { fireFraudAlert } from "./alerts.js";
import { resolveIdentityForOrder } from "../server/ingest.js";

/**
 * Order creation building blocks shared by every path that creates an
 * order for a merchant in-process (dashboard `orders.createOrder`, landing
 * page checkout): numbering, fraud scoring, and the post-commit pipeline
 * (fraud prediction ledger, automation decision + confirmation SMS,
 * auto-book, risk audit, fraud alert, identity stitching).
 */

export function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 0xfff).toString(16).toUpperCase().padStart(3, "0");
  return `ORD-${ts}-${rand}`;
}

export interface MerchantScoringSnapshot {
  disableNetworkSignals?: boolean;
  tier?: string;
  opts: RiskOptions;
  halfLifeDays: number;
  velocityWindowMin: number;
}

export async function loadMerchantScoring(
  merchantId: Types.ObjectId,
): Promise<MerchantScoringSnapshot> {
  const m = (await Merchant.findById(merchantId)
    .select("subscription.tier fraudConfig")
    .lean()) as
    | { subscription?: { tier?: string }; fraudConfig?: MerchantFraudConfig | null }
    | null;
  const fc: MerchantFraudConfig = m?.fraudConfig ?? {};
  // Adaptive thresholds — derive from the merchant's order history so
  // per-merchant value distributions inform "high COD" without ops needing
  // to hand-tune each account. Caller (`computeRisk`) ignores these when
  // an explicit `highCodThreshold` / `extremeCodThreshold` is set, so a
  // merchant that pinned values still gets exactly what they pinned.
  const rollup = await getMerchantValueRollup(merchantId).catch(() => ({
    avgOrderValue: undefined,
    p75OrderValue: undefined,
    resolvedSampleSize: 0,
  }));
  return {
    tier: m?.subscription?.tier,
    opts: {
      highCodBdt: fc.highCodThreshold ?? undefined,
      extremeCodBdt: fc.extremeCodThreshold ?? undefined,
      suspiciousDistricts: fc.suspiciousDistricts ?? [],
      blockedPhones: fc.blockedPhones ?? [],
      blockedAddresses: fc.blockedAddresses ?? [],
      // Pass-through nullish so computeRisk applies its own default (3).
      // Negative explicit value disables velocity per-merchant.
      velocityThreshold: fc.velocityThreshold ?? undefined,
      p75OrderValue: rollup.p75OrderValue,
      avgOrderValue: rollup.avgOrderValue,
      weightOverrides: fc.signalWeightOverrides as
        | Map<string, number>
        | Record<string, number>
        | undefined,
      baseRtoRate: fc.baseRtoRate,
      weightsVersion: fc.weightsVersion ?? DEFAULT_WEIGHTS_VERSION,
    },
    halfLifeDays: fc.historyHalfLifeDays ?? 30,
    velocityWindowMin: fc.velocityWindowMin ?? 10,
    disableNetworkSignals:
      (fc as { disableNetworkSignals?: boolean }).disableNetworkSignals === true,
  };
}

export async function scoreOrderForCreate(args: {
  merchantId: Types.ObjectId;
  cod: number;
  customer: { name: string; phone: string; address: string; district: string };
  ip?: string;
  addressHash?: string | null;
  scoring?: MerchantScoringSnapshot;
}): Promise<
  RiskResult & {
    scoredAt: Date;
    detected: boolean;
    addressHash: string | null;
    network: NetworkRiskAggregate | null;
  }
> {
  const scoring = args.scoring ?? (await loadMerchantScoring(args.merchantId));
  const addressHash =
    args.addressHash ?? hashAddress(args.customer.address, args.customer.district);
  const history = await collectRiskHistory({
    merchantId: args.merchantId,
    phone: args.customer.phone,
    ip: args.ip,
    addressHash: addressHash ?? undefined,
    halfLifeDays: scoring.halfLifeDays,
    velocityWindowMin: scoring.velocityWindowMin,
  });
  const result = computeRisk(
    {
      cod: args.cod,
      customer: args.customer,
      ip: args.ip,
      addressHash,
    },
    history,
    scoring.opts,
  );

  // Cross-merchant network signal — capped at +25, suppressed for merchants
  // that opted out via fraudConfig.disableNetworkSignals.
  let network: NetworkRiskAggregate | null = null;
  if (!scoring.disableNetworkSignals) {
    const phoneHash = hashPhoneForNetwork(args.customer.phone);
    network = await lookupNetworkRisk({
      phoneHash,
      addressHash,
      merchantId: args.merchantId,
    });
    if (network.bonus > 0) {
      result.signals.push({
        key: "fraud_network",
        weight: network.bonus,
        detail: `Seen at ${network.merchantCount} other merchants` +
          (network.rtoRate !== null
            ? ` — RTO ${Math.round(network.rtoRate * 100)}%`
            : ""),
      });
      result.reasons.push(
        `Cross-merchant network: ${network.rtoCount} RTOs across ${network.merchantCount} merchants`,
      );
      result.riskScore = Math.min(100, result.riskScore + network.bonus);
      result.level =
        result.riskScore <= 39 ? "low" : result.riskScore <= 69 ? "medium" : "high";
    }
  }

  return {
    ...result,
    scoredAt: new Date(),
    detected: result.level === "high",
    addressHash,
    network: network ?? null,
  };
}

export function fraudDocFromRisk(risk: Awaited<ReturnType<typeof scoreOrderForCreate>>) {
  return {
    detected: risk.detected,
    riskScore: risk.riskScore,
    level: risk.level,
    reasons: risk.reasons,
    signals: risk.signals,
    reviewStatus: risk.reviewStatus,
    scoredAt: risk.scoredAt,
    confidence: risk.confidence,
    confidenceLabel: risk.confidenceLabel,
    hardBlocked: risk.hardBlocked,
  };
}

export type ScoredRisk = Awaited<ReturnType<typeof scoreOrderForCreate>>;

/**
 * Best-effort post-create work. Runs OUTSIDE the order transaction and
 * never throws: the order is already committed.
 */
export async function afterOrderCreated(args: {
  merchantId: Types.ObjectId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  order: any;
  risk: ScoredRisk;
  /** User on whose behalf automation (auto-book) acts. */
  userId: string;
}): Promise<void> {
  const { merchantId, order, risk } = args;
  // Best-effort post-create work runs OUTSIDE the transaction — these are
  // observability / automation hooks that must not roll back the order if
  // they fail. Wrapped in a try/catch so a stray throw cannot prevent the
  // mutation from returning the created order to the caller.
  try {
    // Feedback-loop ledger — captured at scoring time, outcome stamped
    // later by the tracking pipeline. Best-effort; never undoes the order.
    void FraudPrediction.create({
      merchantId,
      orderId: order._id,
      riskScore: risk.riskScore,
      pRto: risk.pRto,
      levelPredicted: risk.level,
      customerTier: risk.customerTier,
      signals: risk.signals.map((s) => ({ key: s.key, weight: s.weight })),
      weightsVersion: risk.weightsVersion,
    }).catch((err) =>
      console.error(
        "[fraud-prediction] write failed",
        (err as Error).message,
      ),
    );
    // --- Automation engine ---------------------------------------------
    // Decide what (if anything) the engine should do for this fresh order.
    // Persistence is best-effort; a failure must not roll back the order
    // creation. Booking is fire-and-forget — never blocks the response.
    let automationState: AutomationState = "not_evaluated";
    let automationReason = "";
    try {
      const merchant = await Merchant.findById(merchantId)
        .select("automationConfig couriers")
        .lean();
      const automationCfg = (merchant as { automationConfig?: Record<string, unknown> } | null)?.automationConfig ?? {};
      const decision = decideAutomationAction(risk.level, risk.riskScore, automationCfg as never);
      automationState = decision.state;
      automationReason = decision.reason;

      if (decision.action !== "no_op") {
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
          // Mint a 6-digit code so an inbound "YES 123456" reply maps to
          // a single order even when the same customer has multiple
          // pending orders.
          confirmationCode = String(Math.floor(10000000 + Math.random() * 90000000));
          set["automation.confirmationCode"] = confirmationCode;
          set["automation.confirmationChannel"] = "sms";
          // confirmationSentAt is stamped by the SMS worker on success,
          // so the stale-pending sweeper sees a missing timestamp until
          // the gateway actually accepts the message.
        }
        await Order.updateOne({ _id: order._id }, { $set: set });

        // Pending-confirmation outbound SMS — queued, with retries +
        // exponential backoff. Survives transient gateway outages.
        if (decision.state === "pending_confirmation" && confirmationCode) {
          void enqueueOrderConfirmationSms({
            orderId: String(order._id),
            merchantId: String(merchantId),
            phone: order.customer.phone,
            orderNumber: order.orderNumber,
            codAmount: order.order.cod,
            confirmationCode,
          }).catch((err) =>
            console.error("[automation] enqueue confirm SMS failed:", (err as Error).message),
          );
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

        // Auto-book hook: never inline-await, never throw. If booking fails,
        // the order stays in `confirmed` and the merchant can retry from UI.
        if (decision.shouldAutoBook) {
          const courierName =
            (automationCfg as { autoBookCourier?: string }).autoBookCourier ??
            ((merchant as { couriers?: Array<{ name: string; enabled?: boolean }> } | null)?.couriers ?? [])
              .find((c) => c.enabled !== false)?.name;
          if (courierName) {
            // Auto-book runs in the BullMQ queue (apps/api/src/workers/automationBook.ts)
            // with attempts: 3, exponential backoff, and a critical-tier
            // merchant notification when retries are exhausted. Never blocks
            // the response; never throws.
            void enqueueAutoBook({
              orderId: String(order._id),
              merchantId: String(merchantId),
              userId: args.userId,
              courier: courierName,
            }).catch((err) =>
              console.error("[automation] enqueueAutoBook failed:", (err as Error).message),
            );
          }
        }
      }
    } catch (err) {
      console.error("[automation] evaluation failed", (err as Error).message);
    }

    void writeAudit({
      merchantId,
      actorId: merchantId,
      action: "risk.scored",
      subjectType: "order",
      subjectId: order._id,
      meta: { level: risk.level, score: risk.riskScore, reasons: risk.reasons },
    });
    if (risk.level === "high") {
      // Awaited so the merchant's inbox is guaranteed-written before the
      // mutation response returns — we never silently drop a fraud alert.
      await fireFraudAlert({
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
    void resolveIdentityForOrder({
      merchantId,
      orderId: order._id,
      phone: order.customer.phone,
    }).catch((err) => console.error("[orders.create] identity stitch failed", err));
  } catch (err) {
    // Order is already committed — best-effort post-create work failing
    // must NOT roll back the order or throw to the caller. Log and move
    // on; the merchant has a valid order in their list either way.
    console.error("[orders.create] post-commit hook failed", (err as Error).message);
  }
}
