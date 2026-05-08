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
    <div className="space-y-5 md:space-y-6">
      {/* Breadcrumb (audit P1-1). Sits above the section header so a
          merchant who deep-linked here from a Slack message
          immediately understands "I'm inside Settings". */}
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint"
      >
        <Link
          href="/dashboard"
          className="rounded truncate transition-colors hover:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate text-fg-subtle">Settings</span>
      </nav>

      {/*
        Two-column shell:
          - Mobile / tablet (<lg): nav stacks above content with a
            tighter gap so the collapsed dropdown sits comfortably
            above the page header instead of floating in whitespace.
          - lg+ (≥1024px): pinned left rail with a generous lg:gap-10
            rhythm. We DO NOT cap content width at lg — at exactly
            1024px the inner column is already constrained by
            (sidebar 240 + nav 240 + gaps), so adding another cap
            squeezed forms into ~640px and produced unbalanced
            whitespace. The cap kicks in at xl/2xl where there's
            actually room to overshoot.
      */}
      <div className="flex flex-col gap-5 lg:flex-row lg:gap-8 xl:gap-10">
        <SettingsNav />
        {/*
          Content column. `min-w-0` is essential to keep flex children
          from blowing out the row when long strings appear (webhook
          URLs, signing secrets, masked API keys). The progressive
          max-width caps prevent forms from stretching to 1100px on
          ultrawide monitors — which reads poorly — without starving
          the column on smaller laptops.
        */}
        <div className="min-w-0 flex-1 space-y-5 md:space-y-6 xl:max-w-4xl 2xl:max-w-5xl">
          {children}
        </div>
      </div>
    </div>
  );
}
