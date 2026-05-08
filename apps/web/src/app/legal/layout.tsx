import Link from "next/link";
import type { ReactNode } from "react";
import { getBrandingSync } from "@ecom/branding";

/**
 * Wrapper for the legal pages (/legal/privacy, /legal/terms). Plain
 * marketing-style layout — no auth, no dashboard chrome — so the URLs
 * are linkable from external surfaces (Shopify Partner config form,
 * email footers, signup flow). The pages are MAX width 760px because
 * legal copy is long-form prose; wider hurts readability.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  // Centralized SaaS branding — name + support email come from the
  // single source of truth so the legal pages never drift from the
  // active brand identity. Shopify Partner reviewers explicitly check
  // that the listed support email actually exists; the previous hardcoded
  // `support@cordon.example` placeholder (RFC 2606 reserved TLD) was
  // shipped to production until this rewrite.
  const brand = getBrandingSync();
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-stroke/10 bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_14px_hsl(var(--brand))]"
            />
            <span className="text-sm font-semibold tracking-tight">{brand.name}</span>
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
        © {new Date().getFullYear()} {brand.name} — questions:{" "}
        <a href={`mailto:${brand.supportEmail}`} className="hover:text-fg">
          {brand.supportEmail}
        </a>
      </footer>
    </div>
  );
}
