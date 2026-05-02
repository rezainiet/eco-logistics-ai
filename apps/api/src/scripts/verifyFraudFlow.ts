import "dotenv/config";
import { Types } from "mongoose";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Merchant, Order } from "@ecom/db";
import { connectDb } from "../lib/db.js";
import {
  collectRiskHistory,
  computeRisk,
  hashAddress,
  type RiskOptions,
} from "../server/risk.js";

const TEST_PREFIX = "vfraud-";
const TEST_EMAIL = `${TEST_PREFIX}owner@test.local`;

async function ensureMerchant(): Promise<Types.ObjectId> {
  const existing = await Merchant.findOne({ email: TEST_EMAIL }).select("_id");
  if (existing) return existing._id as Types.ObjectId;
  const passwordHash = await bcrypt.hash("password123", 10);
  const m = await Merchant.create({
    businessName: "Verify Fraud Co",
    email: TEST_EMAIL,
    passwordHash,
    phone: "+8801700000000",
    country: "BD",
    language: "en",
    subscription: {
      tier: "growth",
      rate: 2499,
      status: "active",
      startDate: new Date(),
      activatedAt: new Date(),
      activatedBy: "verify-script",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });
  return m._id as Types.ObjectId;
}

interface Case {
  label: string;
  customer: { name: string; phone: string; address: string; district: string };
  cod: number;
}

function nowSuffix(): string {
  return Date.now().toString(36);
}

async function scoreAndCreate(
  merchantId: Types.ObjectId,
  c: Case,
  opts: RiskOptions,
): Promise<{
  id: string;
  level: string;
  score: number;
  reviewStatus: string;
  reasons: string[];
  confidence: number;
  confidenceLabel: string;
  hardBlocked: boolean;
}> {
  const addressHash = hashAddress(c.customer.address, c.customer.district);
  const history = await collectRiskHistory({
    merchantId,
    phone: c.customer.phone,
    addressHash: addressHash ?? undefined,
    halfLifeDays: 30,
    velocityWindowMin: 10,
  });
  console.log(`  [hist] ${c.label} phone=${c.customer.phone} hist=${JSON.stringify(history)}`);
  const risk = computeRisk(
    {
      cod: c.cod,
      customer: c.customer,
      addressHash,
    },
    history,
    opts,
  );
  const order = await Order.create({
    merchantId,
    orderNumber: `VF-${nowSuffix()}-${Math.floor(Math.random() * 999)}`,
    customer: c.customer,
    items: [{ name: "test item", quantity: 1, price: c.cod }],
    order: { cod: c.cod, total: c.cod, status: "pending" },
    fraud: {
      detected: risk.level === "high",
      riskScore: risk.riskScore,
      level: risk.level,
      reasons: risk.reasons,
      signals: risk.signals,
      reviewStatus: risk.reviewStatus,
      scoredAt: new Date(),
      confidence: risk.confidence,
      confidenceLabel: risk.confidenceLabel,
      hardBlocked: risk.hardBlocked,
    },
    source: { addressHash: addressHash ?? undefined, channel: "dashboard" },
  });
  return {
    id: String(order._id),
    level: risk.level,
    score: risk.riskScore,
    reviewStatus: risk.reviewStatus,
    reasons: risk.reasons,
    confidence: risk.confidence,
    confidenceLabel: risk.confidenceLabel,
    hardBlocked: risk.hardBlocked,
  };
}

async function main() {
  console.log("[verify] connecting DB…");
  await connectDb();
  console.log("[verify] DB connected");

  const merchantId = await ensureMerchant();
  console.log("[verify] merchantId:", String(merchantId));

  // Wipe any prior test orders for repeatable runs
  const wipe = await Order.deleteMany({ merchantId, orderNumber: /^VF-/ });
  console.log(`[verify] wiped ${wipe.deletedCount} prior verify orders`);

  const opts: RiskOptions = {
    suspiciousDistricts: [],
    blockedPhones: [],
    blockedAddresses: [],
    // Leave velocityThreshold unset so computeRisk applies its new default (3).
  };

  const dupPhone = "+8801911223344";
  const cases: Case[] = [
    {
      label: "A: normal",
      customer: {
        name: "Rahim Ahmed",
        phone: "+8801712345678",
        address: "House 12, Road 5, Banani",
        district: "Dhaka",
      },
      cod: 800,
    },
    {
      label: "B: suspicious",
      customer: {
        name: "Karim X",
        phone: "+8801812345670",
        address: "near market",
        district: "Sylhet",
      },
      cod: 4500,
    },
    {
      label: "C: high-risk",
      customer: {
        name: "xxxx",
        phone: "00000000000",
        address: "asdf qwerty",
        district: "unknown",
      },
      cod: 25000,
    },
    {
      label: "D1: dup phone #1",
      customer: {
        name: "Rashid",
        phone: dupPhone,
        address: "House 1, Road 1, Mirpur",
        district: "Dhaka",
      },
      cod: 1500,
    },
    {
      label: "D2: dup phone #2",
      customer: {
        name: "Rashid",
        phone: dupPhone,
        address: "House 1, Road 1, Mirpur",
        district: "Dhaka",
      },
      cod: 1500,
    },
    {
      label: "D3: dup phone #3",
      customer: {
        name: "Rashid",
        phone: dupPhone,
        address: "House 1, Road 1, Mirpur",
        district: "Dhaka",
      },
      cod: 1500,
    },
    {
      label: "D4: dup phone #4",
      customer: {
        name: "Rashid",
        phone: dupPhone,
        address: "House 1, Road 1, Mirpur",
        district: "Dhaka",
      },
      cod: 1500,
    },
    {
      label: "E: edge — placeholder fields",
      customer: {
        name: "X",
        phone: "+8801999999999",
        address: "ab",
        district: "n/a",
      },
      cod: 0,
    },
  ];

  const results: Array<{
    label: string;
    level: string;
    score: number;
    reviewStatus: string;
    reasons: string[];
    confidence: number;
    confidenceLabel: string;
    hardBlocked: boolean;
  }> = [];
  for (const c of cases) {
    try {
      const r = await scoreAndCreate(merchantId, c, opts);
      console.log(
        `[verify] ${c.label} → score=${r.score} level=${r.level} confidence=${r.confidence} (${r.confidenceLabel}) hardBlocked=${r.hardBlocked} review=${r.reviewStatus}\n    reasons=${JSON.stringify(r.reasons)}`,
      );
      results.push({ label: c.label, ...r });
    } catch (err) {
      console.error(`[verify] ${c.label} FAILED:`, (err as Error).message);
    }
  }

  // Case F: blocked phone (weight=100, single-hit HIGH)
  console.log("\n[verify] Case F: blocked phone hard-block …");
  const fOpts: RiskOptions = { ...opts, blockedPhones: ["+8801555000111"] };
  const fResult = await scoreAndCreate(
    merchantId,
    {
      label: "F: blocked phone",
      customer: {
        name: "Anything",
        phone: "+8801555000111",
        address: "House 1, Mirpur",
        district: "Dhaka",
      },
      cod: 1000,
    },
    fOpts,
  );
  console.log(`[verify] F → score=${fResult.score} level=${fResult.level} review=${fResult.reviewStatus}`);
  results.push({ label: "F: blocked phone", ...fResult });

  // Determinism check: re-score a case and confirm same score
  console.log("\n[verify] determinism re-check on case A …");
  const recompute = computeRisk(
    {
      cod: cases[0]!.cod,
      customer: cases[0]!.customer,
      addressHash: hashAddress(cases[0]!.customer.address, cases[0]!.customer.district),
    },
    {
      phoneOrdersCount: 0,
      phoneReturnedCount: 0,
      phoneCancelledCount: 0,
      phoneUnreachableCount: 0,
      ipRecentCount: 0,
      phoneVelocityCount: 0,
      addressDistinctPhones: 0,
      addressReturnedCount: 0,
    },
    opts,
  );
  console.log(`[verify] determinism: pure recompute score=${recompute.riskScore} level=${recompute.level}`);

  // Verify review queue (mirror of fraud.listPendingReviews logic)
  const queue = await Order.find({
    merchantId,
    "fraud.reviewStatus": { $in: ["pending_call", "no_answer"] },
  })
    .sort({ "fraud.riskScore": -1, _id: -1 })
    .lean();
  console.log(`\n[verify] queue (pending/no_answer): ${queue.length} item(s)`);
  for (const q of queue) {
    console.log(
      `  - ${q.orderNumber} score=${(q.fraud as any)?.riskScore} level=${(q.fraud as any)?.level} review=${(q.fraud as any)?.reviewStatus}`,
    );
  }

  // Verify stats (mirror of getReviewStats aggregation)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [statsResult] = await Order.aggregate([
    { $match: { merchantId } },
    {
      $facet: {
        today: [
          { $match: { createdAt: { $gte: today } } },
          {
            $group: {
              _id: null,
              risky: { $sum: { $cond: [{ $eq: ["$fraud.level", "high"] }, 1, 0] } },
              verified: {
                $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "verified"] }, 1, 0] },
              },
              rejected: {
                $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "rejected"] }, 1, 0] },
              },
              codSaved: {
                $sum: {
                  $cond: [{ $eq: ["$fraud.reviewStatus", "rejected"] }, "$order.cod", 0],
                },
              },
            },
          },
        ],
        queue: [
          { $match: { "fraud.reviewStatus": { $in: ["pending_call", "no_answer"] } } },
          {
            $group: {
              _id: null,
              pending: {
                $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "pending_call"] }, 1, 0] },
              },
              noAnswer: {
                $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "no_answer"] }, 1, 0] },
              },
            },
          },
        ],
      },
    },
  ]);
  console.log("\n[verify] getReviewStats-like aggregation:", JSON.stringify(statsResult, null, 2));

  // Bad-input test: invalid CoD type, missing address — Mongoose validation
  console.log("\n[verify] bad-input safety check …");
  try {
    await Order.create({
      merchantId,
      orderNumber: `VF-BAD-${nowSuffix()}`,
      customer: { name: "x", phone: "00000000000", address: "", district: "" },
      items: [], // intentionally empty (must fail schema validator)
      order: { cod: -1, total: -1, status: "pending" },
      source: { channel: "dashboard" },
    });
    console.log("[verify] BAD INPUT was accepted — UNEXPECTED");
  } catch (err) {
    console.log("[verify] BAD INPUT rejected by schema (good):", (err as Error).message.split("\n")[0]);
  }

  // Persistence integrity: every order has fraud.* fields
  const total = await Order.countDocuments({ merchantId, orderNumber: /^VF-/ });
  const withFraud = await Order.countDocuments({
    merchantId,
    orderNumber: /^VF-/,
    "fraud.riskScore": { $exists: true },
    "fraud.level": { $exists: true },
    "fraud.reviewStatus": { $exists: true },
  });
  console.log(`\n[verify] persistence: total=${total} withFraudFields=${withFraud}`);

  // Print summary table
  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(
      `${r.label.padEnd(35)} score=${String(r.score).padStart(3)} conf=${String(r.confidence).padStart(3)} ${r.confidenceLabel.padEnd(7)} level=${r.level.padEnd(7)} hard=${r.hardBlocked ? "Y" : "n"} review=${r.reviewStatus}`,
    );
  }

  await mongoose.disconnect();
  console.log("\n[verify] done.");
}

main().catch(async (err) => {
  console.error("[verify] FATAL:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
