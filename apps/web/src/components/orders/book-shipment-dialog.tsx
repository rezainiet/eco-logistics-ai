"use client";

import { useMemo, useState } from "react";
import { Loader2, PackageCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";

const SUPPORTED_COURIERS = [
  { value: "pathao", label: "Pathao" },
  { value: "steadfast", label: "Steadfast" },
  { value: "redx", label: "RedX" },
] as const;

type CourierValue = (typeof SUPPORTED_COURIERS)[number]["value"];

export function BookShipmentDialog({
  open,
  onOpenChange,
  orderIds,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orderIds: string[];
  onComplete: () => void | Promise<void>;
}) {
  const [courier, setCourier] = useState<CourierValue>("pathao");
  const [weight, setWeight] = useState<string>("0.5");

  const bulk = trpc.orders.bulkBookShipment.useMutation();

  const weightNum = useMemo(() => {
    const n = Number(weight);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [weight]);

  async function submit() {
    if (orderIds.length === 0) return;
    try {
      const res = await bulk.mutateAsync({
        orderIds,
        courier,
        ...(weightNum ? { weight: weightNum } : {}),
      });
      if (res.succeeded > 0) {
        toast.success(
          `${res.succeeded} shipment${res.succeeded === 1 ? "" : "s"} booked`,
          res.failed > 0
            ? `${res.failed} failed — check per-order errors below.`
            : `Tracking numbers saved. Orders moved to Shipped.`,
        );
      }
      if (res.failed > 0 && res.succeeded === 0) {
        const firstError = res.results.find((r) => !r.ok);
        toast.error(
          "Shipment booking failed",
          firstError && !firstError.ok ? firstError.error : "No orders were booked.",
        );
      } else if (res.failed > 0) {
        toast.info(`${res.failed} orders skipped`, "Already shipped, delivered, or in an invalid state.");
      }
      await onComplete();
      if (res.failed === 0) {
        onOpenChange(false);
      }
    } catch (err) {
      toast.error("Booking request failed", (err as Error).message);
    }
  }

  const results = bulk.data;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) bulk.reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-xl border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-brand" />
            Book courier pickup
          </DialogTitle>
          <DialogDescription className="text-[#9CA3AF]">
            Create an AWB for {orderIds.length} order{orderIds.length === 1 ? "" : "s"}. Orders in
            pending / confirmed / packed state will be shipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bk-courier">Courier</Label>
              <Select value={courier} onValueChange={(v) => setCourier(v as CourierValue)}>
                <SelectTrigger id="bk-courier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_COURIERS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bk-weight">Weight (kg, optional)</Label>
              <Input
                id="bk-weight"
                type="number"
                step="0.1"
                min="0.1"
                max="30"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                className="border-[rgba(209,213,219,0.15)] bg-[#111318] text-[#F3F4F6]"
              />
            </div>
          </div>

          {results && results.results.some((r) => !r.ok) && (
            <div className="max-h-48 overflow-auto rounded-md border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.06)] p-3 text-xs">
              <p className="mb-1 font-semibold text-[#F87171]">
                {results.failed} of {results.total} failed
              </p>
              <ul className="space-y-1 text-[#D1D5DB]">
                {results.results
                  .filter((r): r is typeof r & { ok: false } => !r.ok)
                  .slice(0, 12)
                  .map((r) => (
                    <li key={r.orderId} className="font-mono">
                      {r.orderId.slice(-6)}: {r.error}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-[rgba(209,213,219,0.15)] bg-transparent text-[#F3F4F6] hover:bg-[#111318]"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={bulk.isLoading || orderIds.length === 0}
            className="bg-brand text-brand-fg hover:bg-brand-hover"
          >
            {bulk.isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Booking {orderIds.length}…
              </>
            ) : (
              <>Book {orderIds.length} pickup{orderIds.length === 1 ? "" : "s"}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
