import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { Merchant, MerchantStats, Order, type Order as OrderDoc } from "@ecom/db";
import { adapterFor, CourierError, hasCourierAdapter } from "../lib/couriers/index.js";
import type { CourierName, TrackingInfo } from "../lib/couriers/types.js";
import { invalidate } from "../lib/cache.js";
import { enqueueRescore } from "../workers/riskRecompute.js";

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

export interface TrackingEventDoc {
  at: Date;
  providerStatus: string;
  normalizedStatus: TrackingInfo["normalizedStatus"];
  description?: string;
  location?: string;
  dedupeKey: string;
}

function dedupeKeyFor(at: Date, providerStatus: string): string {
  return createHash("sha1")
    .update(`${at.toISOString()}|${providerStatus}`)
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

  const existing = new Set((order.logistics?.trackingEvents ?? []).map((e) => e.dedupeKey));
  const newEventsRaw = info.events.map((e) => {
    const providerStatus = e.description || info.providerStatus;
    const at = e.at instanceof Date ? e.at : new Date(e.at);
    return {
      at,
      providerStatus,
      normalizedStatus: info.normalizedStatus,
      description: e.description,
      location: e.location,
      dedupeKey: dedupeKeyFor(at, providerStatus),
    };
  });
  const newEvents = newEventsRaw.filter((e) => !existing.has(e.dedupeKey));

  const prevStatus = order.order.status;
  const nextStatus = STATUS_MAP[info.normalizedStatus] ?? prevStatus;

  const set: Record<string, unknown> = {
    "logistics.lastPolledAt": new Date(),
    "logistics.pollError": null,
    "logistics.pollErrorCount": 0,
  };
  if (nextStatus !== prevStatus) set["order.status"] = nextStatus;
  if (info.normalizedStatus === "delivered" && !order.logistics?.deliveredAt) {
    set["logistics.deliveredAt"] = info.deliveredAt ?? new Date();
    set["logistics.actualDelivery"] = info.deliveredAt ?? new Date();
  }
  if (info.normalizedStatus === "rto" && !order.logistics?.returnedAt) {
    set["logistics.returnedAt"] = new Date();
  }

  const update: Record<string, unknown> = { $set: set };
  if (newEvents.length > 0) {
    update.$push = { "logistics.trackingEvents": { $each: newEvents } };
  }

  const guardStatus = new Set<string>([...ACTIVE_STATUSES, prevStatus]);
  await Order.updateOne(
    { _id: order._id, "order.status": { $in: [...guardStatus] } },
    update,
  );

  if (nextStatus !== prevStatus) {
    await MerchantStats.updateOne(
      { merchantId: order.merchantId },
      {
        $inc: { [prevStatus]: -1, [nextStatus]: 1 },
        $set: { updatedAt: new Date() },
      },
    );
    await invalidate(`dashboard:${order.merchantId.toString()}`);

    // Tracker flipped us into a terminal failure (RTO / failed → rto). Refresh
    // every open order from the same phone so the "prior_returns" signal
    // reflects reality immediately instead of waiting for the merchant to
    // manually rescore.
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
  }

  return {
    orderId: id,
    newEvents: newEvents.length,
    ...(nextStatus !== prevStatus
      ? { statusTransition: { from: prevStatus, to: nextStatus } }
      : {}),
  };
}

/**
 * Find up to `batchSize` active shipments that haven't been polled recently
 * (null lastPolledAt first, oldest poll next). Kept separate from the worker
 * so it can be exercised from a cron endpoint in the future.
 */
export async function pickOrdersToSync(batchSize: number, maxAgeMs: number) {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return Order.find({
    "order.status": { $in: [...ACTIVE_STATUSES] },
    "logistics.trackingNumber": { $exists: true, $ne: "" },
    $or: [
      { "logistics.lastPolledAt": { $exists: false } },
      { "logistics.lastPolledAt": null },
      { "logistics.lastPolledAt": { $lt: cutoff } },
    ],
  })
    .sort({ "logistics.lastPolledAt": 1, _id: 1 })
    .limit(batchSize)
    .lean();
}

export const __TEST = { dedupeKeyFor, STATUS_MAP, ACTIVE_STATUSES };
