import {
  type PageContent,
  type ResolvedSeo,
  type TemplateSpec,
  extractLandingLabel,
  resolveContent,
  resolveSeo,
} from "@ecom/landing";
import { LandingPage, LandingPageHost, LandingPageRevision, Merchant } from "@ecom/db";
import { env } from "../../env.js";
import { cached, invalidate } from "../cache.js";
import { loadTemplateVersion } from "./templates.js";

/**
 * Public landing-page resolution: hostname → LandingPageHost → LandingPage
 * → published LandingPageRevision → template version → render payload.
 *
 * This is the entire contract the public renderer (apps/sites) depends on.
 * It knows nothing about DNS: once wildcard DNS/TLS route
 * `<slug>.<LANDING_ROOT_DOMAIN>` to the renderer, the renderer passes the
 * Host header here and gets back either a page or a not-found.
 *
 * Only the published revision is ever returned. Drafts, unpublished and
 * archived pages, released slugs and suspended merchants all resolve to a
 * non-page result, and this module never accepts a page/merchant id from
 * the caller — the hostname is the only input.
 */

export type PublicLandingResult =
  | {
      kind: "ok";
      page: { id: string; name: string; slug: string };
      revision: { number: number; publishedAt: string };
      templateVersion: { id: string; version: number };
      spec: TemplateSpec;
      content: PageContent;
      seo: ResolvedSeo;
      assetBaseUrl: string;
    }
  | { kind: "not_found" }
  | { kind: "unavailable" };

/** Subscription states in which a merchant's public pages go offline. */
const OFFLINE_SUBSCRIPTION = new Set(["suspended", "paused", "cancelled"]);

const CACHE_TTL_S = 60;

export function landingRootDomain(): string | null {
  if (env.LANDING_ROOT_DOMAIN) return env.LANDING_ROOT_DOMAIN;
  return env.NODE_ENV === "production" ? null : "localhost";
}

export function landingAssetBaseUrl(): string {
  return `${(env.PUBLIC_API_URL ?? `http://localhost:${env.API_PORT}`).replace(/\/+$/, "")}/api/landing-assets`;
}

export function landingHostCacheKey(label: string): string {
  return `landing:host:${label}`;
}

/** Drop the cached public payload for a label (publish, unpublish, slug change, archive). */
export async function invalidateLandingHost(label: string | null | undefined): Promise<void> {
  if (label) await invalidate(landingHostCacheKey(label));
}

export async function resolveLandingPageByHost(
  hostname: string | null | undefined,
  opts: { rootDomain?: string | null; useCache?: boolean } = {},
): Promise<PublicLandingResult> {
  const root = opts.rootDomain === undefined ? landingRootDomain() : opts.rootDomain;
  if (!root) return { kind: "not_found" };
  const label = extractLandingLabel(hostname, root);
  if (!label) return { kind: "not_found" };
  if (opts.useCache === false) return resolveLabel(label);
  return cached(landingHostCacheKey(label), CACHE_TTL_S, () => resolveLabel(label));
}

async function resolveLabel(label: string): Promise<PublicLandingResult> {
  const host = await LandingPageHost.findOne({ hostname: label, status: "active" })
    .select("merchantId pageId")
    .lean();
  if (!host) return { kind: "not_found" };

  const page = await LandingPage.findOne({ _id: host.pageId, merchantId: host.merchantId })
    .select("name status publishedRevisionId")
    .lean();
  if (!page || page.status !== "published" || !page.publishedRevisionId) return { kind: "not_found" };

  const merchant = await Merchant.findById(host.merchantId).select("subscription.status").lean();
  if (!merchant) return { kind: "not_found" };
  if (OFFLINE_SUBSCRIPTION.has(String(merchant.subscription?.status ?? ""))) return { kind: "unavailable" };

  const revision = await LandingPageRevision.findOne({
    _id: page.publishedRevisionId,
    pageId: page._id,
    merchantId: host.merchantId,
  }).lean();
  if (!revision) return { kind: "not_found" };

  const version = await loadTemplateVersion(revision.templateVersionId);
  if (!version || version.status !== "published") return { kind: "not_found" };

  const content = resolveContent(version.spec, revision.content);
  return {
    kind: "ok",
    page: { id: String(page._id), name: page.name, slug: label },
    revision: {
      number: revision.number,
      publishedAt: (revision.createdAt ?? new Date()).toISOString(),
    },
    templateVersion: { id: version.id, version: version.version },
    spec: version.spec,
    content,
    seo: resolveSeo(version.spec, content),
    assetBaseUrl: landingAssetBaseUrl(),
  };
}
