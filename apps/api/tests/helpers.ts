import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { Merchant } from "@ecom/db";
import { appRouter } from "../src/server/routers/index.js";
import type { AuthUser } from "../src/server/trpc.js";

export async function ensureDb() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI!);
  }
}

export async function disconnectDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

export async function resetDb() {
  await ensureDb();
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function createMerchant(overrides: Partial<{ email: string; businessName: string }> = {}) {
  await ensureDb();
  const passwordHash = await bcrypt.hash("password123", 10);
  return Merchant.create({
    businessName: overrides.businessName ?? "Test Merchant",
    email: overrides.email ?? `test-${Date.now()}-${Math.random()}@test.com`,
    passwordHash,
    phone: "+8801700000000",
    country: "BD",
    language: "en",
    couriers: [
      { name: "Steadfast", accountId: "acc-sf", apiKey: "k", preferredDistricts: ["Dhaka", "Chattogram"] },
      { name: "Pathao", accountId: "acc-ph", apiKey: "k", preferredDistricts: ["Sylhet"] },
    ],
  });
}

export function callerFor(user: AuthUser) {
  return appRouter.createCaller({ user });
}

export function authUserFor(merchant: { _id: unknown; email: string; role: string }): AuthUser {
  return { id: String(merchant._id), email: merchant.email, role: merchant.role as AuthUser["role"] };
}
