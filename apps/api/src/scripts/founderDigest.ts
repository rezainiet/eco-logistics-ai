import mongoose from "mongoose";
import { ImportJob, Merchant, Order } from "@ecom/db";
import { connectDb } from "../lib/db.js";
import {
  classifyMerchantHealth,
  type MerchantHealth,
} from "../lib/merchant-health.js";

/**
 * Daily founder digest — per merchant, from data that already exists.
 *
 * The instrumentation primitives (telemetry, structured logs,
 * ops:triage, audit) are all PULL and FLEET-WIDE. The thing that
 * actually kills a private beta is a single merchant silently
 * disengaging — connected, then nobody works the queue, orders age
 * into RTO, they churn at renewal and you never saw it. This is the
 * once-a-day per-merchant readout that makes that visible.
 *
 * Read-only. No analytics store, no dashboard. A founder reads ~20
 * lines over morning tea and knows who to message.
 *
 *   npm --workspace apps/api run ops:digest
 *   npm --workspace apps/api run ops:digest -- --json
 */

const asJson = process.argv.slice(2).includes("--json");
const DAY = 86_400_000;

function ageHuman(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "<1h";
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function hoursSince(d: Date | null | undefined): number | null {
  return d ? (Date.now() - new Date(d).getTime()) / 3_600_000 : null;
}
function daysSince(d: Date | null | undefined): number | null {
  const h = hoursSince(d);
  return h === null ? null : Math.floor(h / 24);
}

interface MerchantRow {
  merchant: string;
  ordersAllTime: number;
  orders24h: number;
  pending: number;
  oldestPendingAge: string;
  replyRate7d: number | null;
  confirmAttempts7d: number;
  failedImports: number;
  lastOrderAge: string;
  status: MerchantHealth;
  reason: string;
}

async function main(): Promise<void> {
  await connectDb();
  const now = Date.now();
  const since7d = new Date(now - 7 * DAY);
  const since24h = new Date(now - DAY);

  const merchants = await Merchant.find({})
    .select("businessName createdAt")
    .sort({ createdAt: 1 })
    .lean<Array<{ _id: unknown; businessName?: string; createdAt?: Date }>>();

  const rows: MerchantRow[] = [];

  for (const m of merchants) {
    const merchantId = m._id;
    const [
      ordersAllTime,
      orders24h,
      pending,
      oldestPendingDoc,
      confirmAttempts7d,
      replied7d,
      lastOrderDoc,
      failedImports,
    ] = await Promise.all([
      Order.countDocuments({ merchantId }),
      Order.countDocuments({ merchantId, createdAt: { $gte: since24h } }),
      Order.countDocuments({
        merchantId,
        "automation.state": "pending_confirmation",
      }),
      Order.findOne({
        merchantId,
        "automation.state": "pending_confirmation",
      })
        .sort({ createdAt: 1 })
        .select("createdAt")
        .lean<{ createdAt?: Date } | null>(),
      // "Confirmation attempted" proxy: a code was minted (the SMS path
      // ran) for an order created in the window.
      Order.countDocuments({
        merchantId,
        createdAt: { $gte: since7d },
        "automation.confirmationCode": { $exists: true, $ne: null },
      }),
      Order.countDocuments({
        merchantId,
        createdAt: { $gte: since7d },
        "fraud.smsFeedback": { $in: ["confirmed", "rejected"] },
      }),
      Order.findOne({ merchantId })
        .sort({ createdAt: -1 })
        .select("createdAt")
        .lean<{ createdAt?: Date } | null>(),
      ImportJob.countDocuments({ merchantId, status: "failed" }),
    ]);

    const replyRate7d =
      confirmAttempts7d > 0
        ? Math.round((replied7d / confirmAttempts7d) * 100)
        : null;
    const health = classifyMerchantHealth({
      accountAgeDays: daysSince(m.createdAt) ?? 0,
      ordersAllTime,
      lastOrderAgeDays: daysSince(lastOrderDoc?.createdAt),
      pending,
      oldestPendingAgeHours: hoursSince(oldestPendingDoc?.createdAt),
      confirmAttempts7d,
      replyRate7dPct: replyRate7d,
      failedImports,
    });

    rows.push({
      merchant: m.businessName ?? String(merchantId),
      ordersAllTime,
      orders24h,
      pending,
      oldestPendingAge: ageHuman(oldestPendingDoc?.createdAt),
      replyRate7d,
      confirmAttempts7d,
      failedImports,
      lastOrderAge: ageHuman(lastOrderDoc?.createdAt),
      status: health.status,
      reason: health.reason,
    });
  }

  if (asJson) {
    console.log(
      JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2),
    );
    return;
  }

  // Unhealthy first — the founder reads top-down and stops when the
  // ⚠ lines run out.
  const order: MerchantHealth[] = [
    "onboarding_stuck",
    "sync_issues",
    "queue_neglected",
    "low_confirmation",
    "inactive",
    "healthy",
  ];
  rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const needAttention = rows.filter((r) => r.status !== "healthy").length;

  console.log(`=== ConfirmX founder digest — ${new Date().toISOString()} ===`);
  console.log(
    `${merchants.length} merchant(s) · ${needAttention} need attention. ` +
      `Reply-rate window = 7d.\n`,
  );
  for (const r of rows) {
    const tag =
      r.status === "healthy" ? "  ok" : `  ⚠ ${r.status.toUpperCase()}`;
    console.log(
      `• ${r.merchant} —${tag}\n` +
        (r.status !== "healthy" ? `    ${r.reason}\n` : "") +
        `    orders: ${r.ordersAllTime} all / ${r.orders24h} in 24h · last ${r.lastOrderAge} ago\n` +
        `    queue: ${r.pending} pending · oldest ${r.oldestPendingAge}\n` +
        `    reply rate 7d: ${
          r.replyRate7d === null
            ? "n/a (no confirmations sent)"
            : `${r.replyRate7d}% of ${r.confirmAttempts7d}`
        }\n` +
        `    failed imports: ${r.failedImports}`,
    );
  }
  console.log(
    "\nWork the ⚠ lines first. LOW_CONFIRMATION is the canary: customers" +
      "\naren't engaging the SMS — that's the product thesis under test.",
  );
}

main()
  .catch((err) => {
    console.error("[founder-digest] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void mongoose.disconnect().catch(() => {});
  });
