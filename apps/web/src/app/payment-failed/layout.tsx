import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import { CordonAuthShell } from "@/components/shell/cordon-auth-shell";

/**
 * Payment failure route. Shares the Cordon shell with /payment-success so
 * the merchant doesn't see a stylistic switch between the two outcomes —
 * only the message changes.
 */
export default function PaymentFailedLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <CordonAuthShell>{children}</CordonAuthShell>
    </Providers>
  );
}
