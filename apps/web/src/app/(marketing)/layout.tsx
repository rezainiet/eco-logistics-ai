import type { ReactNode } from "react";

/**
 * Marketing shell — explicitly NO providers.
 *
 * Pages inside this route group (the Cordon landing today, future /pricing,
 * /legal, /track marketing surfaces if you choose to migrate them) inherit
 * only the bare html/body shell from the root layout. No SessionProvider, no
 * TRPCProvider, no QueryClientProvider, no /api/auth/session pings.
 *
 * If a marketing page ever needs a tRPC call (unlikely — they should be
 * static), wrap that specific component in <Providers> rather than promoting
 * it into this layout.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
