import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Order, WebhookInbox, WEBHOOK_PAYLOAD_REAP_DAYS } from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { customApiAdapter } from "../src/lib/integrations/customApi.js";
import { processWebhookOnce } from "../src/server/ingest.js";
import { reapWebhookPayloads } from "../src/workers/webhookRetry.js";

/**
 * Webhook idempotency durability — INFINITE window.
 *
 * The audit caught a 30-day TTL on `WebhookInbox.expiresAt` that quietly
 * re-opened the dedup window: any platform that retries past 30 days
 * (Shopify will replay indefinitely) could create a duplicate order. The
 * fix removed the row-deletion TTL and replaced it with a payload-only
 * reap that keeps the slim dedup keys forever. These tests pin both halves
 * of that contract: replays past the reap window are still deduped, AND
 * the second-line Order.externalId guard catches the case where someone
 * deleted the inbox row entirely.
 */

const SECONDS_PER_DAY = 86_400;

function buildWebhookArgs(merchantId: Types.ObjectId, integrationId: Types.ObjectId, externalId: string) {
  const normalized = customApiAdapter.normalizeWebhookPayload("order.created", {
    externalId,
    orderNumber: `EXT-${externalId}`,
    customer: {
      name: "Sajib",
      phone: "+8801711111111",
      address: "House 12, Road 4",
      district: "Dhaka",
    },
    items: [{ name: "Shirt", quantity: 1, price: 500 }],
    cod: 500,
    total: 500,
  });
  return {
    merchantId,
    integrationId,
    provider: "custom_api",
    topic: "order.created",
    externalId,
    rawPayload: { externalId, hello: "world" },
    payloadBytes: 100,
    normalized,
    source: "custom_api" as const,
  };
}

describe("webhook idempotency durability", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("schema: there is NO row-deletion TTL on WebhookInbox", async () => {
    // Belt-and-braces against a future migration that re-adds the TTL.
    // We tolerate the legacy `expiresAt_1` index existing under a different
    // name in test DBs, but no index may have `expireAfterSeconds` set.
    const indexes = await WebhookInbox.collection.indexes();
    const ttlIndexes = indexes.filter(
      (i) => typeof i.expireAfterSeconds === "number",
    );
    expect(ttlIndexes).toEqual([]);
  });

  it("dedup keys live forever — replay AFTER payload reap returns duplicate with the same orderId", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const integration = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(integration.id);
    const args = buildWebhookArgs(m._id as Types.ObjectId, integrationId, "ext-replay-1");

    // First delivery — creates the order.
    const first = await processWebhookOnce(args);
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBeFalsy();
    const originalOrderId = first.orderId;
    expect(originalOrderId).toBeTruthy();

    // Simulate the row aging past the payload-reap deadline. We backdate
    // `payloadReapAt` to 1 day ago — the sweeper should pick it up, NULL
    // the payload, and leave the dedup key intact.
    const inboxBefore = await WebhookInbox.findOne({
      merchantId: m._id,
      provider: "custom_api",
      externalId: "ext-replay-1",
    }).lean();
    expect(inboxBefore?.payload).toBeTruthy(); // payload still present pre-reap
    expect(inboxBefore?.payloadReaped).toBe(false);

    await WebhookInbox.updateOne(
      { _id: inboxBefore!._id },
      { $set: { payloadReapAt: new Date(Date.now() - SECONDS_PER_DAY * 1000) } },
    );

    const reapedCount = await reapWebhookPayloads();
    expect(reapedCount).toBe(1);

    const inboxAfter = await WebhookInbox.findOne({
      merchantId: m._id,
      provider: "custom_api",
      externalId: "ext-replay-1",
    }).lean();
    expect(inboxAfter?.payload).toBeNull();
    expect(inboxAfter?.payloadBytes).toBe(0);
    expect(inboxAfter?.payloadReaped).toBe(true);
    // The dedup key + the resolved order link are what we ACTUALLY need.
    expect(String(inboxAfter?.resolvedOrderId)).toBe(originalOrderId);

    // Replay AFTER reap. Conceptually this is Shopify redelivering an
    // event a year later. The dedup key is still there → duplicate=true,
    // and the orderId surfaces unchanged.
    const replay = await processWebhookOnce(args);
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.orderId).toBe(originalOrderId);

    // Ground truth: there is still exactly one Order, no duplicate.
    const orderCount = await Order.countDocuments({ merchantId: m._id });
    expect(orderCount).toBe(1);
  });

  it("dead-lettered rows are preserved indefinitely — neither row nor payload is reaped", async () => {
    // Operational trust pin: a dead-lettered row is the canonical
    // forensic artefact for an unrecoverable webhook. If the reaper
    // ever clears its payload (or someone slips a row-deletion TTL
    // back in), ops loses the only debug surface for "why did this
    // event never produce an order?" Treat dead-lettered as
    // sacrosanct — both the dedup keys AND the payload stay forever.
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const integration = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(integration.id);

    const dead = await WebhookInbox.create({
      merchantId: m._id,
      integrationId,
      provider: "custom_api",
      topic: "order.created",
      externalId: "ext-dead-1",
      payload: { externalId: "ext-dead-1", important: "forensic" },
      payloadBytes: 220,
      status: "failed",
      attempts: 5,
      deadLetteredAt: new Date(Date.now() - 200 * SECONDS_PER_DAY * 1000),
      // payloadReapAt 100 days in the past — well past the 90-day
      // window. The reaper still must NOT touch this row because its
      // status is "failed", not "succeeded".
      payloadReapAt: new Date(Date.now() - 100 * SECONDS_PER_DAY * 1000),
    });

    const reaped = await reapWebhookPayloads();
    expect(reaped).toBe(0);

    const after = await WebhookInbox.findById(dead._id).lean();
    expect(after).toBeTruthy();
    expect(after?.payload).toBeTruthy();
    expect(after?.payloadBytes).toBe(220);
    expect(after?.payloadReaped).toBe(false);
    expect(after?.deadLetteredAt).toBeTruthy();
    expect(after?.status).toBe("failed");
  });

  it("payload reap leaves non-succeeded rows alone (failed rows still need their payload to retry)", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const integration = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(integration.id);

    // Insert a "failed" row directly so we don't have to mock the ingest
    // pipeline failing. The reap must NOT touch this row — the retry
    // worker still needs the payload to replay.
    const failed = await WebhookInbox.create({
      merchantId: m._id,
      integrationId,
      provider: "custom_api",
      topic: "order.created",
      externalId: "ext-failed-1",
      payload: { externalId: "ext-failed-1", important: "bytes" },
      payloadBytes: 100,
      status: "failed",
      attempts: 1,
      payloadReapAt: new Date(Date.now() - SECONDS_PER_DAY * 1000),
    });

    const reaped = await reapWebhookPayloads();
    expect(reaped).toBe(0);

    const after = await WebhookInbox.findById(failed._id).lean();
    expect(after?.payload).toBeTruthy();
    expect(after?.payloadReaped).toBe(false);
  });

  it("Order.externalId is the second-line guard — even if the inbox row is deleted, no duplicate Order is created", async () => {
    // Defense-in-depth. The inbox dedup is the primary guard, but ops
    // could manually drop a row, or a future migration could prune. The
    // Order schema's sparse-unique index on (merchantId, source.externalId)
    // is supposed to catch any duplicate that slips through.
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const integration = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(integration.id);
    const args = buildWebhookArgs(m._id as Types.ObjectId, integrationId, "ext-fallback-1");

    const first = await processWebhookOnce(args);
    expect(first.ok).toBe(true);
    const originalOrderId = first.orderId!;

    // Manually purge the inbox row — simulating a worst-case scenario
    // where someone dropped the collection or migrated wrong. The Order
    // still exists with source.externalId = ext-fallback-1.
    await WebhookInbox.deleteMany({ merchantId: m._id });
    expect(await WebhookInbox.countDocuments({ merchantId: m._id })).toBe(0);

    // Replay. The first inbox guard misses (row is gone), so we proceed
    // to ingestion. Inside ingestNormalizedOrder the Order.findOne on
    // source.externalId catches the duplicate and returns
    // duplicate:true with the SAME order id.
    const replay = await processWebhookOnce(args);
    expect(replay.ok).toBe(true);
    // A new inbox row was created (the dedup table was empty), but no new
    // Order was created — the Order index caught the duplicate.
    expect(await WebhookInbox.countDocuments({ merchantId: m._id })).toBe(1);
    expect(await Order.countDocuments({ merchantId: m._id })).toBe(1);
    // The replay either reports duplicate:true (inbox-second-pass) or
    // returns the same orderId via the ingest layer's duplicate short-
    // circuit. Either way the order id is unchanged.
    const allOrders = await Order.find({ merchantId: m._id }).lean();
    expect(String(allOrders[0]!._id)).toBe(originalOrderId);
  });

  it("default payloadReapAt is at least 90 days out", async () => {
    // Sanity check: the reap window must be far enough out that legitimate
    // retry traffic (failed → retry → succeed within the 1h backoff cap)
    // never trips the reap mid-flight.
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const integration = await caller.integrations.connect({ provider: "custom_api" });
    const integrationId = new Types.ObjectId(integration.id);
    const args = buildWebhookArgs(m._id as Types.ObjectId, integrationId, "ext-default-reap");

    await processWebhookOnce(args);
    const row = await WebhookInbox.findOne({
      merchantId: m._id,
      externalId: "ext-default-reap",
    }).lean();
    const reapAt = row?.payloadReapAt?.getTime() ?? 0;
    const minimumReapAt = Date.now() + (WEBHOOK_PAYLOAD_REAP_DAYS - 1) * SECONDS_PER_DAY * 1000;
    expect(reapAt).toBeGreaterThan(minimumReapAt);
    expect(WEBHOOK_PAYLOAD_REAP_DAYS).toBeGreaterThanOrEqual(90);
  });
});
