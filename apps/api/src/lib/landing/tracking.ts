import { TRPCError } from "@trpc/server";
import { normalizeMetaPixelId } from "@ecom/landing";
import { Merchant } from "@ecom/db";
import { writeAudit } from "../audit.js";
import type { Actor } from "./pages.js";
import { invalidateMerchantLandingHosts } from "./resolve.js";

/**
 * Merchant-level analytics for published landing pages.
 *
 * Only a Meta Pixel ID is stored — public by design — plus an on/off
 * switch. It applies to every published page of the merchant, served live
 * with the page (not snapshotted into revisions), so changing or disabling
 * it takes effect without republishing.
 */

export interface LandingTrackingSettings {
  metaPixelId: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

export async function getLandingTracking(merchantId: Actor["merchantId"]): Promise<LandingTrackingSettings> {
  const m = await Merchant.findById(merchantId).select("landingTracking").lean();
  const t = m?.landingTracking;
  return {
    metaPixelId: t?.metaPixelId ?? null,
    enabled: t?.enabled === true && !!t?.metaPixelId,
    updatedAt: t?.updatedAt ? new Date(t.updatedAt).toISOString() : null,
  };
}

export async function setLandingTracking(
  actor: Actor,
  input: { metaPixelId: string | null; enabled: boolean },
): Promise<LandingTrackingSettings> {
  const raw = (input.metaPixelId ?? "").trim();
  const pixel = raw === "" ? null : normalizeMetaPixelId(raw);
  if (raw !== "" && !pixel) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A Meta Pixel ID is 15 or 16 digits, e.g. 123456789012345." });
  }
  if (input.enabled && !pixel) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Add your Meta Pixel ID before turning tracking on." });
  }
  const before = await getLandingTracking(actor.merchantId);
  const now = new Date();
  await Merchant.updateOne(
    { _id: actor.merchantId },
    { $set: { landingTracking: { metaPixelId: pixel, enabled: input.enabled && !!pixel, updatedAt: now } } },
  );
  await invalidateMerchantLandingHosts(actor.merchantId);
  await writeAudit({
    merchantId: actor.merchantId,
    actorId: actor.actorId,
    actorEmail: actor.email,
    actorType: "merchant",
    action: "landing.tracking_updated",
    subjectType: "merchant",
    subjectId: actor.merchantId,
    meta: { before: { metaPixelId: before.metaPixelId, enabled: before.enabled }, after: { metaPixelId: pixel, enabled: input.enabled && !!pixel } },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
  return { metaPixelId: pixel, enabled: input.enabled && !!pixel, updatedAt: now.toISOString() };
}
