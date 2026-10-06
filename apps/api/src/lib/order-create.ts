import type { Types } from "mongoose";
import { Merchant, type MerchantFraudConfig } from "@ecom/db";
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

/**
 * Order creation building blocks shared by every path that creates an
 * order for a merchant in-process (dashboard `orders.createOrder`, landing
 * page checkout): numbering and fraud scoring. What happens after the
 * order is committed is the canonical post-create pipeline,
 * lib/order-lifecycle.ts (`processOrderAfterCreate`), shared by every source.
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
