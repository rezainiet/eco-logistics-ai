import type { ReactNode } from "react";
import { CordonAuthShell } from "@/components/shell/cordon-auth-shell";

/**
 * /verify-email — final auth surface to migrate onto the Cordon shell.
 * Doesn't redirect signed-in users (verifying email IS something a
 * signed-in merchant does), so it lives outside the (auth) route group.
 * Same shell, same brand voice — just no auth-redirect hook.
 */
export default function VerifyEmailLayout({ children }: { children: ReactNode }) {
  return <CordonAuthShell>{children}</CordonAuthShell>;
}
