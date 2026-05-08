"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { SETTINGS_NAV, type SettingsSection } from "./nav-config";

/**
 * Settings left-rail navigation (desktop) + collapsible header
 * (mobile).
 *
 * This is the structural answer to audit P0-1 (no persistent IA) and
 * P0-8 (the old 6-tab pill nav couldn't fit on 360px viewports). On
 * desktop it pins to the left of the content. On mobile it collapses
 * to a single-row "current section + dropdown" header that respects
 * the bottom-nav and avoids horizontal scroll.
 *
 * Active highlight uses the same most-specific-prefix logic as the
 * top-level Sidebar, so a route like /dashboard/settings/integrations/issues
 * highlights "Integrations" rather than nothing.
 */

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function findActiveSection(pathname: string | null): SettingsSection | null {
  if (!pathname) return null;
  const all = SETTINGS_NAV.flatMap((g) => g.items);
  let best: SettingsSection | null = null;
  for (const item of all) {
    if (!isActive(pathname, item.href)) continue;
    if (!best || item.href.length > best.href.length) best = item;
  }
  return best;
}

export function SettingsNav() {
  const pathname = usePathname();
  const active = findActiveSection(pathname);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Close the mobile drawer on route change. Without this, tapping a
  // link in the dropdown leaves the dropdown open over the new page.
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Desktop left-rail. Sticky so it stays visible while a long
          section's form scrolls under the topbar. */}
      <aside
        aria-label="Settings sections"
        className="sticky top-6 hidden h-fit w-60 shrink-0 self-start lg:block"
      >
        <DesktopList active={active} pathname={pathname} />
      </aside>

      {/* Mobile + tablet header — collapses to one row showing the
          current section, expands to the full grouped nav on tap. */}
      <div className="lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-lg border border-stroke/10 bg-surface px-4 py-3 text-left text-sm font-medium text-fg shadow-[0_1px_0_0_rgba(0,0,0,0.02)]",
            "focus:outline-none focus:ring-2 focus:ring-brand/40",
          )}
          aria-expanded={mobileOpen}
          aria-controls="settings-mobile-nav"
        >
          <span className="flex items-center gap-2.5">
            {active?.icon ? (
              <active.icon className="h-4 w-4 text-fg-subtle" aria-hidden />
            ) : null}
            <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
              Settings
            </span>
            <span aria-hidden className="text-fg-faint">
              /
            </span>
            <span className="text-fg">
              {active?.label ?? "Choose a section"}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-fg-subtle transition-transform",
              mobileOpen && "rotate-180",
            )}
          />
        </button>
        {mobileOpen ? (
          <div
            id="settings-mobile-nav"
            className="mt-2 overflow-hidden rounded-lg border border-stroke/10 bg-surface shadow-lg"
          >
            <MobileList active={active} pathname={pathname} />
          </div>
        ) : null}
      </div>
    </>
  );
}

function DesktopList({
  active,
  pathname,
}: {
  active: SettingsSection | null;
  pathname: string | null;
}) {
  return (
    <nav className="space-y-5">
      {SETTINGS_NAV.map((group) => (
        <div key={group.key} className="space-y-1.5">
          <p className="px-3 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint">
            {group.label}
          </p>
          {group.items.map((item) => {
            const Icon = item.icon;
            const itemActive =
              active?.key === item.key || isActive(pathname, item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={itemActive ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  itemActive
                    ? "bg-brand-subtle text-brand"
                    : "text-fg-muted hover:bg-surface-raised hover:text-fg",
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    itemActive
                      ? "text-brand"
                      : "text-fg-subtle group-hover:text-fg",
                  )}
                  aria-hidden
                />
                <span className="truncate">{item.label}</span>
                {item.badge ? (
                  <span className="ml-auto rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function MobileList({
  active,
  pathname,
}: {
  active: SettingsSection | null;
  pathname: string | null;
}) {
  return (
    <ul className="divide-y divide-stroke/8">
      {SETTINGS_NAV.flatMap((g) =>
        g.items.map((item) => {
          const Icon = item.icon;
          const itemActive =
            active?.key === item.key || isActive(pathname, item.href);
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 text-sm transition-colors",
                  itemActive
                    ? "bg-brand-subtle/50 text-brand"
                    : "text-fg-muted hover:bg-surface-raised hover:text-fg",
                )}
                aria-current={itemActive ? "page" : undefined}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    itemActive ? "text-brand" : "text-fg-subtle",
                  )}
                  aria-hidden
                />
                <span className="flex-1 truncate font-medium">
                  {item.label}
                </span>
                {item.badge ? (
                  <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        }),
      )}
    </ul>
  );
}
