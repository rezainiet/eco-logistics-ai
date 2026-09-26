"use client";

import { useState } from "react";
import { Boxes, ExternalLink, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatMoney } from "@/lib/formatters";

type Commerce = {
  lineItems: Array<{ name: string; sku: string | null; quantity: number; price: number; lineTotal: number; productId: string | null; imageUrl: string | null }>;
  currency: string;
  subtotal: number | null;
  deliveryCharge: number | null;
  deliveryArea: string | null;
  customerNote: string | null;
  customerEmail: string | null;
  source: string;
  sourceProvider: string | null;
  landing: { pageId: string; slug: string | null; revision: number | null; locale: string | null } | null;
  inventory: { state: string; note: string | null } | null;
};

const SOURCE_LABEL: Record<string, string> = {
  landing_page: "Landing page",
  dashboard: "Dashboard",
  bulk_upload: "CSV upload",
  api: "API",
  webhook: "Store integration",
  system: "System",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirm",
  packed: "Mark packed",
  shipped: "Mark shipped",
  in_transit: "In transit",
  delivered: "Mark delivered",
  cancelled: "Cancel order",
  rto: "Mark returned (RTO)",
};

const STOCK_LABEL: Record<string, { label: string; variant: "info" | "secondary" | "success" }> = {
  reserved: { label: "Stock reserved", variant: "info" },
  released: { label: "Stock released", variant: "secondary" },
  fulfilled: { label: "Stock shipped", variant: "success" },
};

export function sourceLabel(source: string | null | undefined, slug?: string | null): string {
  const base = SOURCE_LABEL[source ?? "dashboard"] ?? "Dashboard";
  return source === "landing_page" && slug ? `${base} · ${slug}` : base;
}

/**
 * Order detail — what was bought (price at order time), where it came
 * from, what it did to stock, and the status actions the merchant may take
 * (same transition rules the API enforces).
 */
export function OrderCommercePanel({
  order,
}: {
  order: {
    id: string;
    status: string;
    nextStatuses?: string[];
    createdAt?: string | Date | null;
    customer: { name: string; phone: string; address: string; district: string };
    commerce?: Commerce;
  };
}) {
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState<string | null>(null);
  const update = trpc.orders.updateOrder.useMutation({
    onSuccess: async (r) => {
      toast.success("Order updated", `Status: ${r.status.replace("_", " ")}`);
      await Promise.all([utils.orders.getOrder.invalidate({ id: order.id }), utils.orders.listOrders.invalidate(), utils.products.list.invalidate()]);
    },
    onError: (e) => toast.error("Order not updated", e.message),
  });
  const c = order.commerce;
  if (!c) return null;
  const money = (v: number) => formatMoney(v, c.currency);
  const stock = c.inventory ? STOCK_LABEL[c.inventory.state] : null;
  const actions = (order.nextStatuses ?? []).filter((s) => s !== order.status);

  return (
    <div className="space-y-4 rounded-lg border border-stroke/10 bg-surface-raised p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{sourceLabel(c.source, c.landing?.slug)}</Badge>
          {stock ? <Badge variant={stock.variant}>{stock.label}</Badge> : null}
        </div>
        {order.createdAt ? <span className="text-xs text-fg-subtle">{new Date(order.createdAt).toLocaleString()}</span> : null}
      </div>

      {c.landing ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-fg-subtle">
          From landing page <span className="font-mono text-fg">{c.landing.slug ?? "—"}</span>
          {c.landing.revision ? <> · revision {c.landing.revision}</> : null}
          {c.landing.locale ? <> · {c.landing.locale === "bn" ? "বাংলা" : "English"}</> : null}
          <a href={`/dashboard/landing-pages/${c.landing.pageId}`} className="ml-1 inline-flex items-center gap-0.5 text-brand hover:underline">
            Open page <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      ) : null}

      <ul className="divide-y divide-stroke/8">
        {c.lineItems.map((i, k) => (
          <li key={`${i.productId ?? i.name}-${k}`} className="flex items-center gap-3 py-2">
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-surface">
              {i.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={i.imageUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <Boxes className="m-2.5 h-5 w-5 text-fg-faint" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{i.name}</div>
              <div className="text-xs text-fg-subtle">
                {i.quantity} × {money(i.price)}
                {i.sku ? ` · ${i.sku}` : ""}
              </div>
            </div>
            <div className="shrink-0 font-medium tabular-nums">{money(i.lineTotal)}</div>
          </li>
        ))}
      </ul>

      {c.subtotal !== null ? (
        <dl className="space-y-1 border-t border-stroke/8 pt-2 text-xs">
          <div className="flex justify-between">
            <dt className="text-fg-subtle">Subtotal</dt>
            <dd className="tabular-nums">{money(c.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-subtle">Delivery{c.deliveryArea ? ` · ${c.deliveryArea}` : ""}</dt>
            <dd className="tabular-nums">{money(c.deliveryCharge ?? 0)}</dd>
          </div>
          <div className="flex justify-between text-sm font-semibold">
            <dt>Total (cash on delivery)</dt>
            <dd className="tabular-nums">{money((c.subtotal ?? 0) + (c.deliveryCharge ?? 0))}</dd>
          </div>
        </dl>
      ) : null}

      <div className="space-y-0.5 border-t border-stroke/8 pt-2 text-xs">
        <div className="font-medium text-fg">{order.customer.name}</div>
        <div className="text-fg-subtle">{order.customer.phone}</div>
        <div className="whitespace-pre-line text-fg-subtle">
          {order.customer.address}, {order.customer.district}
        </div>
        {c.customerEmail ? <div className="text-fg-subtle">{c.customerEmail}</div> : null}
        {c.customerNote ? <div className="mt-1 rounded bg-surface px-2 py-1 text-fg-muted">“{c.customerNote}”</div> : null}
      </div>

      {c.inventory?.note ? (
        <p className="rounded bg-warning-subtle px-2 py-1 text-xs text-warning">
          Stock could not be re-reserved after restoring this order (not enough stock). Restock the product, then update the order.
        </p>
      ) : null}

      {actions.length ? (
        <div className="flex flex-wrap gap-2 border-t border-stroke/8 pt-3">
          {actions.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === "cancelled" || s === "rto" ? "outline" : "default"}
              disabled={update.isPending}
              onClick={() => (s === "cancelled" || s === "rto" ? setConfirm(s) : update.mutate({ id: order.id, status: s as never }))}
            >
              {update.isPending && update.variables?.status === s ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {STATUS_LABEL[s] ?? s}
            </Button>
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "rto" ? "Mark as returned?" : "Cancel this order?"}
        description={
          c.inventory?.state === "reserved"
            ? "The reserved stock goes back to available stock (recorded in each product’s stock history)."
            : "This can’t be undone from here."
        }
        confirmLabel={confirm === "rto" ? "Mark returned" : "Cancel order"}
        onConfirm={() => {
          if (confirm) update.mutate({ id: order.id, status: confirm as never });
          setConfirm(null);
        }}
      />
    </div>
  );
}
