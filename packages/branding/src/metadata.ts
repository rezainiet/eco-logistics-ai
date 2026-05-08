import type { BrandingConfig } from "./types.js";

export interface RootBrandingMetadata {
  metadataBase: URL;
  title: { default: string; template: string };
  description: string;
  applicationName: string;
  authors: { name: string }[];
  keywords: string[];
  icons: { icon: string; apple?: string };
  openGraph: {
    type: "website";
    locale: string;
    siteName: string;
    title: string;
    description: string;
    url: string;
    images: { url: string; width: number; height: number; alt?: string }[];
  };
  twitter: {
    card: "summary_large_image";
    title: string;
    description: string;
    site?: string;
    images: string[];
  };
  robots: { index: boolean; follow: boolean };
}

export interface BuildRootMetadataOpts {
  publicWebUrl?: string;
}

/**
 * Build the root-layout metadata block from a BrandingConfig. Used by
 * `apps/web/src/app/layout.tsx`'s generateMetadata to replace hardcoded
 * Cordon literals with values that flow from the central source.
 */
export function buildRootMetadata(
  brand: BrandingConfig,
  opts: BuildRootMetadataOpts = {},
): RootBrandingMetadata {
  const baseStr = (opts.publicWebUrl ?? brand.homeUrl).replace(/\/$/, "");
  const base = new URL(baseStr || "http://localhost:3001");
  return {
    metadataBase: base,
    title: {
      default: brand.seo.metaTitleDefault,
      template: brand.seo.metaTitleTemplate,
    },
    description: brand.seo.metaDescription,
    applicationName: brand.name,
    authors: [{ name: brand.name }],
    keywords: brand.seo.keywords,
    icons: {
      icon: brand.assets.favicon.url,
      apple: brand.assets.appleTouchIcon?.url,
    },
    openGraph: {
      type: "website",
      locale: brand.defaultLocale,
      siteName: brand.seo.ogSiteName,
      title: brand.seo.metaTitleDefault,
      description: brand.seo.metaDescription,
      url: "/",
      images: [
        {
          url: brand.assets.ogImage.url,
          width: brand.assets.ogImage.widthPx ?? 1200,
          height: brand.assets.ogImage.heightPx ?? 630,
          alt: brand.assets.ogImage.alt ?? brand.name,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: brand.seo.metaTitleDefault,
      description: brand.seo.metaDescription,
      site: brand.seo.twitterHandle,
      images: [brand.assets.twitterImage?.url ?? brand.assets.ogImage.url],
    },
    robots: { index: true, follow: true },
  };
}
