"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  BarChart3,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Phone,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Orders", href: "/dashboard/orders", icon: Package },
  { label: "Fraud review", href: "/dashboard/fraud-review", icon: ShieldAlert },
  { label: "Call customer", href: "/dashboard/call-customer", icon: Phone },
  { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { label: "Billing", href: "/dashboard/billing", icon: CreditCard },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/dashboard") return pathname === "/dashboard" || pathname === "/dashboard/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ onNavigate, userLabel }: { onNavigate?: () => void; userLabel: string }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[rgba(209,213,219,0.08)] px-5 py-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0084D4] text-sm font-bold text-white">
          L
        </span>
        <span className="text-sm font-semibold text-[#F3F4F6]">Logistics</span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-[rgba(0,132,212,0.12)] text-[#0084D4]"
                  : "text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[rgba(209,213,219,0.08)] px-3 py-3">
        <div className="mb-2 px-3 text-[11px] uppercase tracking-[0.4px] text-[#6B7280]">
          Signed in
        </div>
        <p className="mb-2 truncate px-3 text-xs text-[#9CA3AF]">{userLabel}</p>
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 px-3 py-2 text-sm text-[#EF4444] hover:bg-[rgba(239,68,68,0.1)] hover:text-[#FCA5A5]"
          onClick={() => {
            onNavigate?.();
            void signOut({ callbackUrl: "/login" });
          }}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </div>
  );
}

export function Sidebar({ userLabel }: { userLabel: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-[rgba(209,213,219,0.08)] bg-[#111318] md:flex md:flex-col">
        <NavList userLabel={userLabel} />
      </aside>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="fixed left-3 top-3 z-40 h-9 w-9 border-[rgba(209,213,219,0.15)] bg-[#1A1D2E] text-[#F3F4F6] hover:bg-[#232738] md:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <NavList userLabel={userLabel} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
