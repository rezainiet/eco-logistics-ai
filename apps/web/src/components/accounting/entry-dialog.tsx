"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { selectCls } from "@/components/commerce/product-form-dialog";

export type EntryType = "income" | "expense";

export interface EditableEntry {
  id: string;
  type: EntryType;
  category: string;
  amount: number;
  occurredOn: string;
  description: string;
  reference: string;
}

/** Today in Bangladesh as YYYY-MM-DD (accounting days are Asia/Dhaka). */
export function dhakaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Add or edit one income/expense entry: category, amount, date, description.
 * A fresh idempotency key per opened form means a double-click or a retried
 * request saves one entry.
 */
export function EntryDialog({
  open,
  onOpenChange,
  type,
  entry,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  type: EntryType;
  entry?: EditableEntry | null;
}) {
  const utils = trpc.useUtils();
  const categories = trpc.finance.categories.useQuery(undefined, { staleTime: Infinity });
  const options = (type === "income" ? categories.data?.income : categories.data?.expense) ?? [];
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(dhakaToday());
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [key, setKey] = useState(newKey());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCategory(entry?.category ?? "");
    setAmount(entry ? String(entry.amount) : "");
    setDate(entry?.occurredOn ?? dhakaToday());
    setDescription(entry?.description ?? "");
    setReference(entry?.reference ?? "");
    setKey(newKey());
    setError(null);
  }, [open, entry]);

  const done = (title: string) => {
    toast.success(title);
    void utils.finance.invalidate();
    onOpenChange(false);
  };
  const create = trpc.finance.create.useMutation({ onSuccess: () => done(type === "income" ? "Income saved" : "Expense saved") });
  const update = trpc.finance.update.useMutation({ onSuccess: () => done("Entry updated") });
  const busy = create.isPending || update.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = Number(amount);
    if (!category) return setError("Choose a category.");
    if (!amount.trim() || !Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than 0.");
    if (Math.round(value * 100) !== Number((value * 100).toFixed(6))) return setError("Use at most 2 decimal places.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError("Choose a date.");
    const fields = { category, amount: value, occurredOn: date, description: description.trim(), reference: reference.trim() };
    const onError = (err: { message: string }) => setError(err.message);
    if (entry) update.mutate({ id: entry.id, ...fields }, { onError });
    else create.mutate({ type, ...fields, idempotencyKey: key }, { onError });
  };

  const noun = type === "income" ? "income" : "expense";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{entry ? `Edit ${noun}` : `Add ${noun}`}</DialogTitle>
          <DialogDescription>
            {type === "income"
              ? "Income that is not a ConfirmX order. Delivered orders are counted automatically."
              : "Amounts are in Taka (৳)."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="fe-category">Category</Label>
            <select id="fe-category" className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="" disabled>
                Choose…
              </option>
              {options.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fe-amount">Amount (৳)</Label>
              <Input id="fe-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5000" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fe-date">Date</Label>
              <Input id="fe-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fe-desc">Description</Label>
            <Input id="fe-desc" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fe-ref">
              Reference <span className="text-fg-faint">(optional)</span>
            </Label>
            <Input id="fe-ref" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="Invoice or bill number" />
          </div>
          {category === "product_cost" || category === "courier" ? (
            <p className="rounded-md bg-info-subtle px-3 py-2 text-xs text-info">
              Costs recorded on orders are already counted. Add only {category === "courier" ? "courier" : "product"} costs that were not recorded on an order.
            </p>
          ) : null}
          {error ? <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
