import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/auth";
import { Providers } from "@/app/providers";
import { CordonAuthShell } from "@/components/shell/cordon-auth-shell";

/**
 * Auth route-group layout. Redirects authenticated merchants to the
 * dashboard, then wraps unauthenticated children in the shared
 * `CordonAuthShell` so /login and /signup match the marketing landing's
 * visual identity. The same shell is also used by /forgot-password and
 * /reset-password (via their own layout files), keeping all four auth
 * surfaces visually consistent.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (session) redirect("/dashboard");

  return (
    <Providers>
      <CordonAuthShell>{children}</CordonAuthShell>
    </Providers>
  );
}
