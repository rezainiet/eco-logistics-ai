import { listPlans, type PlanTier } from "@ecom/types";
import { env } from "../env.js";
import {
  createPrice,
  createProduct,
  findProductByTier,
  getPriceIdForPlan,
  listPricesForProduct,
} from "../lib/stripe.js";
import { loadBrandingFromStore } from "../lib/branding-store.js";

/**
 * Bootstrap script — provisions one Stripe Product per plan tier and a
 * monthly recurring Price for each. Idempotent: re-running re-uses the
 * Product (matched by `metadata.tier`) and re-uses the Price if an
 * identical (currency, unit_amount, interval=month) Price already exists.
 *
 * Output is a block of `STRIPE_PRICE_<TIER>=…` lines you copy into your
 * `.env`. Subscription checkout reads those at runtime via
 * `getPriceIdForPlan`.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_…  npm --workspace @ecom/api run stripe:seed
 *   STRIPE_SECRET_KEY=sk_test_…  npm --workspace @ecom/api run stripe:seed -- --currency=USD
 *
 * Flags:
 *   --currency=USD  (default)  — bills in USD using priceUSD
 *   --currency=BDT             — bills in BDT using priceBDT (requires
 *                                merchant Stripe account with BDT support)
 *   --skip-existing            — log already-provisioned tiers but don't reprice
 *
 * Safe to run against production. Never deletes anything.
 */

interface CliFlags {
  currency: "USD" | "BDT";
  skipExisting: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  let currency: CliFlags["currency"] = "USD";
  let skipExisting = false;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--currency=")) {
      const v = arg.slice("--currency=".length).toUpperCase();
      if (v === "USD" || v === "BDT") currency = v;
      else {
        throw new Error(`unsupported --currency=${v} (USD or BDT only)`);
      }
    } else if (arg === "--skip-existing") {
      skipExisting = true;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return { currency, skipExisting };
}

interface SeedResult {
  tier: PlanTier;
  productId: string;
  priceId: string;
  reused: { product: boolean; price: boolean };
}

async function seedTier(
  tier: PlanTier,
  flags: CliFlags,
): Promise<SeedResult> {
  const plans = listPlans();
  const plan = plans.find((p) => p.tier === tier);
  if (!plan) throw new Error(`plan not found: ${tier}`);

  // 1) Product — match by metadata.tier so re-runs reuse the same record.
  const found = await findProductByTier(tier);
  let productId: string;
  let productReused = false;
  if (found) {
    productId = found.id;
    productReused = true;
    console.log(`[seed] tier=${tier} product reused id=${productId}`);
  } else {
    // Prefix from centralized branding so the Stripe Product name + every
    // future receipt match the SaaS identity. Re-runs are idempotent: an
    // already-provisioned tier hits the `found` branch above and the name
    // is left as-is. To rename existing products, run the dedicated
    // migration script (see BRANDING_ARCHITECTURE.md § 4.5).
    const branding = await loadBrandingFromStore();
    const created = await createProduct({
      name: `${branding.operational.stripeProductPrefix} ${plan.name}`,
      description: plan.tagline,
      metadata: { tier, source: "ecom-branding-seed" },
    });
    productId = created.id;
    console.log(`[seed] tier=${tier} product created id=${productId}`);
  }

  // 2) Price — match-or-create. Stripe Prices are immutable, so we create
  // a new one if amount or currency changed (the old one stays for already-
  // subscribed merchants).
  const unitAmount =
    flags.currency === "USD"
      ? Math.round(plan.priceUSD * 100)
      : Math.round(plan.priceBDT * 100);

  const existing = await listPricesForProduct(productId);
  const match = existing.find(
    (p) =>
      p.active &&
      p.recurring?.interval === "month" &&
      typeof p.unit_amount === "number" &&
      p.unit_amount === unitAmount &&
      typeof p.currency === "string" &&
      p.currency.toUpperCase() === flags.currency,
  );

  let priceId: string;
  let priceReused = false;
  if (match) {
    priceId = match.id;
    priceReused = true;
    console.log(
      `[seed] tier=${tier} price reused id=${priceId} ${flags.currency} ${unitAmount}`,
    );
  } else if (flags.skipExisting) {
    throw new Error(
      `tier=${tier} no existing price matches and --skip-existing was passed`,
    );
  } else {
    const created = await createPrice({
      productId,
      unitAmount,
      currency: flags.currency,
      interval: "month",
      metadata: { tier, source: "ecom-logistics-seed" },
    });
    priceId = created.id;
    console.log(
      `[seed] tier=${tier} price created id=${priceId} ${flags.currency} ${unitAmount}`,
    );
  }

  return {
    tier,
    productId,
    priceId,
    reused: { product: productReused, price: priceReused },
  };
}

async function main() {
  if (!env.STRIPE_SECRET_KEY) {
    console.error(
      "[seed] STRIPE_SECRET_KEY is required. Set it (sk_test_… for sandbox) and re-run.",
    );
    process.exit(1);
  }
  const flags = parseFlags(process.argv);
  console.log(`[seed] currency=${flags.currency} skipExisting=${flags.skipExisting}`);

  const tiers: PlanTier[] = ["starter", "growth", "scale", "enterprise"];
  const results: SeedResult[] = [];
  for (const tier of tiers) {
    const r = await seedTier(tier, flags);
    results.push(r);
  }

  console.log("\n[seed] copy the block below into your .env file:\n");
  for (const r of results) {
    console.log(`STRIPE_PRICE_${r.tier.toUpperCase()}=${r.priceId}`);
  }
  console.log("\n[seed] verifying current env (after restart):");
  for (const r of results) {
    const inEnv = getPriceIdForPlan(r.tier);
    const ok = inEnv === r.priceId ? "✓" : "·";
    console.log(`  ${ok} ${r.tier}: env=${inEnv ?? "(unset)"} stripe=${r.priceId}`);
  }
  console.log("\n[seed] done");
}

main().catch((err) => {
  console.error("[seed] fatal", err);
  process.exit(1);
});
