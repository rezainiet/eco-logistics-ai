"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  ArrowRight,
  BarChart3,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Package,
  Phone,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  Truck,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatBDT } from "@/lib/formatters";

type CommandItem = {
  id: string;
  group: "Navigate" | "Actions" | "Orders" | "Account";
  label: string;
  hint?: string;
  icon: LucideIcon;
  shortcut?: string;
  onSelect: () => void;
  keywords?: string;
};

type CommandPaletteContextValue = { open: () => void; close: () => void; toggle: () => void };

const Ctx = React.createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("CommandPaletteProvider missing");
  return v;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const value = React.useMemo<CommandPaletteContextValue>(
    () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
    }),
    [],
  );

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isShortcut =
        (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
      if (isShortcut) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Ctx.Provider value={value}>
      {children}
      <CommandPaletteDialog open={open} onOpenChange={setOpen} />
    </Ctx.Provider>
  );
}

function CommandPaletteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const ordersQuery = trpc.orders.listOrders.useQuery(
    { phone: query.trim(), limit: 6 },
    {
      enabled: open && /^\+?\d{3,}/.test(query.trim()),
      keepPreviousData: true,
      staleTime: 30_000,
    },
  );

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Delay focus until dialog mounts.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);

  const navItems: CommandItem[] = React.useMemo(
    () => [
      {
        id: "nav:dashboard",
        group: "Navigate",
        label: "Go to Dashboard",
        icon: LayoutDashboard,
        keywords: "home overview",
        onSelect: () => {
          router.push("/dashboard");
          close();
        },
      },
      {
        id: "nav:orders",
        group: "Navigate",
        label: "Go to Orders",
        icon: Package,
        shortcut: "G O",
        onSelect: () => {
          router.push("/dashboard/orders");
          close();
        },
      },
      {
        id: "nav:fraud",
        group: "Navigate",
        label: "Go to Fraud review",
        icon: ShieldAlert,
        shortcut: "G F",
        onSelect: () => {
          router.push("/dashboard/fraud-review");
          close();
        },
      },
      {
        id: "nav:call",
        group: "Navigate",
        label: "Go to Call customer",
        icon: Phone,
        keywords: "twilio",
        onSelect: () => {
          router.push("/dashboard/call-customer");
          close();
        },
      },
      {
        id: "nav:analytics",
        group: "Navigate",
        label: "Go to Analytics",
        icon: BarChart3,
        onSelect: () => {
          router.push("/dashboard/analytics");
          close();
        },
      },
      {
        id: "nav:couriers",
        group: "Navigate",
        label: "Courier performance",
        icon: Truck,
        keywords: "pathao steadfast redx",
        onSelect: () => {
          router.push("/dashboard/analytics/couriers");
          close();
        },
      },
      {
        id: "nav:billing",
        group: "Account",
        label: "Billing & plan",
        icon: CreditCard,
        onSelect: () => {
          router.push("/dashboard/billing");
          close();
        },
      },
      {
        id: "nav:settings",
        group: "Account",
        label: "Settings",
        icon: SettingsIcon,
        onSelect: () => {
          router.push("/dashboard/settings");
          close();
        },
      },
    ],
    [router, close],
  );

  const actionItems: CommandItem[] = React.useMemo(
    () => [
      {
        id: "act:create-order",
        group: "Actions",
        label: "Create new order",
        icon: Package,
        keywords: "add new",
        onSelect: () => {
          router.push("/dashboard/orders?create=1");
          close();
        },
      },
      {
        id: "act:bulk-upload",
        group: "Actions",
        label: "Bulk upload orders (CSV)",
        icon: Package,
        keywords: "import csv",
        onSelect: () => {
          router.push("/dashboard/orders?upload=1");
          close();
        },
      },
      {
        id: "act:add-courier",
        group: "Actions",
        label: "Add a courier integration",
        icon: Truck,
        keywords: "pathao steadfast api",
        onSelect: () => {
          router.push("/dashboard/settings#couriers");
          close();
        },
      },
      {
        id: "act:signout",
        group: "Account",
        label: "Sign out",
        icon: LogOut,
        keywords: "logout",
        onSelect: () => {
          close();
          void signOut({ callbackUrl: "/login" });
        },
      },
    ],
    [router, close],
  );

  const orderItems: CommandItem[] = React.useMemo(() => {
    const orders = (ordersQuery.data?.items ?? []) as Array<{
      id: string;
      orderNumber: string;
      cod: number;
      customer: { name: string; phone: string };
    }>;
    return orders.map((o) => ({
      id: `order:${o.id}`,
      group: "Orders" as const,
      label: `Order ${o.orderNumber}`,
      hint: `${o.customer.name} · ${o.customer.phone} · ${formatBDT(o.cod)}`,
      icon: Package,
      onSelect: () => {
        router.push(`/dashboard/orders?focus=${o.id}`);
        close();
      },
    }));
  }, [ordersQuery.data, router, close]);

  const allItems = React.useMemo(
    () => [...navItems, ...actionItems, ...orderItems],
    [navItems, actionItems, orderItems],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((it) => {
      const hay = `${it.label} ${it.hint ?? ""} ${it.keywords ?? ""} ${it.group}`.toLowerCase();
      return hay.includes(q);
    });
  }, [allItems, query]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const grouped = React.useMemo(() => {
    const map = new Map<CommandItem["group"], CommandItem[]>();
    for (const it of filtered) {
      const arr = map.get(it.group) ?? [];
      arr.push(it);
      map.set(it.group, arr);
    }
    return Array.from(map.entries());
  }, [filtered]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % Math.max(filtered.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[activeIndex];
      if (item) item.onSelect();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[20%] max-w-xl translate-y-0 gap-0 overflow-hidden border-stroke/12 bg-surface-overlay p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b border-stroke/8 px-4">
          <Search className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages, actions, or paste a phone number…"
            className="h-12 w-full bg-transparent text-sm text-fg placeholder:text-fg-faint focus:outline-none"
          />
          <span className="rounded border border-stroke/12 bg-surface-raised px-1.5 py-px font-mono text-[10px] text-fg-subtle">
            ESC
          </span>
        </div>
        <div className="max-h-[420px] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-fg-subtle">
              No matches. Try different keywords.
            </div>
          ) : (
            grouped.map(([group, items]) => (
              <div key={group} className="px-2 pb-2">
                <p className="px-2 pt-2 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint">
                  {group}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {items.map((item) => {
                    const globalIndex = filtered.indexOf(item);
                    const active = globalIndex === activeIndex;
                    const Icon = item.icon;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onMouseEnter={() => setActiveIndex(globalIndex)}
                          onClick={() => item.onSelect()}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                            active
                              ? "bg-brand-subtle text-brand"
                              : "text-fg-muted hover:bg-surface-raised/60",
                          )}
                        >
                          <Icon
                            className={cn(
                              "h-4 w-4 shrink-0",
                              active ? "text-brand" : "text-fg-subtle",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{item.label}</p>
                            {item.hint ? (
                              <p className="truncate text-xs text-fg-subtle">{item.hint}</p>
                            ) : null}
                          </div>
                          {item.shortcut ? (
                            <span className="shrink-0 rounded border border-stroke/12 bg-surface-raised px-1.5 py-px font-mono text-[10px] text-fg-subtle">
                              {item.shortcut}
                            </span>
                          ) : (
                            <ArrowRight
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity",
                                active && "opacity-100",
                              )}
                            />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-stroke/8 bg-surface-base/40 px-4 py-2 text-2xs text-fg-faint">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-stroke/12 bg-surface-raised px-1 py-px font-mono text-[10px] text-fg-subtle">
                ↑↓
              </kbd>
              navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-stroke/12 bg-surface-raised px-1 py-px font-mono text-[10px] text-fg-subtle">
                ↵
              </kbd>
              select
            </span>
          </div>
          <span>
            {ordersQuery.isFetching ? "searching orders…" : `${filtered.length} matches`}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
