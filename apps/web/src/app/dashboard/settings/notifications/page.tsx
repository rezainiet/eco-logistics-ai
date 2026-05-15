import { redirect } from "next/navigation";
import { DEFAULT_SETTINGS_HREF } from "@/components/settings/nav-config";

/**
 * Notification preferences are not in the private-beta build. Rather than
 * show merchants a "coming soon" placeholder inside a paid settings area
 * (which reads as "beta in disguise"), this route is collapsed back into
 * settings. Old links — onboarding emails, alert footers — still resolve.
 * Re-introduce this page when the feature ships, not before.
 */
export default function NotificationsSettingsRedirect() {
  redirect(DEFAULT_SETTINGS_HREF);
}
