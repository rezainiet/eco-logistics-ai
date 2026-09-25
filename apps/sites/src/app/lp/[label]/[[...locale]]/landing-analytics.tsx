"use client";

import { useEffect } from "react";
import type { LandingAnalyticsConfig, TrackedProduct } from "@ecom/landing";
import { type LandingPageContext, startLandingAnalytics } from "@/lib/analytics/landing-analytics";

/**
 * Mounted only by the published-page route. Renders nothing; starts the
 * event layer after hydration so the pixel never delays first paint.
 */
export function LandingAnalytics({
  config,
  page,
  products,
}: {
  config: LandingAnalyticsConfig;
  page: LandingPageContext;
  products: Record<string, TrackedProduct>;
}) {
  useEffect(
    () => startLandingAnalytics(config, page, products),
    // Stable per page load; primitives only so remounts don't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.metaPixelId, page.slug, page.locale],
  );
  return null;
}
