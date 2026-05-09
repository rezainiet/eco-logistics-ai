import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { FinalizeClient } from "./finalize-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connecting your Shopify store" };

/**
 * Public Shopify install completion page.
 *
 * Reached via the OAuth callback redirect:
 *   /install/shopify/complete?token=<claim>&shop=<shop>.myshopify.com
 *
 * The `token` is opaque (random base64url) and one-time-use; it indexes a
 * 15-minute-TTL Redis record holding the just-issued Shopify access token.
 *
 * Flow:
 *   - If the token is missing, render an error inline (no point redirecting
 *     the merchant to sign-up — there's nothing to claim).
 *   - If the visitor is unauthenticated, bounce them through /signup with a
 *     `next=` query so we land them right back here once they've made an
 *     account. NextAuth's signup flow doesn't preserve `?next=` natively;
 *     the signup page reads it from the URL and uses it as the post-signup
 *     redirect target.
 *   - If the visitor is authenticated, render `<FinalizeClient>` which calls
 *     `integrations.completeShopifyInstall({token})` and routes the merchant
 *     to /dashboard/settings/integrations on success.
 */
export default async function ShopifyInstallCompletePage({
  searchParams,
}: {
  searchParams?: { token?: string; shop?: string };
}) {
  const token = searchParams?.token?.trim();
  const shop = searchParams?.shop?.trim();

  if (!token) {
    return (
      <div className="mx-auto max-w-md space-y-3 py-12 text-center">
        <h1 className="text-xl font-semibold">Install link incomplete</h1>
        <p className="text-sm text-fg-muted">
          Something is missing from this link. Please start the install
          again from your Shopify admin.
        </p>
      </div>
    );
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    // Preserve token + shop through sign-up. Use absolute path on `next`
    // so the signup handler can drop us back here cleanly.
    const back = `/install/shopify/complete?token=${encodeURIComponent(token)}${shop ? `&shop=${encodeURIComponent(shop)}` : ""}`;
    redirect(`/signup?next=${encodeURIComponent(back)}&shopifyShop=${encodeURIComponent(shop ?? "")}`);
  }

  return <FinalizeClient token={token} shop={shop ?? null} />;
}
