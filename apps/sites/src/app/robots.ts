import type { MetadataRoute } from "next";
import { indexingAllowed } from "@/lib/config";

/**
 * Crawlers stay out until the production landing-domain phase explicitly
 * enables indexing (LANDING_ALLOW_INDEXING=true). Per-page `noindex` is
 * additionally honoured via page metadata.
 */
export default function robots(): MetadataRoute.Robots {
  return indexingAllowed()
    ? { rules: [{ userAgent: "*", allow: "/" }] }
    : { rules: [{ userAgent: "*", disallow: "/" }] };
}
