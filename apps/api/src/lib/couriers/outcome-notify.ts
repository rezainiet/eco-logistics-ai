import type { Types } from "mongoose";
import { Order } from "@ecom/db";
import { dispatchNotification } from "../notifications.js";

/**
 * Merchant inbox notifications for courier-driven outcomes, called from the
 * tracking chokepoint (`applyTrackingEvents`) only after its write landed —
 * so a replayed webhook or a repeated poll never notifies twice (the
 * dedupe keys below collapse anything that slips through).
 *
 * The text quotes the courier's own status; nothing is inferred beyond the
 * normalized meaning documented in status-map.ts. Best-effort: a failure
 * here never affects the tracking pipeline.
 */

const COURIER_LABEL: Record<string, string> = { steadfast: "Steadfast", pathao: "Pathao", redx: "RedX" };

async function orderRef(orderId: Types.ObjectId) {
  const o = await Order.findById(orderId).select("orderNumber logistics.courier").lean();
  return {
    number: o?.orderNumber ?? String(orderId).slice(-6),
    courier: COURIER_LABEL[o?.logistics?.courier ?? ""] ?? o?.logistics?.courier ?? "The courier",
  };
}

/** A failed delivery attempt / return in progress — the parcel is still with the courier. */
export async function notifyDeliveryIssue(args: {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
  providerStatus: string;
  description?: string;
  /** The tracking event's dedupe key: one notification per distinct courier event. */
  eventKey: string;
}): Promise<void> {
  try {
    const ref = await orderRef(args.orderId);
    const note = args.description && args.description !== args.providerStatus ? ` — ${args.description}` : "";
    await dispatchNotification({
      merchantId: args.merchantId,
      kind: "order.delivery_issue",
      severity: "warning",
      title: `Delivery problem on order ${ref.number}`,
      body: `${ref.courier} reports "${args.providerStatus}"${note}. The parcel is still with the courier — call the customer, or expect it back.`,
      link: `/dashboard/orders?focus=${String(args.orderId)}`,
      subjectType: "order",
      subjectId: args.orderId,
      dedupeKey: `courier_issue:${String(args.orderId)}:${args.eventKey}`,
      meta: { providerStatus: args.providerStatus },
    });
  } catch (err) {
    console.error("[courier-notify] delivery issue failed", (err as Error).message);
  }
}

/** The courier marked the parcel returned to the merchant (order → rto). */
export async function notifyReturned(args: { merchantId: Types.ObjectId; orderId: Types.ObjectId }): Promise<void> {
  try {
    const ref = await orderRef(args.orderId);
    await dispatchNotification({
      merchantId: args.merchantId,
      kind: "order.returned",
      severity: "warning",
      title: `Order ${ref.number} returned`,
      body: `${ref.courier} marked this parcel as returned to you. Check the items when they arrive.`,
      link: `/dashboard/orders?focus=${String(args.orderId)}`,
      subjectType: "order",
      subjectId: args.orderId,
      dedupeKey: `courier_rto:${String(args.orderId)}`,
    });
  } catch (err) {
    console.error("[courier-notify] returned failed", (err as Error).message);
  }
}
