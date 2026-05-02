import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { Merchant } from "@ecom/db";
import { appRouter } from "../src/server/routers/index.js";
import { encryptSecret } from "../src/lib/crypto.js";
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
  // Clear in-process caches that might survive between tests since vitest
  // runs in singleFork mode. Best-effort: ignore failures so tests in
  // packages that don't import these libs still work.
  try {
    const rbac = await import("../src/lib/admin-rbac.js");
    rbac.invalidateAdminProfile?.("");
    // Drop everything by re-importing the cache module — easier:
    if ("__resetForTests" in rbac && typeof rbac.__resetForTests === "function") {
      (rbac.__resetForTests as () => void)();
    }
  } catch {
    /* no admin-rbac in this test bundle */
  }
  try {
    const stepup = await import("../src/lib/admin-stepup.js");
    stepup.__resetStepupForTests?.();
  } catch {
    /* no stepup in this test bundle */
  }
  try {
    const trpc = await import("../src/server/trpc.js");
    trpc.invalidateRoleCache?.("");
  } catch {
    /* trpc not loaded yet */
  }
  try {
    const audit = await import("../src/lib/audit.js");
    audit.__resetAuditChainCache?.();
  } catch {
    /* audit not loaded yet */
  }
  try {
    const guard = await import("../src/lib/tracking-guard.js");
    guard.__resetTrackingGuardForTests?.();
  } catch {
    /* tracking guard not loaded yet */
  }
  try {
    const collector = await import("../src/server/tracking/collector.js");
    collector.__resetCollectorCache?.();
  } catch {
    /* collector not loaded yet */
  }
  try {
    const breaker = await import("../src/lib/couriers/circuit-breaker.js");
    breaker.__resetBreakersForTests?.();
  } catch {
    /* breaker not loaded yet */
  }
}

export async function createMerchant(
  overrides: Partial<{
    email: string;
    businessName: string;
    role: "merchant" | "admin" | "agent";
    tier: "starter" | "growth" | "scale" | "enterprise";
    status: "trial" | "active" | "past_due" | "paused" | "suspended" | "cancelled";
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
  }> = {},
) {
  await ensureDb();
  const passwordHash = await bcrypt.hash("password123", 10);
  // Default test merchants run on Scale/active so legacy tests that exercise
  // fraud review + day-7 connectors (custom_api, multiple integrations,
  // advanced behavior tables) don't trip the plan gates. Tier-specific tests
  // opt down with `{ tier: "starter" }` etc.
  const tier = overrides.tier ?? "scale";
  const status = overrides.status ?? "active";
  return Merchant.create({
    businessName: overrides.businessName ?? "Test Merchant",
    email: overrides.email ?? `test-${Date.now()}-${Math.random()}@test.com`,
    passwordHash,
    phone: "+8801700000000",
    country: "BD",
    language: "en",
    role: overrides.role ?? "merchant",
    subscription: {
      tier,
      status,
      startDate: new Date(),
      ...(overrides.trialEndsAt !== undefined
        ? { trialEndsAt: overrides.trialEndsAt }
        : status === "trial"
          ? { trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) }
          : {}),
      ...(overrides.currentPeriodEnd !== undefined
        ? { currentPeriodEnd: overrides.currentPeriodEnd }
        : status === "active"
          ? { currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }
          : {}),
    },
    couriers: [
      {
        name: "steadfast",
        accountId: "acc-sf",
        apiKey: encryptSecret("sk_test_sf"),
        preferredDistricts: ["Dhaka", "Chattogram"],
      },
      {
        name: "pathao",
        accountId: "acc-ph",
        apiKey: encryptSecret("sk_test_ph"),
        apiSecret: encryptSecret("ph_secret"),
        preferredDistricts: ["Sylhet"],
      },
    ],
  });
}

export function callerFor(
  user: AuthUser,
  request: {
    ip: string | null;
    userAgent: string | null;
    cookieAuth?: boolean;
    csrfHeader?: string | null;
    csrfCookie?: string | null;
  } = { ip: null, userAgent: null },
) {
  const fullRequest = {
    ip: request.ip,
    userAgent: request.userAgent,
    cookieAuth: request.cookieAuth ?? false,
    csrfHeader: request.csrfHeader ?? null,
    csrfCookie: request.csrfCookie ?? null,
  };
  return appRouter.createCaller({ user, request: fullRequest });
}

export function authUserFor(merchant: { _id: unknown; email: string; role: string }): AuthUser {
  return { id: String(merchant._id), email: merchant.email, role: merchant.role as AuthUser["role"] };
}
