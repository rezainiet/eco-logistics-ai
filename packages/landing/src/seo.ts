import type { ImageValue } from "./fields.js";
import { type PageContent, type TemplateSpec, effectiveSections } from "./spec.js";

/**
 * Page-level SEO resolved from the page's `seo` section, with fallbacks to
 * visible copy so an untouched page still has a sensible title.
 *
 * Merchant-editable: title, description, OG title/description/image,
 * favicon, noindex. Platform-controlled (added by the public renderer once
 * hostname infrastructure exists): canonical URL, robots.txt, sitemap.
 */
export interface ResolvedSeo {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImageAssetId: string | null;
  faviconAssetId: string | null;
  noindex: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asset(v: unknown): string | null {
  return v && typeof v === "object" && "assetId" in v ? (v as ImageValue).assetId : null;
}

export function resolveSeo(spec: TemplateSpec, resolved: PageContent): ResolvedSeo {
  const sections = effectiveSections(spec);
  const seo = resolved[sections.find((s) => s.type === "seo")?.id ?? ""] ?? {};
  const HERO_TYPES = ["hero", "promoHero", "editorialHero"];
  const HEADER_TYPES = ["header", "shopHeader"];
  const hero = resolved[sections.find((s) => HERO_TYPES.includes(s.type))?.id ?? ""] ?? {};
  const header = resolved[sections.find((s) => HEADER_TYPES.includes(s.type))?.id ?? ""] ?? {};

  const title = str(seo.title) || str(hero.headline) || str(header.brandName) || "Untitled page";
  const description = str(seo.description) || str(hero.subheadline).slice(0, 160);
  return {
    title: title.slice(0, 70),
    description,
    ogTitle: str(seo.ogTitle) || title,
    ogDescription: str(seo.ogDescription) || description,
    ogImageAssetId: asset(seo.ogImage) ?? asset(hero.image),
    faviconAssetId: asset(seo.favicon),
    noindex: seo.noindex === true,
  };
}
