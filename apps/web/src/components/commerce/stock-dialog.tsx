"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { selectCls } from "./product-form-dialog";

const MOVEMENT_LABEL: Record<string, string> = {
  INITIAL_STOCK: "Initial stock",
  RESTOCK: "Restock",
  ORDER_RESERVED: "Reserved by order",
  ORDER_CANCELLED: "Order cancelled — released",
  ORDER_FULFILLED: "Order delivered",
  MANUAL_ADJUSTMENT: "Manual adjustment",
  RETURNED: "Returned",
};

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Stock changes (always through the ledger) and the product's movement history. */
export function StockDialog({
  product,
  onOpenChange,
}: {
  product: { id: string; name: string; onHand: number; reserved: number; available: number } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [type, setType] = useState<"RESTOCK" | "MANUAL_ADJUSTMENT" | "RETURNED">("RESTOCK");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = !!product;
  const movements = trpc.products.movements.useQuery({ id: product?.id ?? "", limit: 50 }, { enabled: open });
  const adjust = trpc.products.adjustStock.useMutation();

  useEffect(() => {
    if (open) {
      setType("RESTOCK");
      setQty("");
      setReason("");
      setError(null);
    }
  }, [open, product?.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const n = Number(qty);
    if (!Number.isInteger(n) || n === 0) return setError(type === "MANUAL_ADJUSTMENT" ? "Enter a whole number, e.g. 5 or -2." : "Enter a whole number of units.");
    if (type !== "MANUAL_ADJUSTMENT" && n < 0) return setError("Use Manual adjustment to remove units.");
    try {
      const p = await adjust.mutateAsync({ id: product!.id, type, delta: n, reason: reason.trim() || undefined });
      toast.success("Stock updated", `${p.name}: ${p.available} available`);
      setQty("");
      setReason("");
      await Promise.all([utils.products.list.invalidate(), utils.products.movements.invalidate({ id: product!.id })]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const current = product ? (utils.products.list.getData()?.items.find((p) => p.id === product.id) ?? product) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Stock — {product?.name}</DialogTitle>
          <DialogDescription>Available = on hand − reserved by open orders. Every change is recorded below.</DialogDescription>
        </DialogHeader>
        {current ? (
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              ["On hand", current.onHand],
              ["Reserved", current.reserved],
              ["Available", current.available],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-stroke/10 bg-surface-raised px-3 py-2">
                <div className="text-2xs uppercase tracking-wide text-fg-faint">{label}</div>
                <div className="text-lg font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </div>
        ) : null}
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
            <div className="space-y-1.5">
              <Label htmlFor="s-type">Change</Label>
              <select id="s-type" className={selectCls} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="RESTOCK">Restock (add units)</option>
                <option value="RETURNED">Customer return (add units)</option>
                <option value="MANUAL_ADJUSTMENT">Manual adjustment (+ / −)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-qty">Units</Label>
              <Input id="s-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={type === "MANUAL_ADJUSTMENT" ? "-2" : "10"} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-reason">
              Note <span className="text-fg-faint">(optional)</span>
            </Label>
            <Input id="s-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. new shipment, damaged units" />
          </div>
          {error ? (
            <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={adjust.isPending}>
              {adjust.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Update stock
            </Button>
          </DialogFooter>
        </form>
        <div>
          <h3 className="mb-2 text-sm font-medium">History</h3>
          {movements.isLoading ? (
            <p className="text-sm text-fg-subtle">Loading…</p>
          ) : (movements.data ?? []).length === 0 ? (
            <p className="text-sm text-fg-subtle">No stock movements yet.</p>
          ) : (
            <ul className="divide-y divide-stroke/8 rounded-lg border border-stroke/10 text-sm">
              {movements.data!.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-medium">{MOVEMENT_LABEL[m.type] ?? m.type}</div>
                    <div className="truncate text-xs text-fg-subtle">
                      {m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}
                      {m.reason ? ` · ${m.reason}` : ""}
                      {m.orderId ? ` · order …${m.orderId.slice(-6)}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs tabular-nums">
                    {m.onHandDelta ? <div>on hand {signed(m.onHandDelta)}</div> : null}
                    {m.reservedDelta ? <div>reserved {signed(m.reservedDelta)}</div> : null}
                    <div className="text-fg-faint">
                      → {m.onHandAfter} / {m.reservedAfter}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
