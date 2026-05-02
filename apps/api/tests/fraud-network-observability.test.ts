import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { FraudSignal } from "@ecom/db";
import {
  contributeOutcome,
  hashPhoneForNetwork,
  lookupNetworkRisk,
} from "../src/lib/fraud-network.js";
import {
  __resetNetworkCounters,
  snapshotNetworkCounters,
  recordNetworkOutcome,
} from "../src/lib/observability/fraud-network.js";
import { ensureDb, disconnectDb, resetDb } from "./helpers.js";

const phoneHash = hashPhoneForNetwork("+8801711111111")!;
const addressHash = "addr-decay-test";

async function seedNetworkSignal(opts: {
  rtoCount: number;
  deliveredCount: number;
  merchantIds: Types.ObjectId[];
  lastSeenAt?: Date;
}) {
  await FraudSignal.create({
    phoneHash,
    addressHash,
    rtoCount: opts.rtoCount,
    deliveredCount: opts.deliveredCount,
    cancelledCount: 0,
    merchantIds: opts.merchantIds,
    firstSeenAt: opts.lastSeenAt ?? new Date(),
    lastSeenAt: opts.lastSeenAt ?? new Date(),
  });
}

describe("recordNetworkOutcome counters", () => {
  beforeEach(() => __resetNetworkCounters());
  afterEach(() => vi.restoreAllMocks());

  it("counts hits and computes hitRate correctly", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    recordNetworkOutcome({ outcome: "lookup_hit_applied", bonus: 14 });
    recordNetworkOutcome({ outcome: "lookup_hit_applied", bonus: 8 });
    recordNetworkOutcome({ outcome: "lookup_miss" });
    recordNetworkOutcome({ outcome: "lookup_miss" });
    const snap = snapshotNetworkCounters();
    expect(snap.hitsApplied).toBe(2);
    expect(snap.misses).toBe(2);
    // 2 applied / 4 meaningful = 0.5
    expect(snap.hitRate).toBeCloseTo(0.5, 5);
  });

  it("estimatedPreventedRto increments only on flagged 'estimatedPrevented' calls", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    recordNetworkOutcome({ outcome: "lookup_hit_applied", bonus: 14, estimatedPrevented: true });
    recordNetworkOutcome({ outcome: "lookup_hit_applied", bonus: 5, estimatedPrevented: false });
    expect(snapshotNetworkCounters().estimatedPreventedRto).toBe(1);
  });

  it("contribute_failed routes to console.error and increments its bucket", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    recordNetworkOutcome({ outcome: "contribute_failed", error: "mongo timeout" });
    expect(err).toHaveBeenCalledTimes(1);
    expect(snapshotNetworkCounters().contributesFailed).toBe(1);
  });
});

describe("lookupNetworkRisk — flag + decay + warming", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
    __resetNetworkCounters();
    delete process.env.FRAUD_NETWORK_ENABLED;
    delete process.env.FRAUD_NETWORK_DECAY_DAYS;
    delete process.env.FRAUD_NETWORK_WARMING_FLOOR;
  });
  afterAll(disconnectDb);

  it("returns EMPTY and bumps lookup_disabled when flag is off", async () => {
    // Re-import after env mutation so the fresh schema sees the flag.
    process.env.FRAUD_NETWORK_ENABLED = "0";
    vi.resetModules();
    const m = await import("../src/lib/fraud-network.js");
    const obs = await import("../src/lib/observability/fraud-network.js");
    obs.__resetNetworkCounters();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await seedNetworkSignal({
      rtoCount: 5,
      deliveredCount: 1,
      merchantIds: [new Types.ObjectId(), new Types.ObjectId()],
    });

    const r = await m.lookupNetworkRisk({ phoneHash, addressHash, merchantId: new Types.ObjectId() });
    expect(r.bonus).toBe(0);
    expect(obs.snapshotNetworkCounters().disabledLookups).toBe(1);
  });

  it("treats stale signals (lastSeenAt > DECAY_DAYS) as EMPTY", async () => {
    process.env.FRAUD_NETWORK_DECAY_DAYS = "30";
    vi.resetModules();
    const m = await import("../src/lib/fraud-network.js");
    const obs = await import("../src/lib/observability/fraud-network.js");
    obs.__resetNetworkCounters();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    await seedNetworkSignal({
      rtoCount: 5,
      deliveredCount: 1,
      merchantIds: [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()],
      lastSeenAt: sixtyDaysAgo,
    });

    const r = await m.lookupNetworkRisk({ phoneHash, addressHash, merchantId: new Types.ObjectId() });
    expect(r.bonus).toBe(0);
    expect(obs.snapshotNetworkCounters().staleLookups).toBe(1);
  });

  it("damps the bonus when the network is below the warming floor", async () => {
    // Default WARMING_FLOOR is 50; we have only 1 row.
    vi.resetModules();
    const m = await import("../src/lib/fraud-network.js");
    const obs = await import("../src/lib/observability/fraud-network.js");
    obs.__resetNetworkCounters();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await seedNetworkSignal({
      rtoCount: 4,
      deliveredCount: 1,
      merchantIds: [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()],
    });

    const r = await m.lookupNetworkRisk({ phoneHash, addressHash, merchantId: new Types.ObjectId() });
    // Without the damper, bonus would be Math.min(20, round(0.8*25)) + 8 = 28→cap25.
    // Damped → ~12-13. Just assert it's strictly less than 25 and > 0.
    expect(r.bonus).toBeGreaterThan(0);
    expect(r.bonus).toBeLessThan(25);
    expect(obs.snapshotNetworkCounters().warmingUpLookups).toBe(1);
  });

  it("applies full bonus once the warming floor is crossed", async () => {
    process.env.FRAUD_NETWORK_WARMING_FLOOR = "0"; // disable damper
    vi.resetModules();
    const m = await import("../src/lib/fraud-network.js");
    const obs = await import("../src/lib/observability/fraud-network.js");
    obs.__resetNetworkCounters();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await seedNetworkSignal({
      rtoCount: 5,
      deliveredCount: 1,
      merchantIds: [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()],
    });

    const r = await m.lookupNetworkRisk({ phoneHash, addressHash, merchantId: new Types.ObjectId() });
    expect(r.bonus).toBe(25); // hits the cap
    expect(obs.snapshotNetworkCounters().hitsApplied).toBe(1);
  });
});

describe("contributeOutcome — flag + counters", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
    __resetNetworkCounters();
    delete process.env.FRAUD_NETWORK_ENABLED;
  });

  it("skips writes and bumps contribute_disabled when flag is off", async () => {
    process.env.FRAUD_NETWORK_ENABLED = "0";
    vi.resetModules();
    const m = await import("../src/lib/fraud-network.js");
    const obs = await import("../src/lib/observability/fraud-network.js");
    obs.__resetNetworkCounters();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await m.contributeOutcome({
      merchantId: new Types.ObjectId(),
      phoneHash,
      addressHash,
      outcome: "rto",
    });
    expect(await FraudSignal.countDocuments()).toBe(0);
    expect(obs.snapshotNetworkCounters().contributesDisabled).toBe(1);
  });

  it("bumps contribute_skipped when both hashes are absent", async () => {
    vi.resetModules();
    const m = await import("../src/lib/fraud-network.js");
    const obs = await import("../src/lib/observability/fraud-network.js");
    obs.__resetNetworkCounters();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await m.contributeOutcome({
      merchantId: new Types.ObjectId(),
      phoneHash: null,
      addressHash: null,
      outcome: "rto",
    });
    expect(obs.snapshotNetworkCounters().contributesSkipped).toBe(1);
  });
});
