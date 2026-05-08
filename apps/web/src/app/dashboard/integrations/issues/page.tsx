import { redirect } from "next/navigation";

/**
 * Legacy redirect — /dashboard/integrations/issues
 *  -> /dashboard/settings/integrations/issues.
 */
export default function LegacyIntegrationsIssuesRedirect() {
  redirect("/dashboard/settings/integrations/issues");
}
