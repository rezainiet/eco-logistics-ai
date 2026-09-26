"use client";

import { useState } from "react";
import { Archive, Boxes, Loader2, Package, Pencil, Plus, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatMoney } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { ProductFormDialog } from "./product-form-dialog";
import { StockDialog } from "./stock-dialog";

type StockFilter = "all" | "low" | "out";

export function StockBadge({ status, available }: { status: string; available: number }) {
  if (status === "out_of_stock") return <Badge variant="destructive" className="whitespace-nowrap">Out of stock</Badge>;
  if (status === "low_stock") return <Badge variant="warning" className="whitespace-nowrap">Low stock · {available}</Badge>;
  return <Badge variant="success" className="whitespace-nowrap">In stock · {available}</Badge>;
}

export function ProductStatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge variant="info">Active</Badge>;
  if (status === "draft") return <Badge variant="outline">Draft</Badge>;
  return <Badge variant="secondary">Inactive</Badge>;
}

export function ProductsList() {
  const utils = trpc.useUtils();
  const [stock, setStock] = useState<StockFilter>("all");
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [stockId, setStockId] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const list = trpc.products.list.useQuery({ stock, search: search.trim() || undefined });
  const archive = trpc.products.archive.useMutation({
    onSuccess: () => {
      toast.success("Product archived", "It is hidden from your landing pages and can no longer be ordered.");
      void utils.products.list.invalidate();
    },
    onError: (e) => toast.error("Could not archive", e.message),
  });

  const items = list.data?.items ?? [];
  const counts = list.data?.counts;
  const editing = items.find((p) => p.id === editId) ?? null;
  const stockProduct = items.find((p) => p.id === stockId) ?? null;
  const archiving = items.find((p) => p.id === archiveId);
  const noProductsAtAll = !list.isLoading && counts?.total === 0 && !search;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operate"
        title="Products"
        description="Your catalog and stock. Add products to landing pages; orders reserve stock automatically and release it if cancelled."
        actions={
          <Button
            onClick={() => {
              setEditId(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" /> Create product
          </Button>
        }
      />

      {!noProductsAtAll ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Stock filter">
            {(
              [
                ["all", `All${counts ? ` (${counts.total})` : ""}`],
                ["low", `Low stock${counts ? ` (${counts.lowStock})` : ""}`],
                ["out", `Out of stock${counts ? ` (${counts.outOfStock})` : ""}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={stock === key}
                onClick={() => setStock(key)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  stock === key ? "border-brand/40 bg-brand/10 text-fg" : "border-stroke/12 text-fg-subtle hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or SKU" className="pl-9" aria-label="Search products" />
          </div>
        </div>
      ) : null}

      {list.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : list.isError ? (
        <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">Could not load products: {list.error.message}</p>
      ) : noProductsAtAll ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Create your first product to sell it from a landing page."
          action={
            <Button onClick={() => setFormOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Create product
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-subtle">No products match.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-stroke/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Status</th>
                <th className="px-4 py-3 font-medium">Stock</th>
                <th className="hidden px-4 py-3 font-medium lg:table-cell">Reserved</th>
                <th className="px-4 py-3 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke/8">
              {items.map((p) => (
                <tr key={p.id} className="align-middle">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-surface-raised">
                        {p.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <Boxes className="m-2.5 h-5 w-5 text-fg-faint" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{p.name}</div>
                        <div className="truncate text-xs text-fg-subtle">{p.sku ?? "No SKU"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                    {formatMoney(p.price, p.currency)}
                    {p.compareAtPrice ? <div className="text-xs text-fg-faint line-through">{formatMoney(p.compareAtPrice, p.currency)}</div> : null}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <ProductStatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3">
                    <StockBadge status={p.stockStatus} available={p.available} />
                  </td>
                  <td className="hidden px-4 py-3 tabular-nums text-fg-subtle lg:table-cell">
                    {p.reserved} of {p.onHand}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setStockId(p.id)} aria-label={`Adjust stock of ${p.name}`}>
                        <Boxes className="h-4 w-4 sm:mr-1.5" />
                        <span className="hidden sm:inline">Stock</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditId(p.id);
                          setFormOpen(true);
                        }}
                        aria-label={`Edit ${p.name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setArchiveId(p.id)} aria-label={`Archive ${p.name}`}>
                        <Archive className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ProductFormDialog open={formOpen} onOpenChange={setFormOpen} product={editId ? editing : null} />
      <StockDialog product={stockProduct} onOpenChange={(o) => !o && setStockId(null)} />
      <ConfirmDialog
        open={!!archiveId}
        onOpenChange={(o) => !o && setArchiveId(null)}
        title={`Archive ${archiving?.name ?? "product"}?`}
        description="It disappears from your landing pages and can no longer be ordered. Existing orders keep their details."
        confirmLabel="Archive"
        onConfirm={() => {
          if (archiveId) archive.mutate({ id: archiveId });
          setArchiveId(null);
        }}
      />
    </div>
  );
}
