import { createHash } from "node:crypto";
import { env } from "../env.js";
import { Payment } from "@ecom/db";
import type { Types } from "mongoose";

/**
 * Manual-payment helpers for Bangladesh rails (bKash / Nagad / bank).
 *
 * Responsibilities:
 *  1. Surface merchant-facing instructions read from env (pure data).
 *  2. Spam guard: per-merchant daily cap + same-merchant dedupe by
 *     (merchantId, method, txnId).
 *  3. Cross-merchant anti-fraud: flag txnIds, proof files, and metadata
 *     fingerprints that have already been claimed by another merchant.
 *  4. Risk scoring on submit so the admin queue can prioritize.
 */

export type ManualPaymentMethod = "bkash" | "nagad" | "bank_transfer";

export interface ManualPaymentOption {
  method: ManualPaymentMethod;
  label: string;
  enabled: boolean;
  destination?: string;
  hint?: string;
  instructions: string[];
}

const BKASH_STEPS = [
  "Open the bKash app and tap Send Money (or Make Payment).",
  "Enter the bKash number above as the recipient.",
  "Enter the exact plan amount in BDT and confirm.",
  "Copy the Transaction ID from the receipt SMS.",
  "Paste the Transaction ID below and (optionally) attach a screenshot.",
];

const NAGAD_STEPS = [
  "Open the Nagad app and tap Send Money.",
  "Enter the Nagad number above as the recipient.",
  "Enter the exact plan amount in BDT and confirm with your PIN.",
  "Copy the Transaction ID from the confirmation SMS.",
  "Paste the Transaction ID below and (optionally) attach a screenshot.",
];

const BANK_STEPS = [
  "Initiate a bank transfer to the account details above.",
  "Use your business name as the reference / beneficiary note.",
  "Once the transfer settles, paste the bank reference number below.",
  "Attach a screenshot or PDF of the transfer confirmation.",
];

export function listManualPaymentOptions(): ManualPaymentOption[] {
  return [
    {
      method: "bkash",
      label: "bKash",
      enabled: !!env.PAY_BKASH_NUMBER,
      destination: env.PAY_BKASH_NUMBER,
      hint: env.PAY_BKASH_TYPE,
      instructions: BKASH_STEPS,
    },
    {
      method: "nagad",
      label: "Nagad",
      enabled: !!env.PAY_NAGAD_NUMBER,
      destination: env.PAY_NAGAD_NUMBER,
      hint: env.PAY_NAGAD_TYPE,
      instructions: NAGAD_STEPS,
    },
    {
      method: "bank_transfer",
      label: "Bank Transfer",
      enabled: !!env.PAY_BANK_INFO,
      destination: env.PAY_BANK_INFO,
      hint: undefined,
      instructions: BANK_STEPS,
    },
  ];
}

export interface SubmitGuardInput {
  merchantId: Types.ObjectId;
  method: ManualPaymentMethod | "card" | "other";
  txnId?: string;
}

export type SubmitGuardResult =
  | { ok: true }
  | {
      ok: false;
      reason: "daily_cap" | "duplicate_txn" | "duplicate_txn_cross_merchant";
      detail: string;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeTxnId(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * Submit-time guard. Refuses replays at the same merchant AND the same
 * normalized txnId across DIFFERENT merchants — the latter is the most
 * common manual-payment fraud (a bad actor copies someone else's bKash
 * receipt and claims it as their own).
 */
export async function checkManualPaymentSubmitGuard(
  input: SubmitGuardInput,
): Promise<SubmitGuardResult> {
  const since = new Date(Date.now() - DAY_MS);
  const cap = env.PAY_MANUAL_DAILY_CAP;

  const recentCount = await Payment.countDocuments({
    merchantId: input.merchantId,
    provider: "manual",
    createdAt: { $gte: since },
  });
  if (recentCount >= cap) {
    return {
      ok: false,
      reason: "daily_cap",
      detail: `You have submitted ${recentCount} payments in the last 24 hours. Please wait or contact support if a previous submission is stuck.`,
    };
  }

  if (input.txnId && input.txnId.trim().length > 0) {
    const norm = normalizeTxnId(input.txnId);
    const sameMerchantDup = await Payment.findOne({
      merchantId: input.merchantId,
      method: input.method,
      txnId: input.txnId.trim(),
      status: { $in: ["pending", "reviewed", "approved"] },
    })
      .select("_id status")
      .lean();
    if (sameMerchantDup) {
      return {
        ok: false,
        reason: "duplicate_txn",
        detail: `That transaction id was already submitted (status: ${sameMerchantDup.status}).`,
      };
    }
    // Cross-merchant collision — same normalized txnId on the same rail
    // but submitted by a different merchant. We refuse outright; even if
    // the merchant claims a legitimate explanation, support can resolve
    // it manually.
    const crossDup = await Payment.findOne({
      merchantId: { $ne: input.merchantId },
      method: input.method,
      txnIdNorm: norm,
      status: { $in: ["pending", "reviewed", "approved"] },
    })
      .select("_id merchantId status")
      .lean();
    if (crossDup) {
      return {
        ok: false,
        reason: "duplicate_txn_cross_merchant",
        detail:
          "That transaction id was already submitted by a different merchant. " +
          "If you believe this is a mistake, contact support with the receipt SMS.",
      };
    }
  }

  return { ok: true };
}

/**
 * Compute the proof-file fingerprint. Returns null when no proof attached
 * or the data is empty. Same proof bytes always hash to the same value
 * regardless of filename.
 */
export function computeProofHash(
  proofFile: { data?: string | null } | null | undefined,
): string | null {
  const data = proofFile?.data;
  if (!data) return null;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Metadata fingerprint = SHA-256 of (method + txnIdNorm + senderPhone
 * + amount). Two submissions with identical claim details collide here
 * even when the screenshot is rotated/resaved (which would defeat
 * proofHash alone).
 */
export function computeMetadataHash(input: {
  method: string;
  txnIdNorm?: string | null;
  senderPhone?: string | null;
  amount: number;
  currency?: string | null;
}): string {
  const parts = [
    input.method,
    (input.txnIdNorm ?? "").toLowerCase(),
    (input.senderPhone ?? "").replace(/[^0-9+]/g, ""),
    String(Math.round(input.amount)),
    (input.currency ?? "BDT").toUpperCase(),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export interface PaymentRiskInput {
  merchantId: Types.ObjectId;
  method: string;
  txnIdNorm: string | null;
  proofHash: string | null;
  metadataHash: string;
  hasProof: boolean;
  amount: number;
  expectedAmount: number | null;
  senderPhone: string | null;
  /** Account-age signal: how many days since merchant signup. */
  merchantAgeDays: number;
}

export interface PaymentRiskResult {
  score: number;
  reasons: string[];
  requiresDualApproval: boolean;
}

const HIGH_RISK_THRESHOLD = 60;

/**
 * Score a manual payment at submission time. The score is conservative —
 * a fully-clean submission lands at ~0 and the threshold for dual approval
 * is 60. Reasons are surfaced verbatim in the admin UI.
 *
 * Signals:
 *   +25  cross-merchant txnId reuse (caller pre-checks; if it slipped through
 *        as "ok" we still re-detect here and blow up)
 *   +35  cross-merchant proof file reuse (same screenshot SHA)
 *   +25  cross-merchant metadata reuse (same claim details)
 *   +20  no proof attached AND amount > 5000 BDT
 *   +15  amount differs from plan price by >10%
 *   +15  fresh merchant (< 24h old) submitting > 1000 BDT
 *   +10  high-value submission (>= 5000 BDT)
 *   +5   no senderPhone provided on bKash/Nagad
 */
export async function scorePaymentRisk(
  input: PaymentRiskInput,
): Promise<PaymentRiskResult> {
  const reasons: string[] = [];
  let score = 0;

  // Cross-merchant collisions — do them as a SINGLE query each so a
  // submission with a busy proofHash doesn't generate fan-out.
  if (input.txnIdNorm) {
    const collision = await Payment.findOne({
      merchantId: { $ne: input.merchantId },
      method: input.method,
      txnIdNorm: input.txnIdNorm,
      status: { $in: ["pending", "reviewed", "approved"] },
    })
      .select("_id")
      .lean();
    if (collision) {
      score += 25;
      reasons.push("txn_id_reused_across_merchants");
    }
  }
  if (input.proofHash) {
    const collision = await Payment.findOne({
      merchantId: { $ne: input.merchantId },
      proofHash: input.proofHash,
      status: { $in: ["pending", "reviewed", "approved"] },
    })
      .select("_id")
      .lean();
    if (collision) {
      score += 35;
      reasons.push("proof_file_reused_across_merchants");
    }
  }
  if (input.metadataHash) {
    const collision = await Payment.findOne({
      merchantId: { $ne: input.merchantId },
      metadataHash: input.metadataHash,
      status: { $in: ["pending", "reviewed", "approved"] },
    })
      .select("_id")
      .lean();
    if (collision) {
      score += 25;
      reasons.push("metadata_reused_across_merchants");
    }
  }

  if (!input.hasProof && input.amount > 5000) {
    score += 20;
    reasons.push("no_proof_high_value");
  }
  if (
    input.expectedAmount &&
    Math.abs(input.amount - input.expectedAmount) / input.expectedAmount > 0.1
  ) {
    score += 15;
    reasons.push("amount_mismatch");
  }
  if (input.merchantAgeDays < 1 && input.amount > 1000) {
    score += 15;
    reasons.push("fresh_merchant_high_value");
  }
  if (input.amount >= 5000) {
    score += 10;
    reasons.push("high_value_payment");
  }
  if (
    (input.method === "bkash" || input.method === "nagad") &&
    !input.senderPhone
  ) {
    score += 5;
    reasons.push("missing_sender_phone");
  }

  score = Math.min(100, score);
  return {
    score,
    reasons,
    requiresDualApproval: score >= HIGH_RISK_THRESHOLD,
  };
}

export const __TEST = { DAY_MS, HIGH_RISK_THRESHOLD };
