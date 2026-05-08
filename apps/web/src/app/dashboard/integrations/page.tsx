import { redirect } from "next/navigation";

/**
 * Legacy redirect — /dashboard/integrations → /dashboard/settings/integrations.
 *
 * Critical to preserve search params here: the OAuth callbacks for
 * Shopify and WooCommerce land users at this route with `?connected=`,
 * `?shop=`, `?warning=` query strings that drive post-connect banner
 * state. Dropping the query would silently break the post-OAuth
 * "Connected — but webhooks aren't firing yet" warning, which is one
 * of the most operationally important banners in the product.
 */
export default function LegacyIntegrationsRedirect({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const qs = buildQueryString(searchParams);
  redirect(`/dashboard/settings/integrations${qs}`);
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
