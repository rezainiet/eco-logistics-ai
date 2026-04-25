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

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/dashboard") return pathname === "/dashboard" || pathname === "/dashboard/";
  return pathname === href || pathname.startsWith(`${href}/`);
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
}: {
  onNavigate?: () => void;
  fraudCount: number;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 border-b border-stroke/8 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white shadow-glow">
          L
        </span>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold text-fg">Logistics</span>
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
              const active = isActive(pathname, item.href);
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

  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-stroke/8 bg-surface-overlay md:flex md:flex-col">
        <NavList fraudCount={fraudCount} />
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
          <NavList fraudCount={fraudCount} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
