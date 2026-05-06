import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import { CordonAuthShell } from "@/components/shell/cordon-auth-shell";

/**
 * Reset-password inherits the same Cordon-themed shell as the (auth)
 * route group so all four auth surfaces share one visual identity.
 * Providers stays here because the page calls NextAuth's signIn() to
 * auto-log the merchant in after a successful reset.
 */
export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <CordonAuthShell>{children}</CordonAuthShell>
    </Providers>
  );
}
