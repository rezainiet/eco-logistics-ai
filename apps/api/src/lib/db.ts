import mongoose from "mongoose";
import { env } from "../env.js";

let connected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (connected) return mongoose;
  mongoose.set("strictQuery", true);
  // In production we never let mongoose auto-build indexes on boot — index
  // builds can lock writes on hot collections. Run `npm run db:sync-indexes`
  // out-of-band as part of the deploy. Dev/test still gets autoIndex so a
  // fresh local DB lights up without a manual step.
  if (env.NODE_ENV === "production") {
    mongoose.set("autoIndex", false);
    mongoose.set("autoCreate", false);
  }
  await mongoose.connect(env.MONGODB_URI);
  connected = true;
  console.log(
    `[db] connected to MongoDB (autoIndex=${env.NODE_ENV !== "production"})`,
  );
  await dropLegacyWebhookInboxTtl().catch((err) =>
    console.error("[db] legacy TTL drop failed", (err as Error).message),
  );
  await dropLegacyOrderListingIndex().catch((err) =>
    console.error("[db] legacy order-listing index drop failed", (err as Error).message),
  );
  return mongoose;
}

type KeySpec = ReadonlyArray<readonly [string, 1 | -1]>;

/** The legacy order-listing index, in its exact key order. */
const LEGACY_ORDER_LISTING_KEYS: KeySpec = [
  ["merchantId", 1],
  ["createdAt", -1],
  ["order.status", 1],
];

/**
 * True when an index key document is exactly `spec`: same fields, same
 * directions, same ORDER. Index key order is significant ({a:1,b:1} and
 * {b:1,a:1} are different indexes), so comparing key names and values
 * without order would match unrelated indexes.
 */
export function hasExactKeySpec(key: Record<string, unknown> | undefined, spec: KeySpec): boolean {
  if (!key) return false;
  const entries = Object.entries(key);
  return entries.length === spec.length && entries.every(([k, v], i) => k === spec[i]![0] && v === spec[i]![1]);
}

/**
 * One-shot migration: drop the legacy TTL index `expiresAt_1` on
 * `webhookinboxes`. Older builds defined a Mongo TTL on `expiresAt` that
 * deleted whole rows after 30 days, which silently re-opened the dedup
 * window. Webhook idempotency is now permanent (see `webhookInbox.ts`); the
 * TTL must be removed or Mongo will keep reaping rows we now rely on.
 *
 * Safe to run repeatedly: missing-index errors are swallowed. Runs against
 * the live collection at boot since ops can't easily run targeted migrations
 * across every environment.
 */
/**
 * One-shot migration: drop the legacy `(merchantId, createdAt:-1, order.status)`
 * index on `orders`. Old prefix put `createdAt` before `status`, forcing a
 * date-range scan with status filtered in-memory — the audit's first
 * dashboard scaling cliff. Replaced in-schema by
 * `(merchantId, order.status, createdAt:-1)` which follows ESR (equality,
 * sort, range).
 *
 * Idempotent. Production never auto-builds the new index (autoIndex=false);
 * run `db:sync-indexes` as part of the deploy. This migration only DROPS
 * the old index — it does not create the new one.
 */
export async function dropLegacyOrderListingIndex(): Promise<void> {
  const conn = mongoose.connection;
  if (!conn.db) return;
  const col = conn.db.collection("orders");
  try {
    const indexes = await col.indexes();
    // Match by the exact ORDERED key spec, not by name (Mongo auto-named the
    // legacy index `merchantId_1_createdAt_-1_order.status_1`, but it may
    // have been renamed). Key order matters: the current ESR index has the
    // same three keys in a different order and must never match.
    const legacy = indexes.find((i) => hasExactKeySpec(i.key, LEGACY_ORDER_LISTING_KEYS));
    if (legacy?.name) {
      await col.dropIndex(legacy.name);
      console.log(`[db] dropped legacy index ${legacy.name} on orders`);
    }
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 26 || code === 27) return;
    throw err;
  }
}

export async function dropLegacyWebhookInboxTtl(): Promise<void> {
  const conn = mongoose.connection;
  if (!conn.db) return;
  const col = conn.db.collection("webhookinboxes");
  try {
    const indexes = await col.indexes();
    // Only the TTL variant reaped rows; a plain expiresAt index is harmless.
    const legacy = indexes.find(
      (i) => hasExactKeySpec(i.key, [["expiresAt", 1]]) && i.expireAfterSeconds !== undefined,
    );
    if (legacy?.name) {
      await col.dropIndex(legacy.name);
      console.log(`[db] dropped legacy TTL index ${legacy.name} on webhookinboxes`);
    }
  } catch (err) {
    // 26 = NamespaceNotFound (collection hasn't been created yet — fresh DB).
    // 27 = IndexNotFound (already dropped).
    const code = (err as { code?: number }).code;
    if (code === 26 || code === 27) return;
    throw err;
  }
}

/**
 * Symmetric counterpart to `connectDb`. Closes the mongoose connection
 * cleanly so an in-flight redeploy doesn't leave queued queries to be
 * torn by `process.exit`. Idempotent — calling on an already-closed
 * connection is a no-op.
 */
export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  try {
    await mongoose.disconnect();
  } finally {
    connected = false;
  }
}
