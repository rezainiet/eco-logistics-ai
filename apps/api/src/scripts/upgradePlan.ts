/**
 * Upgrade a merchant's subscription plan from the CLI.
 *
 * Usage:
 *   npx tsx src/scripts/upgradePlan.ts \
 *     [--email=<merchant email>] \
 *     [--tier=starter|growth|scale|enterprise] \
 *     [--days=<billing-period length>]
 *
 * Defaults: email=masudreza.dev@gmail.com, tier=growth, days=30.
 *
 * Looks the merchant up first, fails loudly if not found, sets the matching
 * plan rate from the catalogue, stamps activatedAt/activatedBy, and prints
 * before/after subscription snapshots so it's obvious whether the write
 * actually flipped state.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Merchant } from "@ecom/db";
import { connectDb } from "../lib/db.js";
import { getPlan, isPlanTier, type PlanTier } from "../lib/plans.js";

interface Args {
  email: string;
  tier: PlanTier;
  days: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const email = get("email") ?? "masudreza.dev@gmail.com";
  const tierRaw = get("tier") ?? "growth";
  const days = Number(get("days") ?? "30");
  if (!isPlanTier(tierRaw)) {
    throw new Error(
      `invalid --tier=${tierRaw}. valid tiers: starter, growth, scale, enterprise`,
    );
  }
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`invalid --days=${days}. must be a positive number`);
  }
  return { email, tier: tierRaw, days };
}

function snapshot(sub: Record<string, unknown> | undefined | null): string {
  if (!sub) return "(no subscription doc)";
  const pick = ["tier", "status", "rate", "startDate", "activatedAt", "activatedBy", "currentPeriodEnd"];
  return pick.map((k) => `${k}=${JSON.stringify((sub as Record<string, unknown>)[k] ?? null)}`).join(" ");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const plan = getPlan(args.tier);
  console.log(
    `[upgradePlan] target: email=${args.email} tier=${args.tier} (${plan.name} — ৳${plan.priceBDT}/mo) days=${args.days}`,
  );

  await connectDb();

  const before = await Merchant.findOne({ email: args.email })
    .select("_id email subscription")
    .lean<{ _id: unknown; email: string; subscription?: Record<string, unknown> }>();
  if (!before) {
    throw new Error(`merchant not found for email=${args.email}`);
  }
  console.log(`[upgradePlan] BEFORE  ${snapshot(before.subscription)}`);

  const now = new Date();
  const periodEnd = new Date(now.getTime() + args.days * 86_400_000);

  const res = await Merchant.updateOne(
    { _id: before._id },
    {
      $set: {
        "subscription.tier": args.tier,
        "subscription.rate": plan.priceBDT,
        "subscription.status": "active",
        "subscription.startDate": now,
        "subscription.activatedAt": now,
        "subscription.activatedBy": "upgradePlan-script",
        "subscription.currentPeriodEnd": periodEnd,
      },
      // Clear trial / grace bookkeeping so leftover state from a prior cycle
      // can't flip status back to past_due / trial on the next sweep.
      $unset: {
        "subscription.trialEndsAt": "",
        "subscription.gracePeriodEndsAt": "",
      },
    },
  );
  console.log(
    `[upgradePlan] write    matched=${res.matchedCount} modified=${res.modifiedCount}`,
  );
  if (res.matchedCount === 0) {
    throw new Error("update matched 0 documents — merchant disappeared mid-run");
  }

  const after = await Merchant.findById(before._id)
    .select("subscription")
    .lean<{ subscription?: Record<string, unknown> }>();
  console.log(`[upgradePlan] AFTER   ${snapshot(after?.subscription)}`);

  const sub = after?.subscription as { tier?: string; status?: string } | undefined;
  if (sub?.tier !== args.tier || sub?.status !== "active") {
    throw new Error(
      `verification failed — expected tier=${args.tier} status=active, got tier=${sub?.tier} status=${sub?.status}`,
    );
  }
  console.log("[upgradePlan] ✔ upgrade verified");
}

main()
  .catch((err) => {
    console.error("[upgradePlan] FAILED:", (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
  });
