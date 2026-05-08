import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Heading } from "@/components/ui/heading";

/**
 * Settings section primitive.
 *
 * Replaces the inline `<Card><CardHeader><div className="flex items-start gap-3">...`
 * pattern that the old monolith repeated five times with five subtly
 * different spacing values (audit P1-6). All settings sections now use
 * exactly this shell so spacing rhythm and icon-tile semantics are
 * uniform.
 *
 * Compared to the old pattern this:
 *   - Drops the decorative success-tinted icon backgrounds (audit P1-7).
 *     Icons sit in a brand-tinted tile so the success token can mean
 *     "this thing succeeded" wherever it appears, without dilution.
 *   - Lets sections opt into a sticky-on-scroll header via the
 *     `sticky` prop — useful for very tall sections (couriers list,
 *     payment history) on mobile.
 */
type SettingsSectionProps = {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions in the header (e.g. "Add courier" button). */
  actions?: React.ReactNode;
  /** Stickies the header to the top of the viewport on scroll. */
  sticky?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
};

export function SettingsSection({
  icon: Icon,
  title,
  description,
  actions,
  sticky,
  className,
  bodyClassName,
  children,
}: SettingsSectionProps) {
  return (
    <section
      className={cn(
        // `overflow-hidden` keeps long inline content (webhook URLs,
        // signing secrets, courier API tokens) inside the rounded
        // border instead of poking out of the corners on narrow
        // viewports. The body itself is still scrollable horizontally
        // for tables / code blocks via `overflow-x-auto` on those
        // children.
        "overflow-hidden rounded-xl border border-stroke/10 bg-surface text-fg shadow-[0_1px_0_0_rgba(0,0,0,0.02)]",
        className,
      )}
    >
      <header
        className={cn(
          // Vertical-stack on mobile so action buttons don't shove the
          // title off-screen on 360px viewports; row at sm+ where the
          // extra width buys back inline alignment.
          "flex flex-col gap-3 border-b border-stroke/8 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:px-6 sm:py-5",
          sticky &&
            "sticky top-0 z-10 rounded-t-xl bg-surface/95 backdrop-blur-sm supports-[backdrop-filter]:bg-surface/80",
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {Icon ? (
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand"
            >
              <Icon className="h-4 w-4" />
            </span>
          ) : null}
          <div className="min-w-0 space-y-1">
            <Heading level="section" className="leading-tight">
              {title}
            </Heading>
            {description ? (
              <p className="text-sm text-fg-subtle">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
            {actions}
          </div>
        ) : null}
      </header>
      <div className={cn("px-4 py-5 sm:px-6 sm:py-6", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

/**
 * Settings page header — top of every section route. Pairs with the
 * sidebar entry from nav-config.ts. Stays terse (one sentence
 * description) so the section's actual content isn't drowned out.
 *
 * The bottom hairline matches the shared `<PageHeader>` primitive used
 * elsewhere in the dashboard so settings pages feel like they live in
 * the same family — without that line the title floated awkwardly
 * above the first SettingsSection card on every breakpoint.
 */
export function SettingsPageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-stroke/8 pb-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-1.5">
        <Heading level="page" className="leading-tight">
          {title}
        </Heading>
        {description ? (
          <p className="max-w-2xl text-sm text-fg-subtle">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
