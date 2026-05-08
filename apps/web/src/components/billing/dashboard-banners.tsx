"use client";

import { usePathname } from "next/navigation";
import { SubscriptionBanner } from "@/components/billing/subscription-banner";
import { TrialSavingsBanner } from "@/components/billing/trial-savings-banner";
import { VerifyEmailBanner } from "@/components/billing/verify-email-banner";

/**
 * Wraps the layout-level banners (subscription + email-verify) so they can opt
 * out on routes that present the same information inline. On the welcome page
 * `<DashboardHero>` carries trial-days-left and email-verify as soft pills, so
 * the stacked banners would just be duplication. Everywhere else the banners
 * stay visible exactly as before.
 *
 * `TrialSavingsBanner` sits at the top because it's the most persuasive
 * surface during the trial — it carries the live "Cordon has saved you ৳…"
 * figure, which is the strongest argument for upgrading. It only renders
 * for trial accounts; paid merchants see nothing from it. The legacy
 * `SubscriptionBanner` still handles past_due / suspended / hard-trial-end
 * cases that the savings banner doesn't cover.
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
      <TrialSavingsBanner />
      <SubscriptionBanner />
      <VerifyEmailBanner />
    </>
  );
}
