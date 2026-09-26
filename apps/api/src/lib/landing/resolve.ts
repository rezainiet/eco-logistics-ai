import {
  type LandingAnalyticsConfig,
  type LandingCommerce,
  type Locale,
  type PageContent,
  type ResolvedSeo,
  SUPPORTED_LOCALES,
  type TemplateSpec,
  analyticsConfigOf,
  deliveryOptions,
  extractLandingLabel,
  isLocale,
  normalizeLocaleSettings,
  readLocalized,
  resolveContent,
  resolveSeo,
} from "@ecom/landing";
import { LandingPage, LandingPageHost, LandingPageRevision, LandingPageTemplate, Merchant } from "@ecom/db";
import { env } from "../../env.js";
import { cached, invalidate } from "../cache.js";
import { catalogFor } from "./products.js";
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
      slug: string;
      /** The locale rendered, the page's enabled locales and its default. */
      locale: Locale;
      locales: Locale[];
      defaultLocale: Locale;
      revision: { number: number; publishedAt: string };
      templateVersion: { version: number };
      /** Template key (e.g. "bd-modern-shop") — public, used in analytics payloads. */
      template: { key: string };
      spec: TemplateSpec;
      content: PageContent;
      seo: ResolvedSeo;
      assetBaseUrl: string;
      /** Browser analytics for this page (public Pixel ID only), or null when off. */
      analytics: LandingAnalyticsConfig | null;
      /**
       * Products linked to the published revision with LIVE price and stock,
       * plus the page's delivery options; null when it links no products.
       */
      commerce: LandingCommerce | null;
    }
  | { kind: "not_found" }
  | { kind: "unavailable" };

type OkResult = Extract<PublicLandingResult, { kind: "ok" }>;

/**
 * What is cached per host: everything except live product data, which is
 * joined on every request so price and stock are never stale. The product
 * references stay server-side (never part of the public payload).
 */
type CachedResult =
  | (Omit<OkResult, "commerce"> & { productScope: { merchantId: string; pageId: string; refs: Array<{ productId: string; ctaText?: string | null; badge?: string | null; featured?: boolean | null }> } | null; delivery: LandingCommerce["delivery"] })
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

export function landingHostCacheKey(label: string, locale: Locale | null = null): string {
  return `landing:host:${label}:${locale ?? "default"}`;
}

/** Drop every cached public payload for a merchant's pages (e.g. tracking settings changed). */
export async function invalidateMerchantLandingHosts(merchantId: unknown): Promise<void> {
  const hosts = await LandingPageHost.find({ merchantId, status: "active" }).select("hostname").lean();
  await Promise.all(hosts.map((h) => invalidateLandingHost(h.hostname)));
}

/** Drop every cached public payload for a label (publish, unpublish, slug change, archive). */
export async function invalidateLandingHost(label: string | null | undefined): Promise<void> {
  if (!label) return;
  await Promise.all([null, ...SUPPORTED_LOCALES].map((l) => invalidate(landingHostCacheKey(label, l))));
}

/**
 * @param opts.locale  null/undefined → the page's default locale (served at
 *   "/"); a locale code → that language (served at "/<locale>"), which
 *   must be enabled on the published revision or the result is not_found.
 */
export async function resolveLandingPageByHost(
  hostname: string | null | undefined,
  opts: { rootDomain?: string | null; useCache?: boolean; locale?: string | null } = {},
): Promise<PublicLandingResult> {
  const root = opts.rootDomain === undefined ? landingRootDomain() : opts.rootDomain;
  if (!root) return { kind: "not_found" };
  const label = extractLandingLabel(hostname, root);
  if (!label) return { kind: "not_found" };
  let locale: Locale | null = null;
  if (opts.locale != null && opts.locale !== "") {
    if (!isLocale(opts.locale)) return { kind: "not_found" };
    locale = opts.locale;
  }
  const base =
    opts.useCache === false
      ? await resolveLabel(label, locale)
      : await cached(landingHostCacheKey(label, locale), CACHE_TTL_S, () => resolveLabel(label, locale));
  return withLiveCommerce(base);
}

async function withLiveCommerce(base: CachedResult): Promise<PublicLandingResult> {
  if (base.kind !== "ok") return base;
  const { productScope, delivery, ...rest } = base;
  if (!productScope || productScope.refs.length === 0) return { ...rest, commerce: null };
  const products = await catalogFor(productScope.merchantId, productScope.refs);
  if (products.length === 0) return { ...rest, commerce: null };
  return { ...rest, commerce: { products, delivery, currency: products[0]!.currency } };
}

/**
 * Server-side view of a published page for order placement: the page, its
 * merchant, the published revision's product refs and delivery options.
 * Same checks as the public resolve (published, merchant online), never
 * cached, and it never trusts anything but the hostname.
 */
export async function resolvePublishedForOrder(hostname: string | null | undefined, locale: string | null) {
  const root = landingRootDomain();
  if (!root) return null;
  const label = extractLandingLabel(hostname, root);
  if (!label) return null;
  // The default language is served at "/" (requested as null), others by code.
  const wanted = locale && isLocale(locale) ? locale : null;
  let r = await resolveLabel(label, wanted);
  if (r.kind === "not_found" && wanted) {
    r = await resolveLabel(label, null);
    if (r.kind === "ok" && r.locale !== wanted) return null;
  }
  if (r.kind !== "ok" || !r.productScope) return null;
  return {
    label,
    locale: r.locale,
    revision: r.revision.number,
    merchantId: r.productScope.merchantId,
    pageId: r.productScope.pageId,
    refs: r.productScope.refs,
    delivery: r.delivery,
  };
}

async function resolveLabel(label: string, requested: Locale | null): Promise<CachedResult> {
  const host = await LandingPageHost.findOne({ hostname: label, status: "active" })
    .select("merchantId pageId")
    .lean();
  if (!host) return { kind: "not_found" };

  const page = await LandingPage.findOne({ _id: host.pageId, merchantId: host.merchantId })
    .select("status publishedRevisionId")
    .lean();
  if (!page || page.status !== "published" || !page.publishedRevisionId) return { kind: "not_found" };

  const merchant = await Merchant.findById(host.merchantId).select("subscription.status landingTracking").lean();
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

  const settings = normalizeLocaleSettings(revision.locales, revision.defaultLocale, "en");
  const locale = requested ?? settings.defaultLocale;
  // A non-default locale must be requested explicitly; the default locale is
  // only served at the root, so "/bn" on a bn-default page is not a duplicate.
  if (!settings.locales.includes(locale) || (requested && requested === settings.defaultLocale)) {
    return { kind: "not_found" };
  }
  const content = resolveContent(version.spec, readLocalized(revision.content)[locale], locale);
  const template = await LandingPageTemplate.findById(version.templateId).select("key").lean();
  return {
    kind: "ok",
    slug: label,
    locale,
    locales: settings.locales,
    defaultLocale: settings.defaultLocale,
    revision: {
      number: revision.number,
      publishedAt: (revision.createdAt ?? new Date()).toISOString(),
    },
    templateVersion: { version: version.version },
    template: { key: template?.key ?? "custom" },
    spec: version.spec,
    content,
    seo: resolveSeo(version.spec, content),
    assetBaseUrl: landingAssetBaseUrl(),
    analytics: analyticsConfigOf(merchant.landingTracking),
    productScope: revision.products?.length
      ? {
          merchantId: String(host.merchantId),
          pageId: String(page._id),
          refs: revision.products.map((r) => ({
            productId: String(r.productId),
            ctaText: r.ctaText ?? null,
            badge: r.badge ?? null,
            featured: r.featured === true,
          })),
        }
      : null,
    delivery: deliveryOptions(version.spec, content, locale),
  };
}
