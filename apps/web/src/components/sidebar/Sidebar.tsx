"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  Menu,
  Package,
  Phone,
  Plug,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type NavItem = {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  badgeKey?: "fraud";
};

type NavGroup = { label: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    label: "Operate",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "Orders", href: "/dashboard/orders", icon: Package },
      {
        label: "Fraud review",
        href: "/dashboard/fraud-review",
        icon: ShieldAlert,
        badgeKey: "fraud",
      },
      { label: "Call customer", href: "/dashboard/call-customer", icon: Phone },
      { label: "Recovery", href: "/dashboard/recovery", icon: LifeBuoy },
    ],
  },
  {
    label: "Insights",
    items: [
      { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
      { label: "Behavior", href: "/dashboard/analytics/behavior", icon: Activity },
    ],
  },
  {
    label: "Connect",
    items: [
      { label: "Integrations", href: "/dashboard/integrations", icon: Plug },
    ],
  },
  {
    label: "Account",
    items: [
      { label: "Billing", href: "/dashboard/billing", icon: CreditCard },
      { label: "Settings", href: "/dashboard/settings", icon: Settings },
    ],
  },
];

/**
 * Compute the single most-specific nav href that the pathname matches.
 * "Most specific" = longest href that is either an exact match or a path
 * prefix. Prevents both "Analytics" and "Behavior" lighting up at
 * /dashboard/analytics/behavior — only "Behavior" stays active.
 *
 * Returns null when no nav item matches (e.g. on a sub-route the sidebar
 * does not surface — those routes intentionally show no active highlight).
 */
function findActiveHref(
  pathname: string | null,
  hrefs: readonly string[],
): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const href of hrefs) {
    const matches =
      href === "/dashboard"
        ? pathname === "/dashboard" || pathname === "/dashboard/"
        : pathname === href || pathname.startsWith(`${href}/`);
    if (!matches) continue;
    if (!best || href.length > best.length) best = href;
  }
  return best;
}

function NavBadge({ count, tone }: { count: number; tone: "danger" | "brand" }) {
  if (!count || count <= 0) return null;
  return (
    <span
      className={cn(
        "ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
        tone === "danger"
          ? "bg-danger-subtle text-danger"
          : "bg-brand/14 text-brand",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function NavList({
  onNavigate,
  fraudCount,
  logoDataUrl,
  businessName,
}: {
  onNavigate?: () => void;
  fraudCount: number;
  logoDataUrl: string | null;
  businessName: string | null;
}) {
  const pathname = usePathname();
  const allHrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
  const activeHref = findActiveHref(pathname, allHrefs);
  const initials = (businessName ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "L";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 border-b border-stroke/8 px-5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand text-sm font-bold text-white shadow-glow"
          aria-hidden
        >
          {logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoDataUrl}
              alt=""
              className="h-full w-full object-contain"
            />
          ) : (
            initials
          )}
        </span>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold text-fg">
            {businessName ?? "Logistics"}
          </span>
          <span className="truncate text-2xs font-medium uppercase tracking-[0.08em] text-fg-subtle">
            Merchant workspace
          </span>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {NAV.map((group) => (
          <div key={group.label} className="space-y-1">
            <p className="px-3 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = activeHref === item.href;
              const badge = item.badgeKey === "fraud" ? fraudCount : 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-brand-subtle text-brand"
                      : "text-fg-muted hover:bg-surface-raised hover:text-fg",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 transition-colors",
                      active ? "text-brand" : "text-fg-subtle group-hover:text-fg",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                  <NavBadge count={badge} tone="danger" />
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-stroke/8 px-5 py-3">
        <p className="text-2xs font-medium uppercase tracking-[0.08em] text-fg-faint">
          v1.0 · Production
        </p>
      </div>
    </div>
  );
}

export function Sidebar() {
  const [open, setOpen] = useState(false);
  const stats = trpc.fraud.getReviewStats.useQuery(
    { days: 7 },
    { refetchOnWindowFocus: false, staleTime: 60_000 },
  );
  const fraudCount =
    (stats.data?.queue?.pending ?? 0) + (stats.data?.queue?.noAnswer ?? 0);
  // Pull the merchant's branding + business name so the sidebar header shows
  // the uploaded logo and their actual business name. Same query that drives
  // <BrandingProvider>, so this adds zero extra round-trips.
  const profile = trpc.merchants.getProfile.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const logoDataUrl = profile.data?.branding?.logoDataUrl ?? null;
  const businessName = profile.data?.businessName ?? null;

  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-stroke/8 bg-surface-overlay md:flex md:flex-col">
        <NavList
          fraudCount={fraudCount}
          logoDataUrl={logoDataUrl}
          businessName={businessName}
        />
      </aside>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="fixed left-3 top-3 z-40 h-9 w-9 border-stroke/14 bg-surface text-fg hover:bg-surface-raised md:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 border-stroke/10 bg-surface-overlay p-0">
          <NavList
            fraudCount={fraudCount}
            logoDataUrl={logoDataUrl}
            businessName={businessName}
            onNavigate={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
