import { Archive, Boxes, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/formatters";
import { ProductStatusBadge, StockBadge } from "./product-badges";

/** The product fields the list renders (a subset of `products.list` items). */
export interface ProductListItem {
  id: string;
  name: string;
  imageUrl?: string | null;
  sku?: string | null;
  hasVariants: boolean;
  variants: ReadonlyArray<unknown>;
  options: ReadonlyArray<{ name: string }>;
  price: number;
  compareAtPrice?: number | null;
  currency: string;
  status: string;
  stockStatus: string;
  available: number;
  reserved: number;
  onHand: number;
}

/** Second line under the product name: variant summary or SKU. */
export function productSubtitle(p: Pick<ProductListItem, "hasVariants" | "variants" | "options" | "sku">): string {
  if (p.hasVariants) {
    return `${p.variants.length} variant${p.variants.length === 1 ? "" : "s"} · ${p.options.map((o) => o.name).join(" × ")}`;
  }
  return p.sku ?? "No SKU";
}

interface ProductsMobileListProps {
  items: ReadonlyArray<ProductListItem>;
  onStock: (id: string) => void;
  onEdit: (id: string) => void;
  onArchive: (id: string) => void;
}

/**
 * Phone / tablet / small-laptop layout (< xl) for the products list. A table
 * can't fit product name + price + stock + actions in ~340px (phones), and
 * next to the sidebar it squeezes the name column to nothing (~50px at lg);
 * clipping hid price, stock and the action buttons. Each product is a card
 * instead: the full name wraps, and price, stock, status, reservations and
 * labelled actions are always visible. Two columns once the sidebar appears
 * (md); the table takes over at xl and up.
 */
export function ProductsMobileList({ items, onStock, onEdit, onArchive }: ProductsMobileListProps) {
  return (
    <ul className="grid gap-2 md:grid-cols-2 md:gap-3 xl:hidden" aria-label="Products">
      {items.map((p) => (
        <li key={p.id} className="rounded-xl border border-stroke/10 bg-surface p-3">
          <div className="flex items-start gap-3">
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-surface-raised">
              {p.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <Boxes className="m-3.5 h-5 w-5 text-fg-faint" aria-hidden />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium text-fg">{p.name}</p>
              <p className="break-words text-xs text-fg-subtle">{productSubtitle(p)}</p>
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <div>
              <dt className="text-fg-faint">Price</dt>
              <dd className="tabular-nums text-sm font-medium text-fg">
                {formatMoney(p.price, p.currency)}
                {p.compareAtPrice ? (
                  <span className="ml-1.5 text-xs font-normal text-fg-faint line-through">
                    {formatMoney(p.compareAtPrice, p.currency)}
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-fg-faint">Stock</dt>
              <dd className="mt-0.5">
                <StockBadge status={p.stockStatus} available={p.available} />
              </dd>
            </div>
            <div>
              <dt className="text-fg-faint">Status</dt>
              <dd className="mt-0.5">
                <ProductStatusBadge status={p.status} />
              </dd>
            </div>
            <div>
              <dt className="text-fg-faint">Reserved</dt>
              <dd className="tabular-nums text-fg-subtle">
                {p.reserved} of {p.onHand}
              </dd>
            </div>
          </dl>

          <div className="mt-3 flex flex-wrap justify-end gap-1.5">
            <Button size="sm" variant="outline" className="min-h-10" onClick={() => onStock(p.id)} aria-label={`Adjust stock of ${p.name}`}>
              <Boxes className="mr-1.5 h-4 w-4" aria-hidden /> Stock
            </Button>
            <Button size="sm" variant="outline" className="min-h-10" onClick={() => onEdit(p.id)} aria-label={`Edit ${p.name}`}>
              <Pencil className="mr-1.5 h-4 w-4" aria-hidden /> Edit
            </Button>
            <Button size="sm" variant="outline" className="min-h-10" onClick={() => onArchive(p.id)} aria-label={`Archive ${p.name}`}>
              <Archive className="mr-1.5 h-4 w-4" aria-hidden /> Archive
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
