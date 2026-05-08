import { redirect } from "next/navigation";
import {
  DEFAULT_SETTINGS_HREF,
  LEGACY_TAB_TO_KEY,
  SETTINGS_BY_KEY,
} from "@/components/settings/nav-config";

/**
 * Settings root.
 *
 * Two responsibilities, both delegated to redirect():
 *
 *   1. /dashboard/settings           -> /dashboard/settings/workspace
 *   2. /dashboard/settings?tab=X     -> /dashboard/settings/<X-section>
 *
 * The second exists because the old single-page settings drove section
 * selection from a `?tab=` query string (and from `useState` — but
 * old emails, banners, and onboarding-progress CTAs landed users with
 * the query string set). We keep that contract working so deep links
 * from production traffic don't 404.
 *
 * If `tab` doesn't match a known section, we fall through to the
 * default workspace page rather than 404 — defensive, cheap, and
 * matches what users expect when they typo a query param.
 */
export default function SettingsRedirectPage({
  searchParams,
}: {
  searchParams?: { tab?: string | string[] };
}) {
  const rawTab = Array.isArray(searchParams?.tab)
    ? searchParams?.tab[0]
    : searchParams?.tab;
  if (rawTab) {
    const key = LEGACY_TAB_TO_KEY[rawTab];
    if (key) {
      redirect(SETTINGS_BY_KEY[key].href);
    }
  }
  redirect(DEFAULT_SETTINGS_HREF);
}
