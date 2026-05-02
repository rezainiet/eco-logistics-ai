import { createHash } from "node:crypto";
import { Types } from "mongoose";
import {
  FraudPrediction,
  MAX_TRACKING_EVENTS,
  Merchant,
  MerchantStats,
  Order,
  type Order as OrderDoc,
} from "@ecom/db";
import { adapterFor, CourierError, hasCourierAdapter } from "../lib/couriers/index.js";
import type { CourierName, TrackingInfo } from "../lib/couriers/types.js";
import { invalidate } from "../lib/cache.js";
import { enqueueRescore } from "../workers/riskRecompute.js";
import { contributeOutcome, hashPhoneForNetwork } from "../lib/fraud-network.js";
import { recordCourierOutcome } from "../lib/courier-intelligence.js";

/**
 * Tracking lifecycle mapper — courier event → order.status. Only terminal
 * transitions (delivered / rto) and the shipped→in_transit step mutate order
 * status; the rest live purely on the tracking timeline so merchants still
 * see granular provider events.
 */
const STATUS_MAP: Partial<Record<TrackingInfo["normalizedStatus"], string>> = {
  picked_up: "in_transit",
  in_transit: "in_transit",
  out_for_delivery: "in_transit",
  delivered: "delivered",
  rto: "rto",
  failed: "rto",
};

const ACTIVE_STATUSES = ["shipped", "in_transit"] as const;

export interface TrackingEventInput {
  /** Provider-supplied event time. Falls back to `new Date()` if absent. */
  at?: Date;
  /**
   * Free-form provider status string (e.g. "in_review", "out_for_delivery").
   * Optional — adapters that emit only `description` (e.g. polling responses
   * that don't carry a per-event status enum) are normalised inside
   * `applyTrackingEvents` via `e.providerStatus || e.description || "unknown"`.
   */
  providerStatus?: string;
  description?: string;
  location?: string;
}

export interface ApplyTrackingOptions {
  /**
   * Where the events came from. `webhook` stamps `logistics.lastWebhookAt`
   * so the polling worker can skip recently-pushed orders; `poll` stamps
   * `logistics.lastPolledAt`. Default: `poll` for backwards compatibility
   * with the existing `syncOrderTracking` path.
   */
  source?: "poll" | "webhook";
  /** Provider-supplied actual delivery time, used when status === delivered. */
  deliveredAt?: Date;
}

export interface ApplyTrackingResult {
  newEvents: number;
  statusTransition?: { from: string; to: string };
}

/**
 * Persist a batch of tracking events for one order. Atomic: dedupes against
 * existing `logistics.trackingEvents`, pushes only new rows, and flips
 * `order.status` on terminal transitions (delivered/rto). Used by both the
 * polling worker (after a courier API call) and the inbound webhook
 * handlers (with the single event from the push payload).
 *
 * Always returns — never throws into the caller. Returns `newEvents: 0`
 * if every event was a duplicate, which both surfaces use to make
 * idempotency decisions.
 */
export async function applyTrackingEvents(
  order: Pick<OrderDoc, "_id" | "merchantId" | "order" | "logistics"> & {
    _id: Types.ObjectId;
  },
  normalizedStatus: TrackingInfo["normalizedStatus"],
  events: TrackingEventInput[],
  options: ApplyTrackingOptions = {},
): Promise<ApplyTrackingResult> {
  const source = options.source ?? "poll";
  const existing = new Set(
    (order.logistics?.trackingEvents ?? []).map((e) => e.dedupeKey),
  );
  const newEvents: TrackingEventDoc[] = [];
  for (const e of events) {
    const providerStatus = e.providerStatus || e.description || "unknown";
    const at = e.at instanceof Date ? e.at : new Date(e.at ?? Date.now());
    const dedupeKey = dedupeKeyFor(providerStatus, e.description, e.location);
    if (existing.has(dedupeKey)) continue;
    existing.add(dedupeKey);
    newEvents.push({
      at,
      providerStatus,
      normalizedStatus,
      description: e.description,
      location: e.location,
      dedupeKey,
    });
  }

  const prevStatus = order.order.status;
  const nextStatus = STATUS_MAP[normalizedStatus] ?? prevStatus;

  const set: Record<string, unknown> = {};
  if (source === "webhook") {
    set["logistics.lastWebhookAt"] = new Date();
  } else {
    set["logistics.lastPolledAt"] = new Date();
    set["logistics.pollError"] = null;
    set["logistics.pollErrorCount"] = 0;
  }
  if (nextStatus !== prevStatus) set["order.status"] = nextStatus;
  if (normalizedStatus === "delivered" && !order.logistics?.deliveredAt) {
    set["logistics.deliveredAt"] = options.deliveredAt ?? new Date();
    set["logistics.actualDelivery"] = options.deliveredAt ?? new Date();
  }
  if (normalizedStatus === "rto" && !order.logistics?.returnedAt) {
    set["logistics.returnedAt"] = new Date();
  }

  const update: Record<string, unknown> = { $set: set };
  const newKeys = newEvents.map((e) => e.dedupeKey);
  if (newEvents.length > 0) {
    // `$slice: -MAX_TRACKING_EVENTS` keeps only the most recent N entries.
    // Without it, the array grows linearly with delivery age and a single
    // long-lived shipment can drift the document past Mongo's 16 MB limit.
    update.$push = {
      "logistics.trackingEvents": {
        $each: newEvents,
        $slice: -MAX_TRACKING_EVENTS,
      },
    };
  }

  // Two write-time guards:
  //  1. Status guard — refuse to mutate when the order has already moved
  //     to a status outside the active set (out-of-order events from a
  //     stale snapshot can not clobber a fresher status).
  //  2. Dedupe guard — refuse to push if any of the new dedupe keys are
  //     already present in `logistics.trackingEvents`. Closes the race
  //     where two concurrent writers each computed "no existing" before
  //     either had landed. If this guard fails the update is a no-op and
  //     `newEvents` will be reported back, but the actual append did not
  //     happen — caller must accept this as duplicate-suppressed.
  const guardStatus = new Set<string>([...ACTIVE_STATUSES, prevStatus]);
  const filter: Record<string, unknown> = {
    _id: order._id,
    "order.status": { $in: [...guardStatus] },
  };
  if (newKeys.length > 0) {
    filter["logistics.trackingEvents.dedupeKey"] = { $nin: newKeys };
  }
  const writeResult = await Order.updateOne(filter, update);
  // If the dedupe guard refused the write but the status guard would have
  // matched, treat as zero-new-events instead of declaring success.
  const persisted = writeResult.modifiedCount > 0 || writeResult.matchedCount > 0;
  const effectivelyAppended = persisted ? newEvents.length : 0;

  if (nextStatus !== prevStatus) {
    await MerchantStats.updateOne(
      { merchantId: order.merchantId },
      {
        $inc: { [prevStatus]: -1, [nextStatus]: 1 },
        $set: { updatedAt: new Date() },
      },
    );
    await invalidate(`dashboard:${order.merchantId.toString()}`);

    if (nextStatus === "rto") {
      const full = await Order.findById(order._id).select("customer.phone").lean();
      const phone = (full as { customer?: { phone?: string } } | null)?.customer?.phone;
      if (phone) {
        void enqueueRescore({
          merchantId: String(order.merchantId),
          phone,
          trigger: "order.rto",
          triggerOrderId: String(order._id),
        });
      }
    }

    // Cross-merchant fraud network — record the terminal outcome on the
    // global FraudSignal collection so other merchants benefit from this
    // merchant's experience. Privacy-safe (only hashes are persisted).
    // Best-effort, never blocks the tracking pipeline.
    if (nextStatus === "delivered" || nextStatus === "rto" || nextStatus === "cancelled") {
      // Feedback loop: stamp the outcome on the prediction row so the monthly
      // tuner can compute per-signal precision/recall. Idempotent via the
      // `orderId` unique index — if the row already has an outcome, a later
      // status flip wins (e.g. delivered → rto correction).
      void FraudPrediction.updateOne(
        { orderId: order._id },
        { $set: { outcome: nextStatus, outcomeAt: new Date() } },
      ).catch((err) =>
        console.error(
          "[fraud-prediction] outcome update failed",
          (err as Error).message,
        ),
      );

      const full = await Order.findById(order._id)
        .select("customer.phone customer.address customer.district createdAt logistics.shippedAt logistics.deliveredAt")
        .lean();
      const phone = (full as { customer?: { phone?: string } } | null)?.customer?.phone;
      const address = (full as { customer?: { address?: string } } | null)?.customer?.address;
      const district = (full as { customer?: { district?: string } } | null)?.customer?.district;
      const phoneHash = hashPhoneForNetwork(phone);
      // The order document already carries an addressHash via the create
      // path, but legacy rows may not — recompute defensively from raw.
      let addressHash: string | null = null;
      if (address && district) {
        const { hashAddress } = await import("./risk.js");
        addressHash = hashAddress(address, district);
      }
      void contributeOutcome({
        merchantId: order.merchantId,
        phoneHash,
        addressHash,
        outcome: nextStatus as "delivered" | "rto" | "cancelled",
      }).catch((err) =>
        console.error("[fraud-network] contribute failed", (err as Error).message),
      );

      // Courier-intelligence: record per-(merchant, courier, district)
      // performance for the auto-selection engine. Best-effort, never blocks.
      const orderCourier = (order as { logistics?: { courier?: string } }).logistics?.courier;
      if (orderCourier && district) {
        // For delivered orders, derive delivery hours from order createdAt to now.
        // (More precise sources would be courier shippedAt; createdAt is the
        // simplest defensible fallback.)
        // Prefer shippedAt → deliveredAt (true transit time). Fall back to
        // shippedAt → now, then createdAt → now. Floor at 0.1h to keep $inc
        // healthy when the row gets seeded with synthetic data.
        const fullOrder = full as {
          createdAt?: Date;
          logistics?: { shippedAt?: Date; deliveredAt?: Date };
        } | null;
        const shippedAt = fullOrder?.logistics?.shippedAt;
        const deliveredAtTs = fullOrder?.logistics?.deliveredAt ?? new Date();
        const baseStart = shippedAt ?? fullOrder?.createdAt;
        const deliveryHours =
          nextStatus === "delivered" && baseStart
            ? Math.max(
                0.1,
                (new Date(deliveredAtTs).getTime() - new Date(baseStart).getTime()) /
                  3_600_000,
              )
            : undefined;
        void recordCourierOutcome({
          merchantId: order.merchantId,
          courier: orderCourier,
          district,
          outcome: nextStatus as "delivered" | "rto" | "cancelled",
          deliveryHours,
        }).catch((err) =>
          console.error("[courier-intel] record failed", (err as Error).message),
        );
      }
    }
  }

  return {
    newEvents: effectivelyAppended,
    ...(persisted && nextStatus !== prevStatus
      ? { statusTransition: { from: prevStatus, to: nextStatus } }
      : {}),
  };
}

export interface TrackingEventDoc {
  at: Date;
  providerStatus: string;
  normalizedStatus: TrackingInfo["normalizedStatus"];
  description?: string;
  location?: string;
  dedupeKey: string;
}

/**
 * Content-addressed dedupe key. Couriers like Steadfast only return a single
 * "latest update" with the current server time as `last_updated`, so polling
 * twice would otherwise mint two rows with the same semantic content but
 * different `at`. Hashing the textual content (providerStatus + description +
 * location) keeps repeated polls idempotent while preserving distinct events
 * that share a status but differ in location or description (e.g. multiple
 * "In Transit" hops).
 */
function dedupeKeyFor(providerStatus: string, description?: string, location?: string): string {
  return createHash("sha1")
    .update(`${providerStatus}|${description ?? ""}|${location ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}

export interface SyncResult {
  orderId: string;
  skipped?: "no_tracking" | "no_adapter" | "no_courier_config";
  newEvents?: number;
  statusTransition?: { from: string; to: string };
  error?: string;
}

/**
 * Pure-ish core: given an Order document, poll its courier adapter and persist
 * any new timeline events atomically. Terminal transitions update merchant
 * stats and invalidate the dashboard cache.
 */
export async function syncOrderTracking(
  order: Pick<OrderDoc, "_id" | "merchantId" | "order" | "logistics"> & {
    _id: Types.ObjectId;
  },
): Promise<SyncResult> {
  const id = String(order._id);
  const courier = order.logistics?.courier as CourierName | undefined;
  const trackingNumber = order.logistics?.trackingNumber;
  if (!courier || !trackingNumber) {
    return { orderId: id, skipped: "no_tracking" };
  }
  if (!hasCourierAdapter(courier)) {
    return { orderId: id, skipped: "no_adapter" };
  }

  const merchant = await Merchant.findById(order.merchantId).select("couriers").lean();
  const config = merchant?.couriers.find((c) => c.name === courier);
  if (!config) return { orderId: id, skipped: "no_courier_config" };

  let info: TrackingInfo;
  try {
    info = await adapterFor({
      name: courier,
      accountId: config.accountId,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret ?? undefined,
      baseUrl: config.baseUrl ?? undefined,
    }).getTracking(trackingNumber);
  } catch (err) {
    const message = err instanceof CourierError ? err.message : (err as Error).message;
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "logistics.lastPolledAt": new Date(),
          "logistics.pollError": message.slice(0, 500),
        },
        $inc: { "logistics.pollErrorCount": 1 },
      },
    );
    return { orderId: id, error: message };
  }

  const result = await applyTrackingEvents(
    order,
    info.normalizedStatus,
    info.events,
    { source: "poll", deliveredAt: info.deliveredAt },
  );
  return {
    orderId: id,
    newEvents: result.newEvents,
    ...(result.statusTransition ? { statusTransition: result.statusTransition } : {}),
  };
}

/**
 * Find up to `batchSize` active shipments that haven't been polled recently
 * (null lastPolledAt first, oldest poll next). Kept separate from the worker
 * so it can be exercised from a cron endpoint in the future.
 */
export const WEBHOOK_FRESH_MS = 30 * 60 * 1000;

export async function pickOrdersToSync(batchSize: number, maxAgeMs: number) {
  const pollCutoff = new Date(Date.now() - maxAgeMs);
  const webhookCutoff = new Date(Date.now() - WEBHOOK_FRESH_MS);
  return Order.find({
    "order.status": { $in: [...ACTIVE_STATUSES] },
    "logistics.trackingNumber": { $exists: true, $ne: "" },
    // Need polling either because we have not polled recently OR have never polled.
    $or: [
      { "logistics.lastPolledAt": { $exists: false } },
      { "logistics.lastPolledAt": null },
      { "logistics.lastPolledAt": { $lt: pollCutoff } },
    ],
    // …AND we have not received a webhook within the freshness window.
    // Orders pushed via webhook in the last 30min are skipped to avoid
    // wasted courier API calls — the webhook already brought us up-to-date.
    $and: [
      {
        $or: [
          { "logistics.lastWebhookAt": { $exists: false } },
          { "logistics.lastWebhookAt": null },
          { "logistics.lastWebhookAt": { $lt: webhookCutoff } },
        ],
      },
    ],
  })
    .sort({ "logistics.lastPolledAt": 1, _id: 1 })
    .limit(batchSize)
    .lean();
}

export const __TEST = { dedupeKeyFor, STATUS_MAP, ACTIVE_STATUSES };
