import { redirect } from "next/navigation";

/**
 * Legacy redirect — keeps every in-app link to /dashboard/billing
 * working after billing was absorbed into the unified settings IA.
 *
 * The actual billing page lives at /dashboard/settings/billing.
 *
 * Preserves search string so deep links from /payment-success?session_id=…
 * and the bKash/Nagad callbacks keep their query params end-to-end.
 */
export default function LegacyBillingRedirect({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  redirect(`/dashboard/settings/billing${buildQueryString(searchParams)}`);
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
