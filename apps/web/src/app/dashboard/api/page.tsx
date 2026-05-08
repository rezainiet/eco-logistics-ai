import { redirect } from "next/navigation";

/**
 * Legacy redirect — /dashboard/api -> /dashboard/settings/api.
 * Webhook config and signing-secret rotation now live under the
 * unified settings IA.
 */
export default function LegacyApiRedirect({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  redirect(`/dashboard/settings/api${buildQueryString(searchParams)}`);
}

function buildQueryString(
  params: Record<string, string | string[] | undefined> | undefined,
): string {
  if (!params) return "";
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) entries.push([k, item]);
    } else {
      entries.push([k, v]);
    }
  }
  if (entries.length === 0) return "";
  return `?${new URLSearchParams(entries).toString()}`;
}
