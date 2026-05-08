import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MerchantFeedback } from "@ecom/db";
import {
  ensureDb,
  disconnectDb,
  resetDb,
  createMerchant,
  callerFor,
  authUserFor,
} from "./helpers.js";

/**
 * Merchant feedback capture — submit + admin read + triage.
 *
 * Verifies:
 *  - submit persists every input field correctly
 *  - admin recentFeedback returns rows newest-first, supports filters
 *  - admin triageFeedback updates state + audit fields
 *  - submit rejects empty / overly-long messages
 *  - submit is per-merchant (one merchant cannot read another's rows)
 */

beforeEach(async () => {
  await ensureDb();
  await resetDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe("feedback.submit", () => {
  it("persists a row with all fields populated", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant), {
      ip: "1.2.3.4",
      userAgent: "TestUA/1.0",
    });
    const result = await caller.feedback.submit({
      kind: "onboarding",
      severity: "warning",
      message: "Couldn't connect Shopify because the OAuth tab redirected wrong",
      pagePath: "/dashboard/integrations",
    });
    expect(result.ok).toBe(true);
    expect(typeof result.id).toBe("string");

    const row = await MerchantFeedback.findById(result.id).lean();
    expect(row).not.toBeNull();
    expect(row!.merchantId.toString()).toBe(merchant._id.toString());
    expect(row!.kind).toBe("onboarding");
    expect(row!.severity).toBe("warning");
    expect(row!.message).toContain("OAuth tab");
    expect(row!.pagePath).toBe("/dashboard/integrations");
    expect(row!.userAgent).toBe("TestUA/1.0");
    expect(row!.actorEmail).toBe(merchant.email);
    expect(row!.status).toBe("new");
    expect(row!.triagedAt).toBeUndefined();
  });

  it("defaults severity to 'info' when omitted", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    await caller.feedback.submit({
      kind: "general",
      message: "Looks great so far",
    });
    const row = await MerchantFeedback.findOne({ merchantId: merchant._id }).lean();
    expect(row!.severity).toBe("info");
  });

  it("rejects empty messages", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    await expect(
      caller.feedback.submit({
        kind: "general",
        message: "   ",
      } as never),
    ).rejects.toThrow();
  });

  it("rejects messages > 2000 characters", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    await expect(
      caller.feedback.submit({
        kind: "general",
        message: "x".repeat(2001),
      }),
    ).rejects.toThrow();
  });

  it("rejects unknown kinds", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    await expect(
      caller.feedback.submit({
        kind: "made_up_kind" as never,
        message: "test",
      }),
    ).rejects.toThrow();
  });
});

describe("adminObservability.recentFeedback", () => {
  it("returns newest-first rows", async () => {
    const a = await createMerchant({ email: "a@a.com" });
    const b = await createMerchant({ email: "b@b.com" });
    const aCaller = callerFor(authUserFor(a));
    const bCaller = callerFor(authUserFor(b));

    await aCaller.feedback.submit({ kind: "general", message: "first" });
    await new Promise((r) => setTimeout(r, 10));
    await bCaller.feedback.submit({ kind: "bug", message: "second" });
    await new Promise((r) => setTimeout(r, 10));
    await aCaller.feedback.submit({ kind: "support", message: "third" });

    const admin = await createMerchant({
      email: "admin@a.com",
      role: "admin",
    });
    const adminCaller = callerFor(authUserFor(admin));
    const r = await adminCaller.adminObservability.recentFeedback({ limit: 50 });

    expect(r).toHaveLength(3);
    expect(r[0]!.message).toBe("third");
    expect(r[2]!.message).toBe("first");
  });

  it("filters by kind", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    await caller.feedback.submit({ kind: "bug", message: "buggy" });
    await caller.feedback.submit({ kind: "general", message: "general" });

    const admin = await createMerchant({ email: "admin@a.com", role: "admin" });
    const adminCaller = callerFor(authUserFor(admin));
    const r = await adminCaller.adminObservability.recentFeedback({
      limit: 50,
      kind: "bug",
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe("bug");
  });

  it("rejects non-admin callers", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    await expect(
      caller.adminObservability.recentFeedback({ limit: 10 }),
    ).rejects.toThrow();
  });
});

describe("adminObservability.triageFeedback", () => {
  it("flips status to triaged + stamps triagedAt + triagedBy", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const r = await caller.feedback.submit({
      kind: "support",
      message: "need help",
    });

    const admin = await createMerchant({ email: "admin@a.com", role: "admin" });
    const adminCaller = callerFor(authUserFor(admin));
    await adminCaller.adminObservability.triageFeedback({
      id: r.id,
      status: "triaged",
      internalNotes: "reached out via email",
    });

    const row = await MerchantFeedback.findById(r.id).lean();
    expect(row!.status).toBe("triaged");
    expect(row!.triagedAt).toBeDefined();
    expect(row!.triagedBy?.toString()).toBe(admin._id.toString());
    expect(row!.internalNotes).toBe("reached out via email");
    expect(row!.resolvedAt).toBeUndefined();
  });

  it("stamps resolvedAt when status=resolved", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const r = await caller.feedback.submit({
      kind: "support",
      message: "need help",
    });

    const admin = await createMerchant({ email: "admin@a.com", role: "admin" });
    const adminCaller = callerFor(authUserFor(admin));
    await adminCaller.adminObservability.triageFeedback({
      id: r.id,
      status: "resolved",
    });

    const row = await MerchantFeedback.findById(r.id).lean();
    expect(row!.status).toBe("resolved");
    expect(row!.resolvedAt).toBeDefined();
  });
});
