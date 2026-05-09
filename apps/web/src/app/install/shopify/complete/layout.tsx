import type { ReactNode } from "react";
import { CordonAuthShell } from "@/components/shell/cordon-auth-shell";
import { Providers } from "@/app/providers";

/**
 * `/install/shopify/complete` is the landing page Shopify's OAuth callback
 * sends a public-install merchant to once we've issued a one-time claim
 * token. The page needs `<Providers>` because the client-side finalize
 * component calls a tRPC mutation. We pair that with `<CordonAuthShell>`
 * so the page shares the same brand chrome as /login and /signup; that
 * matters because unauthenticated visitors are redirected to /signup, and
 * authenticated visitors briefly see this page while the claim runs.
 */
export default function InstallCompleteLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <CordonAuthShell>{children}</CordonAuthShell>
    </Providers>
  );
}
