"use client";

import { usePathname } from "next/navigation";
import { SubscriptionBanner } from "@/components/billing/subscription-banner";
import { VerifyEmailBanner } from "@/components/billing/verify-email-banner";

/**
 * Wraps the layout-level banners (subscription + email-verify) so they can opt
 * out on routes that present the same information inline. On the welcome page
 * `<DashboardHero>` carries trial-days-left and email-verify as soft pills, so
 * the stacked banners would just be duplication. Everywhere else the banners
 * stay visible exactly as before.
 */
const HIDDEN_ON: ReadonlyArray<string> = [
  "/dashboard/getting-started",
];

export function DashboardBanners() {
  const pathname = usePathname() ?? "";
  if (HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }
  return (
    <>
      <SubscriptionBanner />
      <VerifyEmailBanner />
    </>
  );
}
