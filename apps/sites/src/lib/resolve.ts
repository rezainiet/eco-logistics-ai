import { cache } from "react";
import { headers } from "next/headers";
import type { LandingAnalyticsConfig, Locale, PageContent, ResolvedSeo, TemplateSpec } from "@ecom/landing";
import { normalizeHost } from "@ecom/landing";
import { landingApiUrl } from "./config";

export type PublicLanding =
  | {
      kind: "ok";
      slug: string;
      locale: Locale;
      locales: Locale[];
      defaultLocale: Locale;
      revision: { number: number; publishedAt: string };
      templateVersion: { version: number };
      template?: { key: string };
      spec: TemplateSpec;
      content: PageContent;
      seo: ResolvedSeo;
      assetBaseUrl: string;
      analytics?: LandingAnalyticsConfig | null;
    }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "error" };

/**
 * Ask the API for the published page behind the request's Host header.
 * The label in the URL path is only a routing artefact of the middleware
 * rewrite; the API resolves from the (validated) Host itself.
 *
 * Deduplicated per request with React `cache` (layout, metadata and page
 * share one call). Not cached across requests here — the API holds the
 * shared, explicitly-invalidated cache, so publish/unpublish apply at once.
 */
export const resolveCurrentHost = cache(async (label: string, locale: string | null): Promise<PublicLanding> => {
  const host = normalizeHost(headers().get("host"));
  if (!host || !host.startsWith(`${label}.`)) return { kind: "not_found" };
  const input = encodeURIComponent(JSON.stringify({ host, locale }));
  let res: Response;
  try {
    res = await fetch(`${landingApiUrl()}/trpc/publicLanding.resolveByHost?input=${input}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    return { kind: "error" };
  }
  if (!res.ok) return res.status === 404 ? { kind: "not_found" } : { kind: "error" };
  try {
    const body = (await res.json()) as { result?: { data?: PublicLanding } };
    return body.result?.data ?? { kind: "error" };
  } catch {
    return { kind: "error" };
  }
});
