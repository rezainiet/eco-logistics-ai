import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BulkRejectResult, type RejectOutcome, createPendingRejectStore } from "./pending-reject";

const WINDOW = 6_000;
const ok = (ids: string[]): BulkRejectResult => ({ rejected: ids, alreadyRejected: [], tooLate: [], notFound: [] });

function setup() {
  const store = createPendingRejectStore({ windowMs: WINDOW });
  const outcomes: RejectOutcome[] = [];
  store.onOutcome((o) => outcomes.push(o));
  const execute = vi.fn(async (ids: string[]) => ok(ids));
  return { store, outcomes, execute };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bulk reject undo window (audit F-06)", () => {
  it("reject: starts a pending window without sending anything", () => {
    const { store, execute } = setup();
    expect(store.request(["a", "b"], execute)).toBe("started");
    expect(store.getState()).toMatchObject({ phase: "pending", ids: ["a", "b"] });
    expect(store.secondsLeft()).toBe(6);
    expect(execute).not.toHaveBeenCalled();
  });

  it("timer expiration: sends the reject once, then reports the outcome and goes idle", async () => {
    const { store, execute, outcomes } = setup();
    store.request(["a"], execute);
    await vi.advanceTimersByTimeAsync(WINDOW - 1);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(["a"]);
    expect(store.getState().phase).toBe("idle");
    expect(outcomes).toEqual([{ kind: "done", ids: ["a"], result: ok(["a"]) }]);
  });

  it("undo during the window: nothing is sent, ever", async () => {
    const { store, execute, outcomes } = setup();
    store.request(["a"], execute);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.undo()).toBe(true);
    await vi.advanceTimersByTimeAsync(WINDOW * 2);
    expect(execute).not.toHaveBeenCalled();
    expect(store.getState().phase).toBe("idle");
    expect(outcomes).toEqual([{ kind: "undone", ids: ["a"] }]);
  });

  it("navigation / component unmount during the window does not cancel the reject", async () => {
    const { store, execute } = setup();
    // The orders page subscribes, requests, then unmounts (unsubscribes) —
    // exactly what leaving the page does.
    const unsubscribe = store.subscribe(() => {});
    store.request(["a", "b"], execute);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(["a", "b"]);
  });

  it("already finalized: once the request is on the wire, Undo is refused", async () => {
    const { store, outcomes } = setup();
    let resolve: (r: BulkRejectResult) => void = () => {};
    const slow = vi.fn(() => new Promise<BulkRejectResult>((r) => (resolve = r)));
    store.request(["a"], slow);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(store.getState().phase).toBe("committing");
    expect(store.secondsLeft()).toBe(0);
    expect(store.undo()).toBe(false);
    resolve(ok(["a"]));
    await vi.runAllTimersAsync();
    expect(store.getState().phase).toBe("idle");
    expect(store.undo()).toBe(false);
    expect(outcomes.map((o) => o.kind)).toEqual(["done"]);
  });

  it("duplicate reject: a second request while one is pending or committing is refused, not queued", async () => {
    const { store, execute } = setup();
    expect(store.request(["a"], execute)).toBe("started");
    expect(store.request(["a"], execute)).toBe("busy");
    expect(store.request(["b"], execute)).toBe("busy");
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(execute).toHaveBeenCalledTimes(1);
    // After it finished, a new reject can start.
    expect(store.request(["b"], execute)).toBe("started");
  });

  it("duplicate undo: the second one is a no-op", () => {
    const { store, execute, outcomes } = setup();
    store.request(["a"], execute);
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(false);
    expect(outcomes).toHaveLength(1);
  });

  it("a failed reject is reported (not swallowed) and the store is usable again", async () => {
    const { store, outcomes } = setup();
    const failing = vi.fn(async () => {
      throw new Error("network");
    });
    store.request(["a"], failing);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(outcomes[0]).toMatchObject({ kind: "failed", ids: ["a"] });
    expect(store.getState().phase).toBe("idle");
  });

  it("de-duplicates ids, caps the batch and refuses an empty selection", () => {
    const { store, execute } = setup();
    expect(store.request([], execute)).toBe("empty");
    const many = Array.from({ length: 250 }, (_, i) => `o${i}`);
    store.request([...many, "o1"], execute);
    expect(store.getState().ids).toHaveLength(200);
  });

  it("the countdown rounds up and never goes negative", async () => {
    const { store, execute } = setup();
    store.request(["a"], execute);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(store.secondsLeft()).toBe(1);
    expect(store.secondsLeft(Date.now() + 10_000)).toBe(0);
  });
});
