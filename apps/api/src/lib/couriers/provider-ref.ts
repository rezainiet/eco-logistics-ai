import { Types } from "mongoose";
import { PendingAwb } from "@ecom/db";

/**
 * The courier's own parcel id for an order, for status endpoints keyed by it
 * (Steadfast `status_by_cid/<consignment_id>`).
 *
 * New bookings store it on `logistics.providerOrderId`. Orders booked before
 * that field existed still have it on their succeeded PendingAwb ledger row,
 * so polling works for them too. Merchant-scoped; read-only.
 */
export async function resolveProviderOrderId(order: {
  _id: unknown;
  merchantId: unknown;
  logistics?: { trackingNumber?: string | null; providerOrderId?: string | null } | null;
}): Promise<string | undefined> {
  const stored = order.logistics?.providerOrderId?.trim();
  if (stored) return stored;
  const trackingNumber = order.logistics?.trackingNumber;
  if (!trackingNumber) return undefined;
  const row = await PendingAwb.findOne({
    orderId: new Types.ObjectId(String(order._id)),
    merchantId: new Types.ObjectId(String(order.merchantId)),
    status: "succeeded",
    trackingNumber,
  })
    .select("providerOrderId")
    .sort({ attempt: -1 })
    .lean();
  return row?.providerOrderId?.trim() || undefined;
}
