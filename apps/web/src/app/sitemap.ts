import type { MetadataRoute } from "next";

/**
 * Sitemap covers the public marketing + legal surfaces. The dashboard,
 * tracking, and auth pages are intentionally excluded — they're either
 * gated, customer-private, or have no SEO value.
 *
 * Update `lastModified` whenever the corresponding page's content
 * changes meaningfully so search engines re-crawl. We use a literal
 * date rather than `new Date()` so identical builds produce identical
 * sitemaps — easier to spot drift.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3001";
  const lastModified = new Date("2026-05-01");
  return [
    {
      url: `${base}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${base}/pricing`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${base}/legal/privacy`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${base}/legal/terms`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
