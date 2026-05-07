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
async function dropLegacyOrderListingIndex(): Promise<void> {
  const conn = mongoose.connection;
  if (!conn.db) return;
  const col = conn.db.collection("orders");
  try {
    const indexes = await col.indexes();
    // Match by exact key shape, not name — Mongo auto-named the legacy index
    // `merchantId_1_createdAt_-1_order.status_1` but we should not rely on
    // that string in case anyone previously renamed it.
    const legacy = indexes.find((i) => {
      if (!i.key) return false;
      const keys = Object.keys(i.key);
      return (
        keys.length === 3 &&
        i.key.merchantId === 1 &&
        i.key.createdAt === -1 &&
        i.key["order.status"] === 1
      );
    });
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

async function dropLegacyWebhookInboxTtl(): Promise<void> {
  const conn = mongoose.connection;
  if (!conn.db) return;
  const col = conn.db.collection("webhookinboxes");
  try {
    const indexes = await col.indexes();
    const legacy = indexes.find(
      (i) => i.key && Object.keys(i.key).length === 1 && i.key.expiresAt === 1,
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
