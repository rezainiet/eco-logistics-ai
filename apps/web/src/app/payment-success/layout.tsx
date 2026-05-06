import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import { CordonAuthShell } from "@/components/shell/cordon-auth-shell";

/**
 * Post-payment confirmation route. Shares the Cordon shell with /login,
 * /signup, /verify-email-sent and /payment-failed so a merchant returning
 * from Stripe / bKash never feels they've left the app.
 *
 * Providers is included so the page can call NextAuth + tRPC if it later
 * grows to invalidate billing queries (it does today via window message —
 * see /dashboard/billing for the existing post-Stripe pattern).
 */
export default function PaymentSuccessLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <CordonAuthShell>{children}</CordonAuthShell>
    </Providers>
  );
}
