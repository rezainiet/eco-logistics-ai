"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Boxes, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { MAX_PAGE_PRODUCTS } from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { ProductFormDialog } from "./product-form-dialog";
import { StockBadge } from "./products-list";

type Row = { productId: string; ctaText: string; badge: string; featured: boolean };

/**
 * Landing page → products. The page stores references plus display-only
 * overrides (button text, badge, featured); price, stock and availability
 * always come from the product itself. Saved to the draft — customers see
 * the change after the next publish.
 */
export function PageProductsPanel({
  pageId,
  expectedRevision,
  disabled,
  onSaved,
}: {
  pageId: string;
  expectedRevision: number;
  disabled?: boolean;
  /** New draft revision after saving (the editor's content saves continue from it). */
  onSaved: (draftRevision: number) => void;
}) {
  const utils = trpc.useUtils();
  const linked = trpc.landingPages.products.useQuery({ id: pageId }, { refetchOnWindowFocus: false });
  const catalog = trpc.products.list.useQuery({ status: "all" });
  const save = trpc.landingPages.setProducts.useMutation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [picking, setPicking] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!linked.data || dirty) return;
    setRows(
      linked.data.items
        .filter((i) => i.product)
        .map((i) => ({ productId: i.productId, ctaText: i.ctaText ?? "", badge: i.badge ?? "", featured: i.featured === true })),
    );
  }, [linked.data, dirty]);

  const byId = useMemo(() => new Map((catalog.data?.items ?? []).map((p) => [p.id, p])), [catalog.data]);
  const current = rows ?? [];
  const available = (catalog.data?.items ?? []).filter((p) => !current.some((r) => r.productId === p.id));

  const update = (next: Row[]) => {
    setRows(next);
    setDirty(true);
  };
  const add = (id: string) => {
    if (current.length >= MAX_PAGE_PRODUCTS || current.some((r) => r.productId === id)) return;
    update([...current, { productId: id, ctaText: "", badge: "", featured: false }]);
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...current];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    update(next);
  };
  const patch = (i: number, p: Partial<Row>) => update(current.map((r, k) => (k === i ? { ...r, ...p } : r)));

  const doSave = async () => {
    try {
      const r = await save.mutateAsync({
        id: pageId,
        expectedRevision,
        products: current.map((r) => ({ productId: r.productId, ctaText: r.ctaText.trim() || null, badge: r.badge.trim() || null, featured: r.featured })),
      });
      setDirty(false);
      onSaved(r.page.draftRevision);
      await Promise.all([utils.landingPages.products.invalidate({ id: pageId }), utils.landingPages.get.invalidate({ id: pageId }), utils.landingPages.list.invalidate()]);
      toast.success("Products saved", "Publish the page to show the change to customers.");
    } catch (e) {
      toast.error("Products not saved", (e as Error).message);
    }
  };

  if (linked.isLoading || catalog.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-stroke/10 bg-surface p-4 text-sm text-fg-subtle">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading products…
      </div>
    );
  }
  if (linked.isError || catalog.isError) {
    return <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">Could not load products: {(linked.error ?? catalog.error)?.message}</p>;
  }

  const noProducts = (catalog.data?.counts.total ?? 0) === 0;

  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-lg border border-stroke/10 bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-fg">Products on this page</div>
            <p className="text-xs text-fg-subtle">
              Shown in the page’s product section with live price and stock. Customers add them to the cart and order (cash on delivery).
            </p>
          </div>
          <span className="shrink-0 text-2xs text-fg-faint">
            {current.length}/{MAX_PAGE_PRODUCTS}
          </span>
        </div>

        {noProducts ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-stroke/14 px-4 py-6 text-center">
            <Boxes className="h-6 w-6 text-fg-faint" />
            <div className="text-sm font-medium">No products yet</div>
            <p className="text-xs text-fg-subtle">Create a product, then add it to this page.</p>
            <Button size="sm" onClick={() => setCreateOpen(true)} disabled={disabled}>
              <Plus className="mr-1.5 h-4 w-4" /> Create product
            </Button>
          </div>
        ) : current.length === 0 ? (
          <p className="rounded-md bg-surface-raised px-3 py-3 text-xs text-fg-subtle">No products on this page yet — the product section shows its custom cards.</p>
        ) : (
          <ul className="space-y-2">
            {current.map((r, i) => {
              const p = byId.get(r.productId);
              return (
                <li key={r.productId} className="rounded-lg border border-stroke/10 bg-surface-raised p-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-surface">
                      {p?.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <Boxes className="m-2.5 h-5 w-5 text-fg-faint" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p?.name ?? "Unavailable product"}</div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
                        {p ? formatMoney(p.price, p.currency) : null}
                        {p ? <StockBadge status={p.status === "active" ? p.stockStatus : "out_of_stock"} available={p.available} /> : null}
                        {p && p.status !== "active" ? <span className="text-warning">{p.status === "draft" ? "Draft — hidden" : "Inactive — can’t be ordered"}</span> : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <button
                        type="button"
                        className={cn("rounded p-1.5 hover:bg-surface", r.featured ? "text-warning" : "text-fg-faint")}
                        onClick={() => patch(i, { featured: !r.featured })}
                        aria-pressed={r.featured}
                        aria-label={r.featured ? `Unfeature ${p?.name}` : `Feature ${p?.name} (shown first)`}
                        title="Featured products are shown first"
                        disabled={disabled}
                      >
                        <Star className={cn("h-4 w-4", r.featured && "fill-current")} />
                      </button>
                      <button type="button" className="rounded p-1.5 text-fg-subtle hover:bg-surface disabled:opacity-30" onClick={() => move(i, -1)} disabled={disabled || i === 0} aria-label="Move up">
                        <ArrowUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1.5 text-fg-subtle hover:bg-surface disabled:opacity-30"
                        onClick={() => move(i, 1)}
                        disabled={disabled || i === current.length - 1}
                        aria-label="Move down"
                      >
                        <ArrowDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1.5 text-fg-subtle hover:bg-surface hover:text-danger"
                        onClick={() => update(current.filter((_, k) => k !== i))}
                        disabled={disabled}
                        aria-label={`Remove ${p?.name ?? "product"} from page`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Input
                      value={r.ctaText}
                      maxLength={40}
                      onChange={(e) => patch(i, { ctaText: e.target.value })}
                      placeholder="Button text (default: Add to cart)"
                      aria-label="Button text"
                      className="h-9 text-xs"
                      disabled={disabled}
                    />
                    <Input
                      value={r.badge}
                      maxLength={24}
                      onChange={(e) => patch(i, { badge: e.target.value })}
                      placeholder="Badge (e.g. নতুন)"
                      aria-label="Badge"
                      className="h-9 text-xs"
                      disabled={disabled}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {!noProducts ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setPicking((v) => !v)} disabled={disabled || current.length >= MAX_PAGE_PRODUCTS}>
              <Plus className="mr-1.5 h-4 w-4" /> Add products
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreateOpen(true)} disabled={disabled}>
              Create product
            </Button>
          </div>
        ) : null}

        {picking && !noProducts ? (
          <div className="rounded-lg border border-stroke/10">
            {available.length === 0 ? (
              <p className="px-3 py-3 text-xs text-fg-subtle">All your products are already on this page.</p>
            ) : (
              <ul className="max-h-64 divide-y divide-stroke/8 overflow-y-auto">
                {available.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => add(p.id)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-raised">
                      <Plus className="h-4 w-4 shrink-0 text-fg-faint" />
                      <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                      <span className="shrink-0 text-xs text-fg-subtle">{formatMoney(p.price, p.currency)}</span>
                      <StockBadge status={p.stockStatus} available={p.available} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t border-stroke/8 pt-3">
          <p className="text-2xs text-fg-faint">{dirty ? "Unsaved product changes" : "Changes go live when you publish."}</p>
          <Button size="sm" onClick={() => void doSave()} disabled={!dirty || save.isPending || disabled}>
            {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Save products
          </Button>
        </div>
      </div>

      <ProductFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(p) => {
          // Back to the selection with the new product added.
          void utils.products.list.invalidate();
          add(p.id);
          setPicking(false);
        }}
      />
    </div>
  );
}
