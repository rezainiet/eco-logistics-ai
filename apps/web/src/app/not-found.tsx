import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";

/**
 * Custom 404. Inherits the root layout (fonts + body chrome) so it
 * picks up the Cordon visual language without needing its own <html>.
 *
 * Two CTAs by intent:
 *   - "Back to landing" for visitors who hit a stale link
 *   - "Open dashboard" for signed-in merchants who fat-fingered a URL
 *     (the redirect is harmless either way — the dashboard route group
 *     enforces auth and bounces them to /login if necessary)
 */
export default function NotFound() {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(800px_320px_at_50%_-140px,hsl(var(--brand)/0.18),transparent_70%)]"
      />
      <div className="relative z-10 w-full max-w-md rounded-[22px] border border-stroke/30 bg-surface p-7 text-center shadow-elevated">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/15 text-brand">
          <Compass className="h-5 w-5" aria-hidden />
        </div>
        <p className="text-2xs uppercase tracking-[0.12em] text-fg-faint">
          404 · page not found
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-fg">
          Couldn&apos;t find that page.
        </h1>
        <p className="mt-1 text-sm text-fg-subtle">
          The link may have moved, expired, or never existed. The dashboard
          and landing are both still reachable below.
        </p>
        <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-stroke/30 px-4 text-sm font-medium text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Cordon
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex h-10 items-center justify-center rounded-md bg-brand px-4 text-sm font-semibold text-brand-fg hover:bg-brand-hover"
          >
            Open dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
