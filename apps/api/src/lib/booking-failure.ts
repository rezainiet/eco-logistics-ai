import { Types } from "mongoose";
import { Notification, Order } from "@ecom/db";
import { dispatchNotification } from "./notifications.js";
import type { CourierErrorCode } from "./couriers/types.js";

/**
 * Courier booking failures — what the merchant is told when a courier
 * would not book an order. A booking failure is its own event
 * (`order.booking_failed`): not a store webhook/integration failure, not a
 * quota or verification block. The reason comes from the courier adapter's
 * own error taxonomy (`CourierError.code`), worded for the merchant; raw
 * provider payloads and credentials never reach the notification.
 *
 * Automatic booking tries the merchant's couriers in turn (fallback); the
 * merchant is notified once, when the LAST option has failed — never for an
 * attempt a later courier recovered. One notification per order (dedupe
 * key on the order): repeated failures refresh it, and a later successful
 * booking removes it, so the inbox shows the final outcome.
 */

const REASON: Record<CourierErrorCode, string> = {
  auth_failed: "the courier rejected your account credentials — check them in Settings → Couriers",
  network: "we couldn't reach the courier",
  timeout: "the courier didn't respond in time",
  rate_limited: "the courier is limiting requests right now",
  invalid_input: "the courier rejected the order details",
  provider_error: "the courier returned an error",
  not_supported: "this courier can't take bookings from ConfirmX yet",
  circuit_open: "the courier kept failing, so requests to it are paused for a few minutes",
  unknown: "the courier returned an unexpected error",
};

const COURIER_LABEL: Record<string, string> = { pathao: "Pathao", steadfast: "Steadfast", redx: "RedX" };
export const courierLabel = (c: string | null | undefined) => (c ? (COURIER_LABEL[c.toLowerCase()] ?? c) : "the courier");

/**
 * Merchant-facing reason for a failed booking. Order-detail rejections
 * (`invalid_input`) keep the courier's own short message — it says what to
 * fix ("invalid phone") — trimmed to one line.
 */
export function bookingFailureReason(code: CourierErrorCode | null | undefined, message?: string | null): string {
  const base = REASON[code ?? "unknown"] ?? REASON.unknown;
  if (code === "invalid_input" && message) {
    const detail = message.replace(/\s+/g, " ").trim().slice(0, 140);
    if (detail) return `${base}: ${detail}`;
  }
  return base;
}

export const bookingFailedKey = (orderId: Types.ObjectId | string) => `booking-failed:${String(orderId)}`;

const joinCouriers = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export function bookingFailedCopy(args: {
  orderNumber: string;
  couriers: string[];
  code?: CourierErrorCode | null;
  error?: string | null;
}): { title: string; body: string } {
  const tried = args.couriers.map(courierLabel);
  const reason = bookingFailureReason(args.code, args.error);
  const last = tried[tried.length - 1] ?? courierLabel(null);
  const body =
    tried.length > 1
      ? `Order ${args.orderNumber} could not be booked — tried ${joinCouriers(tried)}. ${last}: ${reason}. Open the order to book it manually or pick another courier.`
      : `Order ${args.orderNumber} could not be booked with ${last}: ${reason}. Open the order to retry or pick another courier.`;
  return { title: `Courier booking failed — order ${args.orderNumber}`, body };
}

/**
 * The final failure of an automatic booking. Best-effort; never throws.
 * Critical, so the existing dispatcher also texts the merchant once (the
 * same channel the auto-book failure alert always used).
 */
export async function notifyBookingFailed(args: {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId | string;
  courier?: string | null;
  code?: CourierErrorCode | null;
  error?: string | null;
  /** Sweeps that only know "it's still failed" leave an existing, more precise alert as it is. */
  onlyIfMissing?: boolean;
}): Promise<void> {
  try {
    const orderId = new Types.ObjectId(String(args.orderId));
    const order = await Order.findOne({ _id: orderId, merchantId: args.merchantId })
      .select("orderNumber automation.attemptedCouriers logistics.trackingNumber")
      .lean();
    if (!order || order.logistics?.trackingNumber) return; // booked after all — nothing to report
    const attempted = (order as { automation?: { attemptedCouriers?: string[] } }).automation?.attemptedCouriers ?? [];
    // attemptedCouriers is stored as a set (not in attempt order); the courier that failed last goes last.
    const last = args.courier?.toLowerCase();
    const couriers = [...new Set(attempted.map((c) => c.toLowerCase()).filter((c) => c !== last)), ...(last ? [last] : [])];
    const { title, body } = bookingFailedCopy({ orderNumber: order.orderNumber, couriers, code: args.code, error: args.error });
    const dedupeKey = bookingFailedKey(orderId);
    if (args.onlyIfMissing && (await Notification.exists({ merchantId: args.merchantId, dedupeKey }))) return;
    const meta = {
      orderId: String(orderId),
      orderNumber: order.orderNumber,
      couriers,
      courier: args.courier ?? couriers[couriers.length - 1] ?? null,
      reasonCode: args.code ?? "unknown",
      error: args.error ? args.error.slice(0, 300) : null,
      automatic: true,
      fallbackExhausted: true,
    };
    await dispatchNotification({
      merchantId: args.merchantId,
      kind: "order.booking_failed",
      severity: "critical",
      title,
      body,
      link: `/dashboard/orders?focus=${String(orderId)}`,
      subjectType: "order",
      subjectId: orderId,
      meta,
      dedupeKey,
    });
    // A repeat (watchdog sweep, queue retry) refreshes the one row instead of adding one.
    await Notification.updateOne({ merchantId: args.merchantId, dedupeKey }, { $set: { title, body, meta } });
  } catch (err) {
    console.error("[booking-failed] notification failed", (err as Error).message);
  }
}

/** The order was booked after all: drop the stale failure alert so the inbox shows the final outcome. */
export async function clearBookingFailed(merchantId: Types.ObjectId, orderId: Types.ObjectId | string): Promise<void> {
  await Notification.deleteOne({ merchantId, dedupeKey: bookingFailedKey(orderId) }).catch(() => {});
}
