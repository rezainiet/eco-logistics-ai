import { redirect } from "next/navigation";
import { DEFAULT_SETTINGS_HREF } from "@/components/settings/nav-config";

/**
 * Team & access is not in the private-beta build (every workspace is
 * single-login today). Showing a "coming soon" tile inside paid settings
 * signals "unfinished product"; collapsing the route back into settings
 * is the honest minimal state. Old links still resolve. Restore this
 * page when seats/roles actually ship.
 */
export default function TeamSettingsRedirect() {
  redirect(DEFAULT_SETTINGS_HREF);
}
