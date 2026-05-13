import type { Types } from "mongoose";
import { getRedis } from "../redis.js";

/**
 * Short-lived "this order was deleted upstream" tombstone.
 *
 * Why this exists: when a Woo merchant trashes an order, Woo fires
 * `order.deleted` to our webhook router. Our control-plane intercept
 * (apps/api/src/server/webhooks/integrations.ts) flips the matching
 * Order row to `cancelled`. But if Woo had ALSO fired `order.created`
 * for the same order moments before — and our BullMQ inbox worker is
 * still processing that delivery when `order.deleted` arrives —
 * applying them in reverse order would resurrect the deleted order
 * (create lands AFTER delete, so the row gets recreated with status
 * `pending`).
 *
 * The fix is a tombstone: when `order.deleted` arrives we record
 * (integrationId, externalId) in Redis with a 24h TTL. The webhook
 * ingest path checks the tombstone before calling
 * `ingestNormalizedOrder`; on a match it short-circuits to a
 * succeeded-but-skipped state with `reason=tombstoned_after_delete`.
 *
 * 24h is plenty: BullMQ retries top out at minutes, courier-handoff
 * latencies at hours; a day's window covers every realistic race
 * without keeping memory permanently. Redis TTL handles cleanup so
 * we never have to schedule a sweep.
 *
 * The tombstone IS scoped per integration so the same numeric
 * `externalId` from two different merchants' Woo stores doesn't
 * accidentally suppress each other.
 *
 * If Redis is unavailable the helpers no-op: `markOrderDeleted`
 * returns silently, `wasOrderDeleted` returns false. That degrades
 * to today's pre-tombstone behaviour rather than failing the
 * webhook — losing the tombstone for a few minutes during a Redis
 * outage is far less bad than holding up order processing entirely.
 */

const TTL_SECONDS = 24 * 60 * 60;

function tombstoneKey(
  integrationId: Types.ObjectId | string,
  externalId: string,
): string {
  return `order:tombstone:${String(integrationId)}:${externalId}`;
}

/**
 * Record an upstream-deleted order. Called from the `order.deleted`
 * intercept after the in-DB cancel. Safe to call multiple times;
 * later calls just refresh the TTL.
 */
export async function markOrderDeleted(args: {
  integrationId: Types.ObjectId | string;
  externalId: string;
}): Promise<void> {
  let redis;
  try {
    redis = getRedis();
  } catch {
    return;
  }
  try {
    await redis.set(
      tombstoneKey(args.integrationId, args.externalId),
      "1",
      "EX",
      TTL_SECONDS,
    );
  } catch (err) {
    // Don't propagate — see the no-op-on-failure rationale in the
    // module header. We do log so an operator can tell whether a
    // race-with-create regression was caused by missed tombstones.
    console.warn("[order-tombstone] write_failed", {
      integrationId: String(args.integrationId),
      externalId: args.externalId,
      err: (err as Error).message.slice(0, 120),
    });
  }
}

/**
 * Look up whether a tombstone exists for this (integration, externalId)
 * pair. Returns false on Redis errors so an outage doesn't accidentally
 * block legitimate order ingestion.
 */
export async function wasOrderDeleted(args: {
  integrationId: Types.ObjectId | string;
  externalId: string;
}): Promise<boolean> {
  let redis;
  try {
    redis = getRedis();
  } catch {
    return false;
  }
  try {
    const hit = await redis.get(
      tombstoneKey(args.integrationId, args.externalId),
    );
    return hit !== null;
  } catch {
    return false;
  }
}
