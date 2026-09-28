import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { dropLegacyOrderListingIndex, dropLegacyWebhookInboxTtl } from "../src/lib/db.js";
import { disconnectDb, ensureDb } from "./helpers.js";

/**
 * Boot-time legacy index drops must match the exact ORDERED key spec of the
 * legacy index. The old matcher compared key names/values but not their
 * order, so it also matched — and dropped on every API boot — the current
 * ESR index `(merchantId, order.status, createdAt:-1)`.
 */

const ESR = { merchantId: 1, "order.status": 1, createdAt: -1 } as const;
const LEGACY = { merchantId: 1, createdAt: -1, "order.status": 1 } as const;

function db() {
  return mongoose.connection.db!;
}
async function indexNames(collection: string): Promise<string[]> {
  return (await db().collection(collection).indexes()).map((i) => i.name!).sort();
}

beforeAll(async () => {
  await ensureDb();
  // Tests autoIndex; let every model finish its background index build so
  // it cannot race the collections these tests drop and recreate.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});
afterAll(disconnectDb);
beforeEach(async () => {
  for (const c of ["orders", "webhookinboxes"]) {
    await db().collection(c).drop().catch(() => undefined);
  }
});

describe("dropLegacyOrderListingIndex", () => {
  it("keeps the current ESR index when it is the only (merchantId, status, createdAt) index", async () => {
    await db().collection("orders").createIndex(ESR);
    const before = await indexNames("orders");
    await dropLegacyOrderListingIndex();
    expect(await indexNames("orders")).toEqual(before);
    expect(before).toContain("merchantId_1_order.status_1_createdAt_-1");
  });

  it("drops only the legacy-ordered index when both exist", async () => {
    await db().collection("orders").createIndex(ESR);
    await db().collection("orders").createIndex(LEGACY);
    await dropLegacyOrderListingIndex();
    const after = await indexNames("orders");
    expect(after).toContain("merchantId_1_order.status_1_createdAt_-1");
    expect(after).not.toContain("merchantId_1_createdAt_-1_order.status_1");
  });

  it("matches the legacy index by its key spec even under a custom name", async () => {
    await db().collection("orders").createIndex(LEGACY, { name: "renamed_legacy" });
    await dropLegacyOrderListingIndex();
    expect(await indexNames("orders")).not.toContain("renamed_legacy");
  });

  it("ignores indexes that only share a prefix or differ in direction", async () => {
    const col = db().collection("orders");
    await col.createIndex({ merchantId: 1, createdAt: -1 });
    await col.createIndex({ merchantId: 1, createdAt: 1, "order.status": 1 });
    await col.createIndex({ merchantId: 1, createdAt: -1, "order.status": 1, _id: 1 });
    const before = await indexNames("orders");
    await dropLegacyOrderListingIndex();
    expect(await indexNames("orders")).toEqual(before);
  });

  it("is idempotent and tolerates a missing collection", async () => {
    await dropLegacyOrderListingIndex(); // collection does not exist
    await db().collection("orders").createIndex(LEGACY);
    await dropLegacyOrderListingIndex();
    await dropLegacyOrderListingIndex();
    expect(await indexNames("orders")).toEqual(["_id_"]);
  });
});

describe("dropLegacyWebhookInboxTtl", () => {
  it("drops the legacy TTL index on expiresAt", async () => {
    await db().collection("webhookinboxes").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 2_592_000 });
    await dropLegacyWebhookInboxTtl();
    expect(await indexNames("webhookinboxes")).toEqual(["_id_"]);
  });

  it("keeps a plain (non-TTL) expiresAt index — only the TTL reaped rows", async () => {
    await db().collection("webhookinboxes").createIndex({ expiresAt: 1 }, { name: "plain_expiresAt" });
    await dropLegacyWebhookInboxTtl();
    expect(await indexNames("webhookinboxes")).toContain("plain_expiresAt");
  });
});
