import type { FilterQuery, ProjectionType, Types, UpdateQuery } from "mongoose";
import { Order } from "@ecom/db";

/**
 * Optimistic-concurrency primitives for the Order document.
 *
 * Background — see the production-readiness audit. Every long-running mutation
 * on Order today is a `findOneAndUpdate` with a status- or state-based filter.
 * That guards a SINGLE field but cannot stop two writers whose filters BOTH
 * pass from racing to overwrite each other (e.g. fraud worker rescoring while
 * a merchant restore lands; auto-book finalising while a tracking webhook
 * promotes status). The audit traced two concrete data-loss paths from this:
 *  1. `riskRecompute` clobbering a freshly-restored order's fraud state
 *  2. The booking finalize at orders.ts:640 succeeding even when an unrelated
 *     subdoc (fraud, automation) was mutated mid-flight by a concurrent worker
 *
 * The fix: every mutating query carries a `version: <prev>` clause and the
 * update bumps `version` by one. Two writers reading the same version both
 * race; exactly one wins, the loser sees `null` from `findOneAndUpdate` and
 * either re-reads + retries (read-modify-write paths) or exits cleanly
 * (sweepers / idempotent workers).
 *
 * This module centralises that contract so callers do not need to remember to
 * include the `version` filter or the `$inc`. Misusing the helpers is
 * correspondingly hard: `updateOrderWithVersion` rejects updates that try to
 * mutate `version` directly, and `runWithOptimisticRetry` always loads `version`
 * into the projection it hands to the caller's mutate function.
 */

const MAX_RETRIES_DEFAULT = 5;

export interface VersionedOrderRef {
  _id: Types.ObjectId;
  version: number;
  merchantId?: Types.ObjectId;
}

export interface UpdateWithVersionOptions {
  /**
   * Extra filter clauses (status guards, state checks, lock predicates) AND'd
   * into the version match. The `_id` and `version` keys are reserved — passing
   * them throws so callers can't accidentally bypass the CAS filter.
   */
  extraFilter?: FilterQuery<unknown>;
  /**
   * When true, return the updated document (default false → updateOne-style).
   * Returning the doc is roughly twice the work of a fire-and-forget update,
   * so default off; opt in only when the caller needs the post-state.
   */
  returnDoc?: boolean;
  /** Mongoose projection passed through when `returnDoc` is true. */
  projection?: ProjectionType<unknown>;
}

export interface UpdateWithVersionResult<T = unknown> {
  /** True when the write landed (one row matched). False on version miss. */
  ok: boolean;
  /** New version value when ok; same as input when miss. */
  version: number;
  /** Returned doc when `returnDoc=true` AND ok. Null otherwise. */
  doc: T | null;
}

/**
 * Atomically apply `update` to the order matching `(_id, version)`. Increments
 * `version` on success so the next CAS write will see a new value.
 *
 * Returns `{ ok: false }` on version miss without throwing — callers handle the
 * decision (retry vs skip) explicitly.
 */
export async function updateOrderWithVersion<T = unknown>(
  ref: VersionedOrderRef,
  update: UpdateQuery<unknown>,
  opts: UpdateWithVersionOptions = {},
): Promise<UpdateWithVersionResult<T>> {
  if (opts.extraFilter && ("_id" in opts.extraFilter || "version" in opts.extraFilter)) {
    throw new Error("extraFilter cannot override _id or version");
  }
  // Reject any caller-supplied $inc on `version` — the helper owns that bump.
  // A double-increment would silently desync every other writer's CAS view.
  const inc = (update as { $inc?: Record<string, number> }).$inc;
  if (inc && Object.prototype.hasOwnProperty.call(inc, "version")) {
    throw new Error("update.$inc.version is reserved by updateOrderWithVersion");
  }

  const filter: FilterQuery<unknown> = {
    _id: ref._id,
    version: ref.version,
    ...(ref.merchantId ? { merchantId: ref.merchantId } : {}),
    ...(opts.extraFilter ?? {}),
  };

  const merged: UpdateQuery<unknown> = {
    ...update,
    $inc: { ...(inc ?? {}), version: 1 },
  };

  if (opts.returnDoc) {
    const doc = await Order.findOneAndUpdate(filter, merged, {
      new: true,
      projection: opts.projection,
    }).lean<T>();
    return doc
      ? { ok: true, version: ref.version + 1, doc }
      : { ok: false, version: ref.version, doc: null };
  }

  const res = await Order.updateOne(filter, merged);
  // matchedCount is the right signal — a no-op write (same values) still
  // matches but reports modifiedCount=0; we only care that the CAS held.
  return res.matchedCount === 1
    ? { ok: true, version: ref.version + 1, doc: null }
    : { ok: false, version: ref.version, doc: null };
}

export interface OptimisticRetryOptions {
  /** Bound the loop so a permanently-conflicting writer never spins forever. */
  maxRetries?: number;
  /**
   * Tag used in conflict logs so ops can attribute version-loss spikes to a
   * specific worker / flow.
   */
  context: string;
  /**
   * Optional ms backoff between attempts. Default = 0 (immediate retry).
   * Workers under heavy contention should set ~50ms to let the winner commit
   * and propagate before the next read.
   */
  backoffMs?: number;
}

export type OptimisticLoadFn<T> = () => Promise<(T & VersionedOrderRef) | null>;
export type OptimisticMutateFn<T> = (
  loaded: T & VersionedOrderRef,
) => Promise<{
  /** $set / $unset / $inc payload — passed straight to updateOrderWithVersion. */
  update: UpdateQuery<unknown>;
  /** Optional extra filter (e.g. "still in pending status"). */
  extraFilter?: FilterQuery<unknown>;
  /** Optional projection if the caller wants the post-state doc. */
  returnDoc?: boolean;
  projection?: ProjectionType<unknown>;
} | null>;

export type OptimisticResult<T> =
  | { ok: true; attempts: number; version: number; doc: T | null }
  | { ok: false; reason: "exhausted" | "not_found" | "skipped"; attempts: number };

/**
 * Read-modify-write loop with bounded retries. Each iteration:
 *   1. `load()` reads the order (must include `_id` + `version`).
 *   2. `mutate(loaded)` builds the update payload, or returns null to skip.
 *   3. `updateOrderWithVersion` applies it under CAS.
 *   4. On miss, loop again with the freshly-read state.
 *
 * Returning `null` from `mutate` is the worker's "no-op exit" — used when the
 * loaded state shows the work has already been done by a sibling writer.
 *
 * On miss exhaustion we log a structured event (attributable to `context`)
 * and return `{ ok: false, reason: "exhausted" }`. Callers must decide
 * whether to retry the whole job (BullMQ attempts) or give up; the helper
 * will not throw.
 */
export async function runWithOptimisticRetry<T = unknown>(
  load: OptimisticLoadFn<T>,
  mutate: OptimisticMutateFn<T>,
  opts: OptimisticRetryOptions,
): Promise<OptimisticResult<T>> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES_DEFAULT;
  let attempt = 0;
  let lastVersion = -1;

  while (attempt < maxRetries) {
    attempt += 1;
    const loaded = await load();
    if (!loaded) {
      return { ok: false, reason: "not_found", attempts: attempt };
    }
    lastVersion = loaded.version;
    const plan = await mutate(loaded);
    if (!plan) {
      // Worker decided current state needs no change — clean exit, not a miss.
      return { ok: false, reason: "skipped", attempts: attempt };
    }

    const result = await updateOrderWithVersion<T>(
      { _id: loaded._id, version: loaded.version, merchantId: loaded.merchantId },
      plan.update,
      {
        extraFilter: plan.extraFilter,
        returnDoc: plan.returnDoc,
        projection: plan.projection,
      },
    );

    if (result.ok) {
      return {
        ok: true,
        attempts: attempt,
        version: result.version,
        doc: result.doc,
      };
    }

    if (opts.backoffMs && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, opts.backoffMs));
    }
  }

  console.warn(
    JSON.stringify({
      evt: "order.optimistic_conflict_exhausted",
      context: opts.context,
      attempts: attempt,
      lastVersion,
    }),
  );
  return { ok: false, reason: "exhausted", attempts: attempt };
}
