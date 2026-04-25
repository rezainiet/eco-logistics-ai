import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Centered card layout for account-task pages (reset, verify) that don't
 * belong to the `(auth)` group — those redirect signed-in merchants away,
 * which we explicitly don't want for password reset / email verify flows.
 */
export function AccountShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(800px_320px_at_50%_-140px,hsl(var(--brand)/0.18),transparent_70%)]"
      />
      <div className="relative z-10 w-full max-w-md space-y-6">
        <Link href="/" className="flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white shadow-glow">
            L
          </span>
          <span className="text-base font-semibold text-fg">Logistics</span>
        </Link>
        {children}
      </div>
    </main>
  );
}
