"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Home, LifeBuoy, Package, Settings } from "lucide-react";

const ITEMS = [
  { href: "/dashboard", icon: Home, label: "Home" },
  { href: "/dashboard/orders", icon: Package, label: "Orders" },
  { href: "/dashboard/fraud-review", icon: Bot, label: "Review" },
  { href: "/dashboard/settings", icon: Settings, label: "Settings" },
  { href: "/dashboard/getting-started", icon: LifeBuoy, label: "Help" },
] as const;

/**
 * Bottom nav for mobile. Hidden on md+ (>= 768px) so the breakpoint lines
 * up with Sidebar's `hidden md:flex` — no dead zone where neither nav
 * shows. The Sidebar already renders a Sheet drawer (hamburger) on small
 * screens; the bottom nav and drawer co-exist on mobile. The bottom nav
 * surfaces the 5 most-frequent flows; the hamburger covers the long tail
 * (settings sub-tabs, billing, integrations, admin).
 *
 * Pairs with `pb-24 md:pb-0` on the main content wrapper in
 * dashboard/layout.tsx so content is not hidden behind the floating nav.
 */
export function MobileBottomNav() {
  const pathname = usePathname() ?? "";
  // Longest-prefix-match → exactly one tab highlights even if a route
  // starts with another tab's href (e.g. /dashboard/orders/abc still
  // highlights only Orders, never Home).
  const activeHref = (() => {
    let best: string | null = null;
    for (const item of ITEMS) {
      const matches =
        item.href === "/dashboard"
          ? pathname === item.href || pathname === "/dashboard/"
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (matches && (!best || item.href.length > best.length)) best = item.href;
    }
    return best;
  })();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-stroke/12 bg-surface-overlay/95 backdrop-blur supports-[padding:env(safe-area-inset-bottom)]:pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5">
        {ITEMS.map((item) => {
          const active = activeHref === item.href;
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-2 py-2 text-[10px] font-medium transition-colors ${
                  active ? "text-fg" : "text-fg-muted hover:text-fg"
                }`}
              >
                <Icon
                  className={`h-5 w-5 ${active ? "text-brand" : ""}`}
                  aria-hidden
                />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
