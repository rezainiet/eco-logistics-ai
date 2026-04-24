import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { CallLog, Merchant, Order } from "@ecom/db";
import { connectDb } from "../lib/db.js";
import { encryptSecret } from "../lib/crypto.js";

const WIPE = process.argv.includes("--wipe");

const DISTRICTS = ["Dhaka", "Chattogram", "Sylhet", "Khulna", "Rajshahi", "Barishal"];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function randomPhone(): string {
  return "+8801" + Math.floor(100000000 + Math.random() * 900000000).toString();
}

async function main() {
  await connectDb();

  if (WIPE) {
    console.log("[seed] wiping collections…");
    await Promise.all([Merchant.deleteMany({}), Order.deleteMany({}), CallLog.deleteMany({})]);
  }

  const passwordHash = await bcrypt.hash("password123", 10);

  const createdMerchants = await Merchant.create([
    {
      businessName: "Acme Electronics",
      email: "owner@acme.test",
      passwordHash,
      phone: "+8801711111111",
      country: "BD",
      language: "bn",
      subscription: {
        tier: "growth",
        rate: 2499,
        status: "active",
        startDate: new Date("2026-01-01"),
        activatedAt: new Date("2026-01-01"),
        activatedBy: "seed",
        currentPeriodEnd: new Date("2026-12-31"),
      },
      couriers: [
        {
          name: "steadfast",
          accountId: "acme-steadfast",
          apiKey: encryptSecret("sk_test_acme_sf"),
          preferredDistricts: ["Dhaka", "Chattogram"],
        },
        {
          name: "pathao",
          accountId: "acme-pathao",
          apiKey: encryptSecret("sk_test_acme_ph"),
          preferredDistricts: ["Sylhet"],
        },
      ],
    },
    {
      businessName: "Nova Apparel",
      email: "owner@nova.test",
      passwordHash,
      phone: "+8801722222222",
      country: "BD",
      language: "en",
      subscription: {
        tier: "starter",
        rate: 999,
        status: "trial",
        startDate: new Date("2026-04-01"),
        trialEndsAt: new Date("2026-04-15"),
      },
      couriers: [
        {
          name: "redx",
          accountId: "nova-redx",
          apiKey: encryptSecret("sk_test_nova_redx"),
          preferredDistricts: ["Khulna", "Rajshahi"],
        },
      ],
    },
  ]);

  const [acme, nova] = createdMerchants;
  if (!acme || !nova) throw new Error("merchant creation failed");
  console.log(`[seed] created merchants: ${acme.email}, ${nova.email}`);

  const orders = [];
  for (const merchant of createdMerchants) {
    for (let i = 1; i <= 30; i++) {
      const cod = 500 + Math.floor(Math.random() * 5000);
      const district = pick(DISTRICTS);
      const riskScore = cod > 4000 ? 70 + Math.floor(Math.random() * 20) : Math.floor(Math.random() * 40);
      const daysAgo = Math.floor(Math.random() * 7);
      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - daysAgo);
      createdAt.setHours(10 + Math.floor(Math.random() * 8), 0, 0, 0);
      orders.push({
        merchantId: merchant._id,
        orderNumber: `${merchant.businessName.split(" ")[0]!.toUpperCase()}-${1000 + i}`,
        customer: {
          name: `Customer ${i}`,
          phone: randomPhone(),
          address: `House ${i}, Road ${i}, ${district}`,
          district,
        },
        items: [
          { name: "Sample Item", sku: `SKU-${i}`, quantity: 1, price: cod },
        ],
        order: {
          cod,
          total: cod,
          status: pick(["pending", "confirmed", "shipped", "delivered", "delivered", "rto"] as const),
        },
        logistics: {
          courier: merchant.couriers[0]?.name ?? "pathao",
          trackingNumber: `TRK-${merchant._id.toString().slice(-4)}-${i}`,
        },
        fraud: {
          detected: riskScore >= 70,
          riskScore,
          reasons: riskScore >= 70 ? ["high_cod_value"] : [],
        },
        createdAt,
      });
    }
  }

  const createdOrders = await Order.create(orders);
  console.log(`[seed] created ${createdOrders.length} orders`);

  const calls = [];
  for (const order of createdOrders) {
    const callCount = 1 + Math.floor(Math.random() * 3);
    for (let c = 0; c < callCount; c++) {
      const hour = 9 + Math.floor(Math.random() * 10);
      const timestamp = new Date();
      timestamp.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
      const answered = Math.random() > 0.3;
      calls.push({
        merchantId: order.merchantId,
        orderId: order._id,
        timestamp,
        hour,
        duration: answered ? 30 + Math.floor(Math.random() * 120) : 0,
        answered,
        outcome: answered && Math.random() > 0.4
          ? { successful: true, deliverySuccessDate: new Date(timestamp.getTime() + 86400000) }
          : { successful: false },
      });
    }
  }

  const createdCalls = await CallLog.create(calls);
  console.log(`[seed] created ${createdCalls.length} call logs`);

  await mongoose.disconnect();
  console.log("[seed] done");
}

main().catch(async (err) => {
  console.error("[seed] failed", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
