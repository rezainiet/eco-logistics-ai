import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, resetDb } from "./helpers.js";
import {
  __resetBreakersForTests,
  breakerStateOf,
  forceBreakerState,
  snapshotBreakers,
  withBreaker,
} from "../src/lib/couriers/circuit-breaker.js";
import { CourierError } from "../src/lib/couriers/types.js";

/**
 * Circuit-breaker behavior is unit-test-friendly — no DB or HTTP needed.
 * Each spec resets the in-process state via the test helper. We don't
 * call resetDb here because the breaker has nothing to do with Mongo.
 */

beforeEach(() => {
  __resetBreakersForTests();
});

afterAll(disconnectDb);

const KEY = "pathao:acct-1";

function failingFn() {
  return Promise.reject(
    new CourierError("provider_error", "boom", {
      retryable: true,
      provider: "pathao",
    }),
  );
}

function succeedingFn(value = "ok") {
  return Promise.resolve(value);
}

describe("circuit breaker — state machine", () => {
  it("starts closed and lets calls through", async () => {
    const result = await withBreaker(KEY, () => succeedingFn());
    expect(result).toBe("ok");
    expect(breakerStateOf(KEY)).toBe("closed");
  });

  it("opens after `failureThreshold` consecutive failures", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withBreaker(KEY, () => failingFn(), { failureThreshold: 5 }),
      ).rejects.toThrow();
    }
    expect(breakerStateOf(KEY)).toBe("open");
  });

  it("a single success resets the failure counter while closed", async () => {
    await expect(
      withBreaker(KEY, () => failingFn(), { failureThreshold: 3 }),
    ).rejects.toThrow();
    await expect(
      withBreaker(KEY, () => failingFn(), { failureThreshold: 3 }),
    ).rejects.toThrow();
    // One success — counter resets.
    await withBreaker(KEY, () => succeedingFn(), { failureThreshold: 3 });
    // Two more failures should not trip (we're back at 2/3, not 4/3).
    await expect(
      withBreaker(KEY, () => failingFn(), { failureThreshold: 3 }),
    ).rejects.toThrow();
    await expect(
      withBreaker(KEY, () => failingFn(), { failureThreshold: 3 }),
    ).rejects.toThrow();
    expect(breakerStateOf(KEY)).toBe("closed");
  });

  it("when open, fast-fails without invoking fn", async () => {
    forceBreakerState(KEY, "open");
    let invoked = 0;
    await expect(
      withBreaker(KEY, async () => {
        invoked++;
        return "should-not-run";
      }),
    ).rejects.toThrow(/circuit open/);
    expect(invoked).toBe(0);
  });

  it("transitions open → half_open after openDurationMs", async () => {
    // Trip it
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(KEY, () => failingFn(), {
          failureThreshold: 3,
          openDurationMs: 50,
        }),
      ).rejects.toThrow();
    }
    expect(breakerStateOf(KEY)).toBe("open");
    await new Promise((r) => setTimeout(r, 80));
    // Next call attempts in half-open and (succeeds) → closed
    const r = await withBreaker(KEY, () => succeedingFn(), {
      failureThreshold: 3,
      openDurationMs: 50,
    });
    expect(r).toBe("ok");
    expect(breakerStateOf(KEY)).toBe("closed");
  });

  it("half_open probe failure goes straight back to open", async () => {
    forceBreakerState(KEY, "half_open");
    await expect(
      withBreaker(KEY, () => failingFn(), {
        failureThreshold: 5,
        openDurationMs: 50,
      }),
    ).rejects.toThrow();
    expect(breakerStateOf(KEY)).toBe("open");
  });

  it("half_open probe success closes the breaker and clears failure count", async () => {
    forceBreakerState(KEY, "half_open");
    const r = await withBreaker(KEY, () => succeedingFn());
    expect(r).toBe("ok");
    const snap = snapshotBreakers().find((s) => s.key === KEY)!;
    expect(snap.state).toBe("closed");
    expect(snap.failureCount).toBe(0);
  });

  it("half_open: concurrent calls beyond the probe fast-fail", async () => {
    forceBreakerState(KEY, "half_open");
    let probeRunning = false;
    const probe = withBreaker(KEY, async () => {
      probeRunning = true;
      // Hold the probe long enough for the racer call to land
      await new Promise((r) => setTimeout(r, 20));
      probeRunning = false;
      return "probe-ok";
    });
    // Tiny delay to ensure the probe has acquired the slot
    await new Promise((r) => setTimeout(r, 5));
    expect(probeRunning).toBe(true);
    await expect(
      withBreaker(KEY, () => succeedingFn("racer")),
    ).rejects.toThrow(/circuit open/);
    expect(await probe).toBe("probe-ok");
  });
});

describe("circuit breaker — wall-time guarantee", () => {
  it("aborts a hung fn() at totalBudgetMs", async () => {
    const start = Date.now();
    await expect(
      withBreaker(
        KEY,
        // Promise that never resolves, ignoring the signal
        () => new Promise((_resolve) => undefined),
        { totalBudgetMs: 200 },
      ),
    ).rejects.toThrow(/budget/);
    const elapsed = Date.now() - start;
    // 200ms budget plus a generous slack for test runner jitter
    expect(elapsed).toBeLessThan(500);
  });

  it("a hung upstream returns within 5 seconds (default budget)", async () => {
    const start = Date.now();
    await expect(
      withBreaker(KEY, () => new Promise<never>(() => undefined)),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // The headline contract — no request blocks > 5s.
    expect(elapsed).toBeLessThan(5_500);
  });

  it("propagates parent signal — outer abort cascades down", async () => {
    const parent = new AbortController();
    let innerSignalAborted = false;
    setTimeout(() => parent.abort(), 50);
    await expect(
      withBreaker(
        KEY,
        (signal) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => {
              innerSignalAborted = true;
              reject(new Error("inner aborted"));
            });
          }),
        { totalBudgetMs: 5_000, parentSignal: parent.signal },
      ),
    ).rejects.toThrow();
    expect(innerSignalAborted).toBe(true);
  });
});

describe("circuit breaker — per-key isolation", () => {
  it("one key tripping does not affect another key", async () => {
    const keyA = "pathao:acct-A";
    const keyB = "pathao:acct-B";
    for (let i = 0; i < 5; i++) {
      await expect(
        withBreaker(keyA, () => failingFn(), { failureThreshold: 5 }),
      ).rejects.toThrow();
    }
    expect(breakerStateOf(keyA)).toBe("open");
    expect(breakerStateOf(keyB)).toBe("closed");
    // keyB still works fine
    const r = await withBreaker(keyB, () => succeedingFn("B"));
    expect(r).toBe("B");
  });

  it("snapshot lists every key with state + counters", async () => {
    await withBreaker("pathao:1", () => succeedingFn());
    await withBreaker("redx:1", () => succeedingFn());
    await expect(
      withBreaker("steadfast:1", () => failingFn(), { failureThreshold: 1 }),
    ).rejects.toThrow();
    const snap = snapshotBreakers();
    const byKey = new Map(snap.map((s) => [s.key, s]));
    expect(byKey.get("pathao:1")?.state).toBe("closed");
    expect(byKey.get("redx:1")?.state).toBe("closed");
    expect(byKey.get("steadfast:1")?.state).toBe("open");
    expect(byKey.get("steadfast:1")?.totalTrips).toBe(1);
    expect(byKey.get("pathao:1")?.totalSuccesses).toBe(1);
  });
});

describe("circuit breaker — metrics + observability", () => {
  it("counts successes / failures / fast-fails / trips", async () => {
    await withBreaker(KEY, () => succeedingFn());
    await withBreaker(KEY, () => succeedingFn());
    for (let i = 0; i < 3; i++) {
      await expect(
        withBreaker(KEY, () => failingFn(), { failureThreshold: 3 }),
      ).rejects.toThrow();
    }
    // Tripped — next two calls fast-fail
    await expect(withBreaker(KEY, () => succeedingFn())).rejects.toThrow(
      /circuit open/,
    );
    await expect(withBreaker(KEY, () => succeedingFn())).rejects.toThrow(
      /circuit open/,
    );
    const snap = snapshotBreakers().find((s) => s.key === KEY)!;
    expect(snap.totalSuccesses).toBe(2);
    expect(snap.totalFailures).toBe(3);
    expect(snap.totalFastFails).toBe(2);
    expect(snap.totalTrips).toBe(1);
  });
});
