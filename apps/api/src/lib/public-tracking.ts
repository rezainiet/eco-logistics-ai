import type { Types } from "mongoose";
import { Merchant, Order } from "@ecom/db";

/**
 * Public tracking timeline assembly.
 *
 * Looks up an order strictly by its courier tracking number and returns
 * ONLY fields that are safe to expose to anyone who happens to know that
 * code. Customer phone, full address, fraud signals, internal ids, and the
 * merchant's billing/courier credentials NEVER cross this boundary.
 *
 * The function is intentionally a single read — the customer tracking page
 * is on a hot share path and a single round-trip keeps p99 latency low.
 */

export interface PublicTrackingTimelineEvent {
  at: string; // ISO
  status: string;
  description?: string;
  location?: string;
}

export interface PublicTrackingResult {
  orderNumber: string;
  status: string; // canonical order.status
  cod: number; // BDT amount, public — already on the customer's invoice
  courier: string | null;
  trackingNumber: string;
  /** Address with the house/road number masked; district kept verbatim. */
  maskedAddress: string;
  estimatedDelivery: string | null;
  events: PublicTrackingTimelineEvent[];
  branding: {
    displayName: string;
    logoUrl?: string;
    primaryColor?: string;
    supportPhone?: string;
    supportEmail?: string;
  };
}

/**
 * Mask the street part of a delivery address. Keeps the district/area name
 * (so the customer can still verify the city is right) but redacts house
 * numbers and detailed lines so a leaked tracking link doesn't surface a
 * full deliverable address.
 *
 *  Input:  "House 12, Road 4, Banani, Dhaka"
 *  Output: "***, ***, Banani, Dhaka"
 *  Input:  "Banani"     (already district-only)
 *  Output: "Banani"
 */
export function maskDeliveryAddress(address: string, district: string): string {
  if (!address) return district;
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // If we have ≥3 parts, mask everything except the last 2 (which are
  // typically area + district names).
  if (parts.length >= 3) {
    const tail = parts.slice(-2).join(", ");
    return `***, ${tail}`;
  }
  // Single street/area line: just show the district name we already trust.
  return district;
}

const TERMINAL_STATUSES = new Set(["delivered", "rto", "cancelled"]);

export interface FetchOptions {
  /** When true, return null instead of throwing on miss. Defaults to true. */
  silentMiss?: boolean;
}

export async function fetchPublicTimeline(
  trackingCode: string,
): Promise<PublicTrackingResult | null> {
  const code = trackingCode.trim();
  if (!code || code.length < 4 || code.length > 100) return null;

  // Tracking code is unique-by-design at the courier; we still scope the
  // lookup to a single result to avoid a cross-merchant ambiguity in the
  // theoretical case of a collision.
  const order = await Order.findOne({ "logistics.trackingNumber": code })
    .select(
      "orderNumber merchantId customer.address customer.district order.status order.cod logistics.courier logistics.trackingNumber logistics.estimatedDelivery logistics.deliveredAt logistics.trackingEvents createdAt",
    )
    .lean();
  if (!order) return null;

  const merchant = await Merchant.findById(order.merchantId)
    .select("businessName branding")
    .lean();
  if (!merchant) return null;

  const events: PublicTrackingTimelineEvent[] = ((order.logistics?.trackingEvents ?? []) as Array<{
    at: Date;
    providerStatus: string;
    description?: string;
    location?: string;
  }>)
    .map((e) => ({
      at: (e.at instanceof Date ? e.at : new Date(e.at)).toISOString(),
      status: e.providerStatus,
      description: e.description,
      location: e.location,
    }))
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));

  // Synthesize a "Order placed" line at the bottom so customers always see
  // a starting event, even when no courier event has arrived yet.
  const orderCreatedAt = (order as { createdAt?: Date }).createdAt;
  events.push({
    at: (orderCreatedAt ? new Date(orderCreatedAt) : new Date()).toISOString(),
    status: "placed",
    description: "Order placed",
  });

  const branding = (merchant as { branding?: Record<string, unknown> }).branding ?? {};
  const displayName =
    (branding.displayName as string | undefined)?.trim() ||
    merchant.businessName ||
    "Your order";

  // Sanitize logoUrl + primaryColor so a hostile merchant value can never
  // become a CSS / DOM injection vector. Logo must be http(s) only;
  // primaryColor must match #rrggbb.
  const logoUrl =
    typeof branding.logoUrl === "string" && /^https?:\/\//i.test(branding.logoUrl)
      ? (branding.logoUrl as string)
      : undefined;
  const primaryColor =
    typeof branding.primaryColor === "string" && /^#[0-9a-fA-F]{6}$/.test(branding.primaryColor)
      ? (branding.primaryColor as string).toLowerCase()
      : undefined;

  return {
    orderNumber: order.orderNumber,
    status: order.order.status,
    cod: order.order.cod ?? 0,
    courier: order.logistics?.courier ?? null,
    trackingNumber: order.logistics?.trackingNumber ?? code,
    maskedAddress: maskDeliveryAddress(
      order.customer?.address ?? "",
      order.customer?.district ?? "",
    ),
    estimatedDelivery: order.logistics?.estimatedDelivery
      ? new Date(order.logistics.estimatedDelivery).toISOString()
      : order.logistics?.deliveredAt && TERMINAL_STATUSES.has(order.order.status)
        ? new Date(order.logistics.deliveredAt).toISOString()
        : null,
    events,
    branding: {
      displayName,
      logoUrl,
      primaryColor,
      supportPhone: typeof branding.supportPhone === "string" ? branding.supportPhone : undefined,
      supportEmail: typeof branding.supportEmail === "string" ? branding.supportEmail : undefined,
    },
  };
}
