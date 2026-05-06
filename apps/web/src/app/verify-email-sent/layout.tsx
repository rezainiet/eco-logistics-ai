import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import { CordonAuthShell } from "@/components/shell/cordon-auth-shell";

/**
 * Post-signup confirmation route. Wears the same Cordon shell as the (auth)
 * surfaces so a merchant who just clicked "Start saving →" doesn't
 * experience a visual context-switch when we bounce them through the
 * "check your inbox" interstitial.
 *
 * Providers is included because the resend button uses NextAuth's session
 * to fetch the current merchant's email if the URL doesn't carry one.
 */
export default function VerifyEmailSentLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <CordonAuthShell>{children}</CordonAuthShell>
    </Providers>
  );
}
