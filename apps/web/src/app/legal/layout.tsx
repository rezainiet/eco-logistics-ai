import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Wrapper for the legal pages (/legal/privacy, /legal/terms). Plain
 * marketing-style layout — no auth, no dashboard chrome — so the URLs
 * are linkable from external surfaces (Shopify Partner config form,
 * email footers, signup flow). The pages are MAX width 760px because
 * legal copy is long-form prose; wider hurts readability.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-stroke/10 bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Logistics Cloud
          </Link>
          <nav className="flex items-center gap-5 text-xs text-fg-subtle">
            <Link href="/legal/privacy" className="hover:text-fg">
              Privacy
            </Link>
            <Link href="/legal/terms" className="hover:text-fg">
              Terms
            </Link>
            <Link href="/pricing" className="hover:text-fg">
              Pricing
            </Link>
            <Link
              href="/login"
              className="rounded-md bg-brand px-3 py-1.5 text-white hover:bg-brand-hover"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">{children}</main>
      <footer className="border-t border-stroke/10 py-8 text-center text-2xs text-fg-faint">
        © {new Date().getFullYear()} Logistics Cloud — questions: support@logisticscloud.example
      </footer>
    </div>
  );
}
