import type { MetadataRoute } from "next";

/**
 * App Router `robots.ts` convention — Next emits /robots.txt at build.
 *
 * Disallow rules cover the surfaces that should never appear in a search
 * result:
 *   - /dashboard/*   merchant-private
 *   - /admin/*       internal ops UI
 *   - /api/*         tRPC + auth + webhook receivers
 *   - /track/*       customer-private order tracking
 *   - /(auth)        the route group itself never resolves; the actual
 *     surfaces — /login, /signup — are listed explicitly so a crawler
 *     hitting them gets a clear signal not to index credential forms
 *
 * The marketing surfaces (/, /pricing, /legal/*) stay crawlable.
 */
export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3001";
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          "/dashboard/",
          "/admin/",
          "/api/",
          "/track/",
          "/login",
          "/signup",
          "/forgot-password",
          "/reset-password",
          "/verify-email",
          "/verify-email-sent",
          "/payment-success",
          "/payment-failed",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
