import { TRPCError } from "@trpc/server";
import { normalizeGa4Id, normalizeGoogleAdsId, normalizeGoogleAdsLabel, normalizeMetaPixelId, normalizeTiktokPixelId } from "@ecom/landing";
import { LandingPage, LandingPageHost } from "@ecom/db";
import { writeAudit } from "../audit.js";
import { type Actor, getOwnedPage } from "./pages.js";
import { invalidateLandingHost } from "./resolve.js";

/**
 * Per-landing-page analytics (page Settings → Analytics & Tracking).
 *
 * Each page carries its own tracking IDs — usually those of the ad accounts
 * that promote that page — each with an on/off switch:
 *   Meta     Pixel ID
 *   Google   GA4 measurement ID and/or Google Ads tag (+ purchase label)
 *   TikTok   Pixel ID
 * Only public identifiers are stored (they end up in the page's HTML) —
 * never access tokens or API secrets. They are served live with the page,
 * so changes apply without republishing.
 */

export interface LandingTrackingSettings {
  metaPixelId: string | null;
  /** Meta on/off (historical name). */
  enabled: boolean;
  google: { ga4MeasurementId: string | null; googleAdsId: string | null; googleAdsPurchaseLabel: string | null; enabled: boolean };
  tiktok: { pixelId: string | null; enabled: boolean };
  updatedAt: string | null;
}

export interface TrackingInput {
  pageId: string;
  metaPixelId: string | null;
  enabled: boolean;
  /** Omitted = leave Google settings as they are. */
  google?: { ga4MeasurementId: string | null; googleAdsId: string | null; googleAdsPurchaseLabel: string | null; enabled: boolean };
  /** Omitted = leave TikTok settings as they are. */
  tiktok?: { pixelId: string | null; enabled: boolean };
}

export type StoredTrackingDoc =
  | {
      metaPixelId?: string | null;
      enabled?: boolean | null;
      ga4MeasurementId?: string | null;
      googleAdsId?: string | null;
      googleAdsPurchaseLabel?: string | null;
      googleEnabled?: boolean | null;
      tiktokPixelId?: string | null;
      tiktokEnabled?: boolean | null;
      updatedAt?: Date | null;
    }
  | null
  | undefined;

export function trackingView(t: StoredTrackingDoc): LandingTrackingSettings {
  const ga4 = t?.ga4MeasurementId ?? null;
  const ads = t?.googleAdsId ?? null;
  return {
    metaPixelId: t?.metaPixelId ?? null,
    enabled: t?.enabled === true && !!t?.metaPixelId,
    google: {
      ga4MeasurementId: ga4,
      googleAdsId: ads,
      googleAdsPurchaseLabel: t?.googleAdsPurchaseLabel ?? null,
      enabled: t?.googleEnabled === true && !!(ga4 || ads),
    },
    tiktok: { pixelId: t?.tiktokPixelId ?? null, enabled: t?.tiktokEnabled === true && !!t?.tiktokPixelId },
    updatedAt: t?.updatedAt ? new Date(t.updatedAt).toISOString() : null,
  };
}

function bad(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** Optional ID: "" / null clears it; anything else must be valid. */
function optionalId(raw: string | null | undefined, normalize: (v: unknown) => string | null, message: string): string | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  return normalize(s) ?? bad(message);
}

export async function getPageTracking(merchantId: Actor["merchantId"], pageId: string): Promise<LandingTrackingSettings> {
  const page = await getOwnedPage(merchantId, pageId);
  return trackingView(page.tracking as StoredTrackingDoc);
}

export async function setPageTracking(actor: Actor, input: TrackingInput): Promise<LandingTrackingSettings> {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  const current = (page.tracking ?? {}) as NonNullable<StoredTrackingDoc>;

  const pixel = optionalId(input.metaPixelId, normalizeMetaPixelId, "A Meta Pixel ID is 15 or 16 digits, e.g. 123456789012345.");
  if (input.enabled && !pixel) bad("Add this page's Meta Pixel ID before turning tracking on.");

  let google = {
    ga4MeasurementId: current.ga4MeasurementId ?? null,
    googleAdsId: current.googleAdsId ?? null,
    googleAdsPurchaseLabel: current.googleAdsPurchaseLabel ?? null,
    googleEnabled: current.googleEnabled === true,
  };
  if (input.google) {
    const ga4 = optionalId(input.google.ga4MeasurementId, normalizeGa4Id, "A GA4 measurement ID looks like G-ABC123XYZ9.");
    const ads = optionalId(input.google.googleAdsId, normalizeGoogleAdsId, "A Google Ads tag ID looks like AW-123456789.");
    const label = optionalId(
      input.google.googleAdsPurchaseLabel,
      normalizeGoogleAdsLabel,
      "A conversion label is the part after the slash, e.g. AbC-D_efG-h12.",
    );
    if (label && !ads) bad("Add the Google Ads tag ID (AW-…) for this conversion label.");
    if (input.google.enabled && !ga4 && !ads) bad("Add a GA4 measurement ID or a Google Ads tag ID before turning Google on.");
    google = { ga4MeasurementId: ga4, googleAdsId: ads, googleAdsPurchaseLabel: label, googleEnabled: input.google.enabled && !!(ga4 || ads) };
  }

  let tiktok = { tiktokPixelId: current.tiktokPixelId ?? null, tiktokEnabled: current.tiktokEnabled === true };
  if (input.tiktok) {
    const id = optionalId(input.tiktok.pixelId, normalizeTiktokPixelId, "A TikTok Pixel ID is about 20 letters and digits, e.g. C4ABCDEF1234567890GH.");
    if (input.tiktok.enabled && !id) bad("Add this page's TikTok Pixel ID before turning TikTok on.");
    tiktok = { tiktokPixelId: id, tiktokEnabled: input.tiktok.enabled && !!id };
  }

  const before = trackingView(current);
  // Google / TikTok fields are stored only once configured, so a page that
  // never used them keeps exactly its Meta fields.
  const googleSet = google.ga4MeasurementId || google.googleAdsId || google.googleAdsPurchaseLabel || google.googleEnabled;
  const tiktokSet = tiktok.tiktokPixelId || tiktok.tiktokEnabled;
  const next = {
    metaPixelId: pixel,
    enabled: input.enabled && !!pixel,
    ...(googleSet ? google : {}),
    ...(tiktokSet ? tiktok : {}),
    updatedAt: new Date(),
  };
  await LandingPage.updateOne({ _id: page._id, merchantId: actor.merchantId }, { $set: { tracking: next } });
  // Only this page's cached public payloads change.
  const hosts = await LandingPageHost.find({ pageId: page._id, merchantId: actor.merchantId, status: "active" }).select("hostname").lean();
  await Promise.all(hosts.map((h) => invalidateLandingHost(h.hostname)));
  const after = trackingView(next);
  const summary = (v: LandingTrackingSettings) => ({
    metaPixelId: v.metaPixelId,
    enabled: v.enabled,
    google: v.google,
    tiktok: v.tiktok,
  });
  await writeAudit({
    merchantId: actor.merchantId,
    actorId: actor.actorId,
    actorEmail: actor.email,
    actorType: "merchant",
    action: "landing.tracking_updated",
    subjectType: "landing_page",
    subjectId: page._id,
    meta: { before: summary(before), after: summary(after) },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
  return after;
}
