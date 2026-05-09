import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { ExternalDeliveryProfile } from "@ecom/db";
import { getOrFetchExternalProfile } from "../src/lib/external-delivery/fetch-profile.js";
import {
  computeRolloutReadiness,
  summariseValidationRun,
  type ValidationLookupOutcome,
} from "../src/lib/external-delivery/validation-summary.js";
import type {
  ExternalProviderAdapter,
  ProviderFetchResult,
} from "../src/lib/external-delivery/providers/index.js";
import { env } from "../src/env.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * End-to-end harness sanity check.
 *
 * This test simulates what the validateBdCourier CLI does: builds a
 * synthetic cohort, invokes the orchestrator with forceFetch + an
 * injected fake provider, summarises the outcomes, computes the
 * rollout-readiness verdict.
 *
 * NOT real validation. Proves the wiring is correct end-to-end so
 * when the operator runs the CLI in staging against real BDCourier
 * traffic, fewer things go wrong silently.
 */

type MutableEnv = { EXTERNAL_DELIVERY_ENABLED: boolean };
let originalFlag: boolean;

const MERCHANT = new Types.ObjectId("507f1f77bcf86cd799439aaa");

/** Synthetic provider that varies output by phone last-digit. */
function syntheticProvider(): ExternalProviderAdapter {
  return {
    name: "bdcourier",
    sourceVersion: "bdcourier-test-v1",
    isConfigured: () => true,
    fetchHistory: async (input) => {
      const digit = Number(input.normalizedPhone.slice(-1));
      const total = 5 + digit * 3; // 5..32
      const cancelled = Math.min(total, Math.floor(digit / 2)); // 0..4
      const delivered = total - cancelled;
      const result: ProviderFetchResult = {
        ok: true,
        total,
        delivered,
        rto: 0,
        cancelled,
        successRate: total > 0 ? delivered / total : null,
        durationMs: 30,
      };
      return result;
    },
  };
}

const cohort = [
  { phone: "8801712345670", label: "strong_delivery_known" },
  { phone: "8801712345671", label: "high_return_known" },
  { phone: "8801712345672", label: "sparse_history_new_buyer" },
  { phone: "8801712345673", label: "shared_phone_family_household" },
  { phone: "8801712345674", label: "reseller_high_volume" },
  { phone: "8801712345675", label: "rural_cod_agent" },
  { phone: "8801712345676", label: "marketplace_business_phone" },
  { phone: "8801712345677", label: "older_dormant_customer" },
  { phone: "8801712345678", label: "newly_active_customer" },
  { phone: "8801712345679", label: "merchant_cancellation_inflated" },
];

beforeAll(async () => {
  await ensureDb();
  originalFlag = env.EXTERNAL_DELIVERY_ENABLED;
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_ENABLED = true;
});
beforeEach(resetDb);
afterAll(async () => {
  (env as unknown as MutableEnv).EXTERNAL_DELIVERY_ENABLED = originalFlag;
  await disconnectDb();
});

/* -------------------------------------------------------------------------- */

describe("validation harness — end-to-end sanity (NOT real validation)", () => {
  it("processes the full template cohort and produces a structured report", async () => {
    const provider = syntheticProvider();
    const outcomes: ValidationLookupOutcome[] = [];

    for (const entry of cohort) {
      const startedAt = Date.now();
      const profile = await getOrFetchExternalProfile({
        merchantId: MERCHANT,
        phone: entry.phone,
        forceFetch: true,
        providers: [provider],
      });
      const totalDurationMs = Date.now() - startedAt;
      if (!profile) {
        outcomes.push({
          cohortLabel: entry.label,
          phoneHash: null,
          resolved: false,
          totalDurationMs,
          failureReason: "master_flag_off",
        });
        continue;
      }
      outcomes.push({
        cohortLabel: entry.label,
        phoneHash: profile.phoneHash,
        resolved: true,
        totalDurationMs,
        source: profile.source,
        profile,
      });
    }

    const summary = summariseValidationRun(outcomes);
    const verdict = computeRolloutReadiness(summary);

    // Cohort accounting.
    expect(summary.cohortSize).toBe(cohort.length);
    expect(summary.resolvedCount).toBe(cohort.length);
    expect(summary.unresolvedCount).toBe(0);
    // Source: forceFetch always lands "providers".
    expect(summary.source.providers).toBe(cohort.length);
    expect(summary.source.cache).toBe(0);
    expect(summary.source.mongo).toBe(0);

    // Provider outcomes — bdcourier configured + ok across the cohort.
    expect(summary.providerOutcomes.bdcourier).toBeDefined();
    expect(summary.providerOutcomes.bdcourier!.configured).toBe(cohort.length);
    expect(summary.providerOutcomes.bdcourier!.ok).toBe(cohort.length);
    expect(summary.providerOutcomes.bdcourier!.failed).toBe(0);

    // Latency stats — synthetic provider returns durationMs:30, plus
    // orchestrator overhead. Verify the stats compute, don't pin
    // specific numbers (they vary by machine).
    expect(summary.latencyMs.count).toBe(cohort.length);
    expect(summary.latencyMs.maxMs).toBeGreaterThan(0);

    // Verdict — synthetic provider always returns ok with reasonable
    // latency, no signals contradict, so verdict should be ready=true.
    expect(verdict.ready).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it("dry-run-style synthetic providers produce a realistic signal distribution", async () => {
    const provider = syntheticProvider();
    let strongCount = 0;
    let elevatedCount = 0;
    let sparseCount = 0;

    for (const entry of cohort) {
      const profile = await getOrFetchExternalProfile({
        merchantId: MERCHANT,
        phone: entry.phone,
        forceFetch: true,
        providers: [provider],
      });
      if (!profile) continue;
      if (profile.signals.strong_delivery_history) strongCount += 1;
      if (profile.signals.elevated_return_pattern) elevatedCount += 1;
      if (profile.signals.sparse_history) sparseCount += 1;
    }

    // The synthetic provider varies total from 5..32 based on the
    // last digit. Some land sparse (total < 5 happens for digit 0:
    // 5+0*3=5, exactly at the threshold), some not.
    expect(strongCount + elevatedCount + sparseCount).toBeGreaterThan(0);
    // No phone should fire BOTH strong AND elevated — that would be
    // a classifier defect.
    for (const entry of cohort) {
      const profile = await getOrFetchExternalProfile({
        merchantId: MERCHANT,
        phone: entry.phone,
        providers: [provider],
      });
      expect(
        profile!.signals.strong_delivery_history &&
          profile!.signals.elevated_return_pattern,
      ).toBe(false);
    }
  });

  it("persists per-merchant rows, isolated from other merchants in the cohort", async () => {
    const provider = syntheticProvider();
    const otherMerchant = new Types.ObjectId("507f1f77bcf86cd799439bbb");
    for (const entry of cohort.slice(0, 3)) {
      await getOrFetchExternalProfile({
        merchantId: MERCHANT,
        phone: entry.phone,
        forceFetch: true,
        providers: [provider],
      });
      await getOrFetchExternalProfile({
        merchantId: otherMerchant,
        phone: entry.phone,
        forceFetch: true,
        providers: [provider],
      });
    }
    // Two merchants × 3 phones = 6 rows.
    const total = await ExternalDeliveryProfile.countDocuments({});
    expect(total).toBe(6);
    // Same phoneHash; different merchantId; no cross-merchant leakage.
    const merchantA = await ExternalDeliveryProfile.find({
      merchantId: MERCHANT,
    }).lean();
    const merchantB = await ExternalDeliveryProfile.find({
      merchantId: otherMerchant,
    }).lean();
    expect(merchantA.length).toBe(3);
    expect(merchantB.length).toBe(3);
    // Each merchant's rows have distinct merchantIds but overlapping
    // phoneHashes — the (merchantId, phoneHash) compound index keeps
    // them isolated.
    const phoneHashesA = new Set(merchantA.map((r) => r.phoneHash));
    const phoneHashesB = new Set(merchantB.map((r) => r.phoneHash));
    for (const h of phoneHashesA) expect(phoneHashesB.has(h)).toBe(true);
  });
});
