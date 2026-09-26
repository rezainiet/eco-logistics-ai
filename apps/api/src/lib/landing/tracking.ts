import { TRPCError } from "@trpc/server";
import { normalizeMetaPixelId } from "@ecom/landing";
import { LandingPage, LandingPageHost } from "@ecom/db";
import { writeAudit } from "../audit.js";
import { type Actor, getOwnedPage } from "./pages.js";
import { invalidateLandingHost } from "./resolve.js";

/**
 * Per-landing-page analytics (page Settings → Analytics & Tracking).
 *
 * Each page carries its own Meta Pixel ID — usually the pixel of the ad
 * account that promotes that page — plus an on/off switch. A published
 * page loads only its own pixel. Only the (public) Pixel ID is stored;
 * it is served live with the page, so changes apply without republishing.
 */

export interface LandingTrackingSettings {
  metaPixelId: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

type Stored = { metaPixelId?: string | null; enabled?: boolean | null; updatedAt?: Date | null } | null | undefined;

function view(t: Stored): LandingTrackingSettings {
  return {
    metaPixelId: t?.metaPixelId ?? null,
    enabled: t?.enabled === true && !!t?.metaPixelId,
    updatedAt: t?.updatedAt ? new Date(t.updatedAt).toISOString() : null,
  };
}

export async function getPageTracking(merchantId: Actor["merchantId"], pageId: string): Promise<LandingTrackingSettings> {
  const page = await getOwnedPage(merchantId, pageId);
  return view(page.tracking as Stored);
}

export async function setPageTracking(
  actor: Actor,
  input: { pageId: string; metaPixelId: string | null; enabled: boolean },
): Promise<LandingTrackingSettings> {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  const raw = (input.metaPixelId ?? "").trim();
  const pixel = raw === "" ? null : normalizeMetaPixelId(raw);
  if (raw !== "" && !pixel) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A Meta Pixel ID is 15 or 16 digits, e.g. 123456789012345." });
  }
  if (input.enabled && !pixel) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Add this page's Meta Pixel ID before turning tracking on." });
  }
  const before = view(page.tracking as Stored);
  const next = { metaPixelId: pixel, enabled: input.enabled && !!pixel, updatedAt: new Date() };
  await LandingPage.updateOne({ _id: page._id, merchantId: actor.merchantId }, { $set: { tracking: next } });
  // Only this page's cached public payloads change.
  const hosts = await LandingPageHost.find({ pageId: page._id, merchantId: actor.merchantId, status: "active" }).select("hostname").lean();
  await Promise.all(hosts.map((h) => invalidateLandingHost(h.hostname)));
  await writeAudit({
    merchantId: actor.merchantId,
    actorId: actor.actorId,
    actorEmail: actor.email,
    actorType: "merchant",
    action: "landing.tracking_updated",
    subjectType: "landing_page",
    subjectId: page._id,
    meta: { before: { metaPixelId: before.metaPixelId, enabled: before.enabled }, after: { metaPixelId: pixel, enabled: next.enabled } },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
  return view(next);
}
