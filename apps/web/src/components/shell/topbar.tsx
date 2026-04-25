"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Bell,
  ChevronRight,
  CreditCard,
  LogOut,
  Search,
  Settings as SettingsIcon,
  UserCircle2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initialsFromLabel } from "@/lib/formatters";
import { useCommandPalette } from "@/components/shell/command-palette";
import {
  NotificationsDrawer,
  useNotificationCount,
} from "@/components/shell/notifications-drawer";

type Crumb = { label: string; href?: string };

const ROUTE_MAP: Array<{ pattern: RegExp; crumbs: (m: RegExpMatchArray) => Crumb[] }> = [
  { pattern: /^\/dashboard\/?$/, crumbs: () => [{ label: "Dashboard" }] },
  {
    pattern: /^\/dashboard\/orders\/?$/,
    crumbs: () => [{ label: "Dashboard", href: "/dashboard" }, { label: "Orders" }],
  },
  {
    pattern: /^\/dashboard\/fraud-review\/?$/,
    crumbs: () => [{ label: "Dashboard", href: "/dashboard" }, { label: "Fraud review" }],
  },
  {
    pattern: /^\/dashboard\/call-customer\/?$/,
    crumbs: () => [{ label: "Dashboard", href: "/dashboard" }, { label: "Call customer" }],
  },
  {
    pattern: /^\/dashboard\/analytics\/?$/,
    crumbs: () => [{ label: "Dashboard", href: "/dashboard" }, { label: "Analytics" }],
  },
  {
    pattern: /^\/dashboard\/analytics\/couriers\/?$/,
    crumbs: () => [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Analytics", href: "/dashboard/analytics" },
      { label: "Couriers" },
    ],
  },
  {
    pattern: /^\/dashboard\/billing\/?$/,
    crumbs: () => [{ label: "Dashboard", href: "/dashboard" }, { label: "Billing" }],
  },
  {
    pattern: /^\/dashboard\/settings\/?$/,
    crumbs: () => [{ label: "Dashboard", href: "/dashboard" }, { label: "Settings" }],
  },
  {
    pattern: /^\/admin\/billing\/?$/,
    crumbs: () => [{ label: "Admin", href: "/admin/billing" }, { label: "Billing" }],
  },
];

function resolveCrumbs(pathname: string | null): Crumb[] {
  if (!pathname) return [{ label: "Dashboard" }];
  for (const entry of ROUTE_MAP) {
    const match = pathname.match(entry.pattern);
    if (match) return entry.crumbs(match);
  }
  const parts = pathname.split("/").filter(Boolean);
  return parts.map((p, i) => ({
    label: p.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    href: i === parts.length - 1 ? undefined : "/" + parts.slice(0, i + 1).join("/"),
  }));
}

export function Topbar({ userLabel }: { userLabel: string }) {
  const pathname = usePathname();
  const crumbs = resolveCrumbs(pathname);
  const initials = initialsFromLabel(userLabel);
  const palette = useCommandPalette();
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);
  const notificationCount = useNotificationCount();

  return (
    <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-stroke/8 bg-surface-base/75 px-4 backdrop-blur-md md:px-6">
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-1.5 pl-10 md:pl-0"
      >
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {crumbs.map((c, i) => (
            <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-hidden />
              ) : null}
              {c.href ? (
                <Link
                  href={c.href}
                  className="truncate text-fg-subtle transition-colors hover:text-fg"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="truncate font-medium text-fg">{c.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => palette.open()}
          aria-label="Open command palette"
          className="group hidden h-9 items-center gap-2 rounded-lg border border-stroke/12 bg-surface px-3 text-xs text-fg-subtle transition-colors hover:border-stroke/24 hover:text-fg md:inline-flex"
        >
          <Search className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden lg:inline">Search orders, actions…</span>
          <span className="ml-2 rounded border border-stroke/12 bg-surface-raised px-1.5 py-px font-mono text-[10px] text-fg-subtle group-hover:text-fg">
            ⌘K
          </span>
        </button>
        <button
          type="button"
          onClick={() => palette.open()}
          aria-label="Open command palette"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-stroke/12 bg-surface text-fg-subtle transition-colors hover:border-stroke/24 hover:text-fg md:hidden"
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={
            notificationCount > 0
              ? `Notifications, ${notificationCount} unread`
              : "Notifications"
          }
          onClick={() => setNotificationsOpen(true)}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-stroke/12 bg-surface text-fg-subtle transition-colors hover:border-stroke/24 hover:text-fg"
        >
          <Bell className="h-4 w-4" aria-hidden />
          {notificationCount > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold leading-none text-white shadow-card">
              {notificationCount > 9 ? "9+" : notificationCount}
            </span>
          ) : null}
        </button>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border border-stroke/12 bg-surface px-1.5 py-1 pr-2 text-xs font-medium text-fg transition-colors hover:border-stroke/24"
            aria-label="Open account menu"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand/14 text-[11px] font-semibold text-brand">
              {initials}
            </span>
            <span className="hidden max-w-[140px] truncate text-fg-muted md:inline">
              {userLabel}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-fg">
            <div className="space-y-0.5">
              <p className="truncate text-sm font-semibold">{userLabel}</p>
              <p className="text-2xs font-normal uppercase tracking-[0.08em] text-fg-subtle">
                Merchant account
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings">
              <UserCircle2 className="h-4 w-4" />
              Profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/billing">
              <CreditCard className="h-4 w-4" />
              Billing
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings">
              <SettingsIcon className="h-4 w-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              void signOut({ callbackUrl: "/login" });
            }}
            className="text-danger focus:bg-danger-subtle focus:text-danger"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <NotificationsDrawer
        open={notificationsOpen}
        onOpenChange={setNotificationsOpen}
        unreadCount={notificationCount}
      />
    </div>
  );
}
