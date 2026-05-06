import type { ReactNode } from "react";
import { CordonAuthShell } from "@/components/shell/cordon-auth-shell";

/**
 * Forgot-password route inherits the same Cordon-themed shell as the
 * (auth) route group so /login, /signup, /forgot-password and
 * /reset-password share one visual identity. No Providers needed —
 * forgot-password makes plain `fetch` calls to the API and never touches
 * NextAuth or tRPC.
 */
export default function ForgotPasswordLayout({ children }: { children: ReactNode }) {
  return <CordonAuthShell>{children}</CordonAuthShell>;
}
