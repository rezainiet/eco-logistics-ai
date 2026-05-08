import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * Settings shell.
 *
 * Wraps every /dashboard/settings/* route with:
 *   - a single page-level header (so each section's own header can stay
 *     focused on the section, not the product area)
 *   - a left-rail navigation that's always present on desktop and
 *     collapsible on mobile (audit P0-1, P0-8)
 *   - a stable two-column layout that gives forms a comfortable
 *     reading width without ever stretching to 1400px
 *
 * The outer dashboard layout (apps/web/src/app/dashboard/layout.tsx)
 * already provides Topbar, Sidebar, BrandingProvider, etc. We don't
 * re-render any of that — this is purely the section wrapper.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      {/* Breadcrumb (audit P1-1). Sits above the section header so a
          merchant who deep-linked here from a Slack message
          immediately understands "I'm inside Settings". */}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint"
      >
        <Link
          href="/dashboard"
          className="rounded transition-colors hover:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" aria-hidden />
        <span className="text-fg-subtle">Settings</span>
      </nav>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
        <SettingsNav />
        {/*
          The content column has its own max-width so very-wide
          monitors don't produce 1400px-wide forms (which read poorly).
          `min-w-0` is essential to keep flex children from blowing
          out the row when long words like webhook URLs appear.
        */}
        <div className="min-w-0 flex-1 space-y-6 lg:max-w-3xl xl:max-w-4xl">
          {children}
        </div>
      </div>
    </div>
  );
}
