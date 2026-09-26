"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const selectCls =
  "h-10 w-full rounded-md border border-stroke/14 bg-surface-raised px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";
const textareaCls =
  "min-h-[88px] w-full rounded-md border border-stroke/14 bg-surface-raised px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

export interface ProductLike {
  id: string;
  name: string;
  description: string;
  imageAssetId: string | null;
  imageUrl: string | null;
  sku: string | null;
  price: number;
  compareAtPrice: number | null;
  currency: string;
  status: string;
  lowStockThreshold: number;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));

/**
 * Create or edit a product. `onSaved` receives the saved product — the
 * landing-page product selector uses it to return to the selection with
 * the new product ticked.
 */
export function ProductFormDialog({
  open,
  onOpenChange,
  product,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: ProductLike | null;
  onSaved?: (p: { id: string; name: string }) => void;
}) {
  const utils = trpc.useUtils();
  const editing = !!product;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [compareAt, setCompareAt] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [status, setStatus] = useState("active");
  const [threshold, setThreshold] = useState("5");
  const [initialStock, setInitialStock] = useState("0");
  const [image, setImage] = useState<{ id: string; url: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(product?.name ?? "");
    setDescription(product?.description ?? "");
    setSku(product?.sku ?? "");
    setPrice(product ? String(product.price) : "");
    setCompareAt(product?.compareAtPrice != null ? String(product.compareAtPrice) : "");
    setCurrency(product?.currency ?? "BDT");
    setStatus(product?.status && product.status !== "archived" ? product.status : "active");
    setThreshold(String(product?.lowStockThreshold ?? 5));
    setInitialStock("0");
    setImage(product?.imageAssetId ? { id: product.imageAssetId, url: product.imageUrl } : null);
    setError(null);
  }, [open, product]);

  const upload = trpc.landingPages.uploadAsset.useMutation();
  const create = trpc.products.create.useMutation();
  const update = trpc.products.update.useMutation();
  const busy = create.isPending || update.isPending;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await upload.mutateAsync({ dataUrl: await readAsDataUrl(file) });
      setImage({ id: r.id, url: r.url });
    } catch (e) {
      toast.error("Image not uploaded", (e as Error).message);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const p = num(price);
    if (!name.trim()) return setError("Enter a product name.");
    if (p === null || !Number.isFinite(p) || p < 0) return setError("Enter a valid price.");
    const cmp = num(compareAt);
    if (cmp !== null && (!Number.isFinite(cmp) || cmp <= p)) return setError("Compare-at price must be higher than the price.");
    const th = Number(threshold);
    if (!Number.isInteger(th) || th < 0) return setError("Low-stock alert must be a whole number.");
    const stock = Number(initialStock);
    if (!editing && (!Number.isInteger(stock) || stock < 0)) return setError("Stock must be a whole number.");
    const fields = {
      name: name.trim(),
      description: description.trim(),
      imageAssetId: image?.id ?? null,
      sku: sku.trim() || null,
      price: p,
      compareAtPrice: cmp,
      currency: currency as "BDT" | "USD",
      status: status as "draft" | "active" | "inactive",
      lowStockThreshold: th,
    };
    try {
      const saved = editing ? await update.mutateAsync({ id: product!.id, ...fields }) : await create.mutateAsync({ ...fields, initialStock: stock });
      toast.success(editing ? "Product updated" : "Product created", saved.name);
      await utils.products.list.invalidate();
      onOpenChange(false);
      onSaved?.({ id: saved.id, name: saved.name });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit product" : "Create product"}</DialogTitle>
          <DialogDescription>
            {editing ? "Changes apply to new orders. Past orders keep the price they were placed at." : "Products can be added to your landing pages and ordered by customers."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="flex gap-4">
            <div className="shrink-0">
              <Label className="mb-1.5 block">Image</Label>
              <div className="relative h-24 w-24 overflow-hidden rounded-lg border border-stroke/14 bg-surface-raised">
                {image?.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image.url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <button type="button" onClick={() => fileRef.current?.click()} className="flex h-full w-full flex-col items-center justify-center gap-1 text-2xs text-fg-subtle hover:text-fg">
                    {upload.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
                    Upload
                  </button>
                )}
                {image ? (
                  <button type="button" aria-label="Remove image" onClick={() => setImage(null)} className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white">
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="p-name">Name</Label>
              <Input id="p-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Premium Cotton Shirt" autoFocus />
              <Label htmlFor="p-sku" className="block pt-2">
                SKU <span className="text-fg-faint">(optional)</span>
              </Label>
              <Input id="p-sku" value={sku} maxLength={64} onChange={(e) => setSku(e.target.value)} placeholder="SHIRT-01" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-desc">Description</Label>
            <textarea id="p-desc" className={textareaCls} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="p-price">Price</Label>
              <Input id="p-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1290" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-cmp">Compare-at price</Label>
              <Input id="p-cmp" inputMode="decimal" value={compareAt} onChange={(e) => setCompareAt(e.target.value)} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-cur">Currency</Label>
              <select id="p-cur" className={selectCls} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="BDT">BDT (৳)</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-status">Status</Label>
              <select id="p-status" className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="draft">Draft</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-th">Low-stock alert at</Label>
              <Input id="p-th" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </div>
            {!editing ? (
              <div className="space-y-1.5">
                <Label htmlFor="p-stock">Stock on hand</Label>
                <Input id="p-stock" inputMode="numeric" value={initialStock} onChange={(e) => setInitialStock(e.target.value)} />
              </div>
            ) : null}
          </div>
          {editing ? <p className="text-xs text-fg-subtle">Stock is changed with “Adjust stock”, so every change is recorded.</p> : null}
          {error ? (
            <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || upload.isPending}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {editing ? "Save changes" : "Create product"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
