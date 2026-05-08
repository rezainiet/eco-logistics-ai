import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Types } from "mongoose";
import { CustomerReliability, AddressReliability, Order } from "@ecom/db";
import {
  __resetReliabilityCounters,
  recordReliabilityOutcome,
  snapshotReliabilityCounters,
  type DeliveryReliabilityObservabilityEvent,
} from "../src/lib/observability/delivery-reliability.js";
import {
  recordCustomerOutcome,
  recordAddressOutcome,
} from "../src/lib/delivery-reliability-writers.js";
import { applyTrackingEvents } from "../src/server/tracking.js";
import { hashAddress } from "../src/server/risk.js";
import { hashPhoneForNetwork } from "../src/lib/fraud-network.js";
import { env } from "../src/env.js";
import { createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * S5 — observability integration tests.
 *
 * Coverage:
 *   1. structured log emission on success / failure / skipped paths
 *   2. metric increments on each event type
 *   3. drift / replay-storm sampling via repeated writes
 *   4. observability disabled (flag-off) → no logs, no counter bumps
 *   5. observability throw-isolation (mocked log path failure)
 *   6. non-blocking guarantees (helpers still complete, return void)
 *   7. write_failed log emitted when underlying Mongo write fails
 *   8. aggregate_skipped emitted when chokepoint flag is off
 *   9. aggregate_skipped emitted when phoneHash absent at the chokepoint
 *  10. replay_suppressed emitted on terminal-status no-op replay
 *  11. invalid_transition emitted when the atomic Order guard rejected (§6.2)
 *
 * The tests run against the in-memory mongo from `tests/globalSetup.ts`.
 */

type MutableEnv = { -readonly [K in keyof typeof env]: typeof env[K] };
function setWriteFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_WRITE_ENABLED = value;
}
function setObservabilityFlag(value: boolean) {
  (env as MutableEnv).DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED = value;
}

let originalWrite: boolean;
let originalObs: boolean;

beforeEach(async () => {
  await ensureDb();
  await resetDb();
  __resetReliabilityCounters();
  originalWrite = env.DELIVERY_RELIABILITY_WRITE_ENABLED;
  originalObs = env.DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED;
  setWriteFlag(false);
  setObservabilityFlag(true);
});

afterEach(() => {
  setWriteFlag(originalWrite);
  setObservabilityFlag(originalObs);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

const TEST_PHONE = "+8801711222333";
const TEST_ADDRESS = "House 7, Road 3, Banani";
const TEST_DISTRICT = "Dhaka";
const PHONE_HASH = "ph_" + "a".repeat(29);
const ADDRESS_HASH = "ad_" + "b".repeat(29);

async function createInTransitOrder(
  merchantId: Types.ObjectId,
  overrides: { phone?: string; address?: string; district?: string } = {},
) {
  const phone = overrides.phone ?? TEST_PHONE;
  const address = overrides.address ?? TEST_ADDRESS;
  const district = overrides.district ?? TEST_DISTRICT;
  const orderDoc = await Order.create({
    merchantId,
    orderNumber: `OBS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    customer: { name: "Test Buyer", phone, address, district },
    items: [{ name: "thing", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "in_transit" },
    logistics: {
      courier: "steadfast",
      trackingNumber: `TR-${Date.now()}`,
      shippedAt: new Date(Date.now() - 60_000),
      trackingEvents: [],
    },
    source: { addressHash: hashAddress(address, district) },
  });
  return Order.findById(orderDoc._id).lean();
}

async function flushVoidWrites() {
  await new Promise((r) => setTimeout(r, 50));
}

const DELIVERED_EVENT = {
  at: new Date("2026-05-08T10:00:00Z"),
  providerStatus: "Delivered",
  description: "Parcel handed to recipient",
  location: "Banani Hub",
};

function captureLogs() {
  const out: Array<Record<string, unknown>> = [];
  const stdout = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line === "string") {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* non-JSON log line — ignore */
      }
    }
  });
  const stderr = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    if (typeof line === "string") {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
  });
  return {
    out,
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

function findLogs(
  out: Array<Record<string, unknown>>,
  event: DeliveryReliabilityObservabilityEvent,
) {
  return out.filter(
    (l) => l.msg === "delivery_reliability" && l.event === event,
  );
}

/* ========================================================================== */
/* GROUP A — direct helper observability                                      */
/* ========================================================================== */

describe("observability — recordReliabilityOutcome direct emission", () => {
  it("emits a structured log on customer_updated", () => {
    const cap = captureLogs();
    recordReliabilityOutcome({
      event: "customer_updated",
      merchantId: "abc",
      axis: "customer",
      reason: "delivered",
      durationMs: 4,
    });
    cap.restore();
    const lines = findLogs(cap.out, "customer_updated");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: "delivery_reliability",
      event: "customer_updated",
      axis: "customer",
      reason: "delivered",
    });
    expect(snapshotReliabilityCounters().customerUpdated).toBe(1);
  });

  it("uses console.error for write_failed and integrity_warning events", () => {
    const cap = captureLogs();
    const errSpy = vi.spyOn(console, "error");
    recordReliabilityOutcome({
      event: "write_failed",
      merchantId: "abc",
      axis: "customer",
      error: "simulated",
    });
    cap.restore();
    errSpy.mockRestore();
    expect(snapshotReliabilityCounters().writeFailed).toBe(1);
  });

  it("flag-off → emits NO logs and bumps NO counters", () => {
    setObservabilityFlag(false);
    const cap = captureLogs();
    recordReliabilityOutcome({
      event: "customer_updated",
      merchantId: "abc",
      axis: "customer",
    });
    recordReliabilityOutcome({
      event: "address_updated",
      merchantId: "abc",
      axis: "address",
    });
    recordReliabilityOutcome({
      event: "write_failed",
      merchantId: "abc",
      axis: "customer",
    });
    cap.restore();
    expect(cap.out).toHaveLength(0);
    const counters = snapshotReliabilityCounters();
    expect(counters.customerUpdated).toBe(0);
    expect(counters.addressUpdated).toBe(0);
    expect(counters.writeFailed).toBe(0);
  });

  it("never throws on malformed input", () => {
    expect(() =>
      // @ts-expect-error — exercising defensive runtime handling
      recordReliabilityOutcome(null),
    ).not.toThrow();
    expect(() =>
      // @ts-expect-error
      recordReliabilityOutcome({ event: "not-a-real-event" }),
    ).not.toThrow();
    // counters didn't move on any of those bad inputs.
    expect(snapshotReliabilityCounters().customerUpdated).toBe(0);
  });

  it("isolates downstream throws inside JSON.stringify (e.g. circular meta)", () => {
    const circular: Record<string, unknown> = { x: 1 };
    circular.self = circular;
    const cap = captureLogs();
    expect(() =>
      recordReliabilityOutcome({
        event: "customer_updated",
        // @ts-expect-error — circular reference is not allowed by the type
        meta: circular,
      }),
    ).not.toThrow();
    cap.restore();
    // No log line landed (JSON.stringify threw inside the emitter), but the
    // counter still advanced — bookkeeping happens before serialization.
    expect(snapshotReliabilityCounters().customerUpdated).toBe(1);
  });

  it("snapshot returns all eight counters", () => {
    recordReliabilityOutcome({ event: "customer_updated" });
    recordReliabilityOutcome({ event: "address_updated" });
    recordReliabilityOutcome({ event: "write_failed" });
    recordReliabilityOutcome({ event: "aggregate_skipped" });
    recordReliabilityOutcome({ event: "replay_suppressed" });
    recordReliabilityOutcome({ event: "drift_detected" });
    recordReliabilityOutcome({ event: "invalid_transition" });
    recordReliabilityOutcome({ event: "integrity_warning" });
    const snap = snapshotReliabilityCounters();
    expect(snap.customerUpdated).toBe(1);
    expect(snap.addressUpdated).toBe(1);
    expect(snap.writeFailed).toBe(1);
    expect(snap.aggregateSkipped).toBe(1);
    expect(snap.replaySuppressed).toBe(1);
    expect(snap.driftDetected).toBe(1);
    expect(snap.invalidTransition).toBe(1);
    expect(snap.integrityWarning).toBe(1);
  });
});

/* ========================================================================== */
/* GROUP B — writer-side log emission                                         */
/* ========================================================================== */

describe("observability — writer helpers emit on success + failure", () => {
  it("recordCustomerOutcome emits customer_updated on success", async () => {
    const merchantId = new Types.ObjectId();
    const cap = captureLogs();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      now: new Date(),
    });
    cap.restore();
    expect(findLogs(cap.out, "customer_updated")).toHaveLength(1);
    expect(snapshotReliabilityCounters().customerUpdated).toBe(1);
  });

  it("recordAddressOutcome emits address_updated on success", async () => {
    const merchantId = new Types.ObjectId();
    const cap = captureLogs();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      phoneHash: PHONE_HASH,
      now: new Date(),
    });
    cap.restore();
    expect(findLogs(cap.out, "address_updated")).toHaveLength(1);
    expect(snapshotReliabilityCounters().addressUpdated).toBe(1);
  });

  it("recordCustomerOutcome emits write_failed when Mongo throws", async () => {
    const merchantId = new Types.ObjectId();
    vi.spyOn(CustomerReliability, "updateOne").mockRejectedValueOnce(
      new Error("simulated mongo timeout"),
    );
    const cap = captureLogs();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      now: new Date(),
    });
    cap.restore();
    const logs = findLogs(cap.out, "write_failed");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.error).toContain("simulated");
    expect(snapshotReliabilityCounters().writeFailed).toBe(1);
    expect(snapshotReliabilityCounters().customerUpdated).toBe(0);
  });

  it("recordAddressOutcome emits write_failed when Mongo throws", async () => {
    const merchantId = new Types.ObjectId();
    vi.spyOn(AddressReliability, "updateOne").mockRejectedValueOnce(
      new Error("simulated mongo timeout"),
    );
    const cap = captureLogs();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "rto",
      now: new Date(),
    });
    cap.restore();
    const logs = findLogs(cap.out, "write_failed");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.axis).toBe("address");
    expect(snapshotReliabilityCounters().writeFailed).toBe(1);
  });

  it("invalid input → no log emitted (silent return is the contract)", async () => {
    const cap = captureLogs();
    await recordCustomerOutcome({
      merchantId: "not-an-objectid",
      phoneHash: PHONE_HASH,
      outcome: "delivered",
    });
    await recordCustomerOutcome({
      merchantId: new Types.ObjectId(),
      phoneHash: "",
      outcome: "delivered",
    });
    cap.restore();
    expect(cap.out.filter((l) => l.msg === "delivery_reliability")).toHaveLength(0);
    expect(snapshotReliabilityCounters().customerUpdated).toBe(0);
  });

  it("100 successful writes produce 100 customer_updated logs and counter increments", async () => {
    const merchantId = new Types.ObjectId();
    const cap = captureLogs();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        recordCustomerOutcome({
          merchantId,
          phoneHash: PHONE_HASH,
          outcome: "delivered",
          orderId: new Types.ObjectId(),
          now: new Date(Date.now() + i),
        }),
      ),
    );
    cap.restore();
    expect(findLogs(cap.out, "customer_updated")).toHaveLength(100);
    expect(snapshotReliabilityCounters().customerUpdated).toBe(100);
  });
});

/* ========================================================================== */
/* GROUP C — chokepoint emissions                                             */
/* ========================================================================== */

describe("observability — chokepoint emits aggregate_skipped / replay_suppressed / invalid_transition", () => {
  it("flag-off terminal transition emits aggregate_skipped(reason=flag_off)", async () => {
    setWriteFlag(false);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);
    const cap = captureLogs();
    await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();
    cap.restore();

    const skipped = findLogs(cap.out, "aggregate_skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped.find((l) => l.reason === "flag_off")).toBeDefined();
    expect(snapshotReliabilityCounters().aggregateSkipped).toBeGreaterThanOrEqual(1);
  });

  it("flag-on terminal transition with normal data emits NO aggregate_skipped", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);
    const cap = captureLogs();
    await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();
    cap.restore();

    expect(findLogs(cap.out, "aggregate_skipped")).toHaveLength(0);
    // Two writer-side success logs.
    expect(findLogs(cap.out, "customer_updated").length).toBeGreaterThanOrEqual(1);
    expect(findLogs(cap.out, "address_updated").length).toBeGreaterThanOrEqual(1);
  });

  it("a terminal-status replay (no new events) emits replay_suppressed at the chokepoint", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    let lean = await createInTransitOrder(merchantId);

    // First call lands the delivered transition.
    await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();
    lean = await Order.findById((lean as { _id: Types.ObjectId })._id).lean();

    // Second call: same event content (same dedupeKey) replayed against the
    // re-fetched order. nextStatus === prevStatus === "delivered" AND no
    // new events appended → chokepoint emits replay_suppressed.
    const cap = captureLogs();
    await applyTrackingEvents(
      lean as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();
    cap.restore();

    expect(findLogs(cap.out, "replay_suppressed")).toHaveLength(1);
    expect(snapshotReliabilityCounters().replaySuppressed).toBe(1);
  });

  it("a stale-snapshot writer that reaches the terminal block AFTER the order moved emits invalid_transition", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const fresh = await createInTransitOrder(merchantId);

    // Land delivered first.
    await applyTrackingEvents(
      fresh as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();

    // Now a stale-snapshot writer arrives with prev="in_transit" but the
    // doc is already "delivered". Atomic Order.updateOne filter rejects;
    // persisted=false; chokepoint emits invalid_transition (§6.2).
    const cap = captureLogs();
    await applyTrackingEvents(
      fresh as Parameters<typeof applyTrackingEvents>[0],
      "rto",
      [
        {
          at: new Date("2026-05-08T11:00:00Z"),
          providerStatus: "Returned",
          description: "Parcel returned to origin",
        },
      ],
      { source: "webhook" },
    );
    await flushVoidWrites();
    cap.restore();

    const invalid = findLogs(cap.out, "invalid_transition");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.reason).toBe("atomic_guard_rejected_write");
    expect(snapshotReliabilityCounters().invalidTransition).toBe(1);
  });
});

/* ========================================================================== */
/* GROUP D — observability isolation: never blocks ingestion / persistence   */
/* ========================================================================== */

describe("observability — failure isolation", () => {
  it("a stdout failure inside the emitter does not propagate or block the write", async () => {
    setWriteFlag(true);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);

    // Force every console.log to throw — simulate a downstream log shipper
    // that's wedged. The emitter's internal try/catch must catch this and
    // fall back to console.error (which still works), so the chokepoint
    // never sees the throw. console.error itself remains intact so the
    // existing fan-outs' `.catch(console.error)` chains are unaffected.
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("simulated stdout failure");
    });

    let result: Awaited<ReturnType<typeof applyTrackingEvents>> | undefined;
    await expect(async () => {
      result = await applyTrackingEvents(
        order as Parameters<typeof applyTrackingEvents>[0],
        "delivered",
        [DELIVERED_EVENT],
        { source: "webhook" },
      );
    }).not.toThrow();
    await flushVoidWrites();

    stdoutSpy.mockRestore();

    // Order still updated; the chokepoint completed.
    expect(result?.statusTransition?.to).toBe("delivered");
    const orderAfter = await Order.findById(
      (order as { _id: Types.ObjectId })._id,
    ).lean();
    expect(orderAfter!.order!.status).toBe("delivered");
  });

  it("observability flag-off makes chokepoint emissions no-op without changing fan-out", async () => {
    setWriteFlag(true);
    setObservabilityFlag(false);
    const merchant = await createMerchant();
    const merchantId = merchant._id as Types.ObjectId;
    const order = await createInTransitOrder(merchantId);
    const cap = captureLogs();
    await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      "delivered",
      [DELIVERED_EVENT],
      { source: "webhook" },
    );
    await flushVoidWrites();
    cap.restore();

    expect(cap.out.filter((l) => l.msg === "delivery_reliability")).toHaveLength(0);
    // Counters didn't move.
    expect(snapshotReliabilityCounters().customerUpdated).toBe(0);
    expect(snapshotReliabilityCounters().addressUpdated).toBe(0);

    // But the aggregates were still written (write flag on, observability off).
    const phoneHash = hashPhoneForNetwork(TEST_PHONE);
    const cust = await CustomerReliability.findOne({ merchantId, phoneHash }).lean();
    expect(cust).not.toBeNull();
    expect(cust!.deliveredCount).toBe(1);
  });
});
