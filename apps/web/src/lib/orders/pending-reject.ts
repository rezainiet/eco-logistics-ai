/**
 * Bulk "Reject" with an undo window — the lifecycle, framework-free.
 *
 * Reject is terminal on the server (there is no un-reject for a bulk
 * reject), so the UI holds the mutation for a short window during which the
 * merchant can Undo. That window used to live in the orders-page component:
 * leaving the page cleared the timer, so the reject silently never happened
 * while the merchant had been told "Rejecting in 6s" (audit F-06).
 *
 * The lifecycle now lives in one app-level store, independent of which page
 * is mounted:
 *
 *   idle ──request──▶ pending ──(window expires)──▶ committing ──▶ idle
 *                      │  ▲                              │
 *                      │  └── undo() → idle (no request) └─ outcome: done | failed
 *                      └── request() while busy → "busy" (never a second reject)
 *
 * - Undo is only possible in `pending`. Once `committing` starts the
 *   request is on the wire and `undo()` returns false — the UI must not
 *   offer it any more.
 * - Navigation / unmounting a page does not touch the store; the timer and
 *   the executor (a vanilla tRPC call captured at request time) keep going.
 * - The one thing that can still stop it is closing the tab; the dashboard
 *   banner warns (beforeunload) while a reject is pending or committing.
 */

export type RejectPhase = "idle" | "pending" | "committing";

export interface PendingRejectState {
  phase: RejectPhase;
  /** Orders being rejected (empty when idle). */
  ids: readonly string[];
  /** Epoch ms when the undo window closes (pending only). */
  deadline: number | null;
}

export interface BulkRejectResult {
  rejected: string[];
  alreadyRejected: string[];
  tooLate: string[];
  notFound: string[];
}

export type RejectExecutor = (ids: string[]) => Promise<BulkRejectResult>;

export type RejectOutcome =
  | { kind: "undone"; ids: readonly string[] }
  | { kind: "done"; ids: readonly string[]; result: BulkRejectResult }
  | { kind: "failed"; ids: readonly string[]; error: unknown };

export type RequestResult = "started" | "busy" | "empty";

interface Timers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const REJECT_UNDO_WINDOW_MS = 6_000;
/** Server-side cap per bulk call (orders.bulkRejectOrders). */
export const REJECT_BATCH_LIMIT = 200;

const IDLE: PendingRejectState = Object.freeze({ phase: "idle", ids: Object.freeze([]), deadline: null });

export function createPendingRejectStore(opts: { windowMs?: number; timers?: Partial<Timers> } = {}) {
  const windowMs = opts.windowMs ?? REJECT_UNDO_WINDOW_MS;
  const timers: Timers = {
    now: opts.timers?.now ?? (() => Date.now()),
    setTimeout: opts.timers?.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
    clearTimeout: opts.timers?.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>)),
  };

  let state: PendingRejectState = IDLE;
  let timer: unknown = null;
  let executor: RejectExecutor | null = null;
  const listeners = new Set<() => void>();
  const outcomeListeners = new Set<(o: RejectOutcome) => void>();

  const set = (next: PendingRejectState) => {
    state = next;
    for (const l of listeners) l();
  };
  const emit = (o: RejectOutcome) => {
    for (const l of outcomeListeners) l(o);
  };

  async function commit() {
    if (state.phase !== "pending") return;
    timer = null;
    const ids = [...state.ids];
    const run = executor;
    executor = null;
    set({ phase: "committing", ids, deadline: null });
    try {
      if (!run) throw new Error("No reject executor");
      const result = await run(ids);
      set(IDLE);
      emit({ kind: "done", ids, result });
    } catch (error) {
      set(IDLE);
      emit({ kind: "failed", ids, error });
    }
  }

  return {
    getState: (): PendingRejectState => state,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Outcomes (done / failed / undone) — the dashboard banner toasts them. */
    onOutcome(listener: (o: RejectOutcome) => void): () => void {
      outcomeListeners.add(listener);
      return () => void outcomeListeners.delete(listener);
    },

    /**
     * Start the undo window. Only one reject can be in flight: while one is
     * pending or committing, further requests are refused ("busy") rather
     * than queued or merged, so a double click can never send two rejects.
     */
    request(ids: readonly string[], execute: RejectExecutor): RequestResult {
      if (state.phase !== "idle") return "busy";
      const unique = [...new Set(ids)].slice(0, REJECT_BATCH_LIMIT);
      if (unique.length === 0) return "empty";
      executor = execute;
      set({ phase: "pending", ids: unique, deadline: timers.now() + windowMs });
      timer = timers.setTimeout(() => void commit(), windowMs);
      return "started";
    },

    /** Cancel during the undo window. False once the request has been sent (or when idle). */
    undo(): boolean {
      if (state.phase !== "pending") return false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      executor = null;
      const ids = state.ids;
      set(IDLE);
      emit({ kind: "undone", ids });
      return true;
    },

    /** Seconds left in the undo window, rounded up (0 when not pending). */
    secondsLeft(at: number = timers.now()): number {
      if (state.phase !== "pending" || state.deadline === null) return 0;
      return Math.max(0, Math.ceil((state.deadline - at) / 1000));
    },
  };
}

export type PendingRejectStore = ReturnType<typeof createPendingRejectStore>;

/** The app-wide instance. Module scope = survives client-side navigation. */
export const pendingReject: PendingRejectStore = createPendingRejectStore();
