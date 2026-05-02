"use client";

import { cloneElement, isValidElement, useId } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PHONE_RE } from "@ecom/types";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({
  orderNumber: z.string().optional(),
  customerName: z.string().min(1),
  customerPhone: z.string().regex(PHONE_RE, "Invalid phone"),
  customerAddress: z.string().min(1),
  customerDistrict: z.string().min(1),
  itemName: z.string().min(1),
  quantity: z.coerce.number().int().min(1),
  price: z.coerce.number().min(0),
  cod: z.coerce.number().min(0),
});

type FormValues = z.infer<typeof schema>;

export function CreateOrderDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void | Promise<void>;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const create = trpc.orders.createOrder.useMutation();

  async function onSubmit(values: FormValues) {
    await create.mutateAsync({
      orderNumber: values.orderNumber || undefined,
      customer: {
        name: values.customerName,
        phone: values.customerPhone,
        address: values.customerAddress,
        district: values.customerDistrict,
      },
      items: [{ name: values.itemName, quantity: values.quantity, price: values.price }],
      cod: values.cod,
    });
    reset();
    onOpenChange(false);
    await onCreated();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create order</DialogTitle>
          <DialogDescription>Add a new order to dispatch.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Customer name" error={errors.customerName?.message}>
              <Input {...register("customerName")} />
            </Field>
            <Field label="Customer phone" error={errors.customerPhone?.message}>
              <Input placeholder="+8801…" {...register("customerPhone")} />
            </Field>
            <Field label="Address" error={errors.customerAddress?.message} className="sm:col-span-2">
              <Input {...register("customerAddress")} />
            </Field>
            <Field label="District" error={errors.customerDistrict?.message}>
              <Input {...register("customerDistrict")} />
            </Field>
            <Field label="Order # (optional)" error={errors.orderNumber?.message}>
              <Input {...register("orderNumber")} />
            </Field>
            <Field label="Item name" error={errors.itemName?.message}>
              <Input {...register("itemName")} />
            </Field>
            <Field label="Quantity" error={errors.quantity?.message}>
              <Input type="number" min={1} {...register("quantity")} />
            </Field>
            <Field label="Price" error={errors.price?.message}>
              <Input type="number" step="0.01" min={0} {...register("price")} />
            </Field>
            <Field label="COD amount" error={errors.cod?.message}>
              <Input type="number" step="0.01" min={0} {...register("cod")} />
            </Field>
          </div>
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  error,
  className,
  children,
}: {
  label: string;
  error?: string;
  className?: string;
  children: React.ReactElement;
}) {
  // Associate the label with the input — improves screen-reader behavior
  // and lets Playwright's `getByLabel(...)` resolve the input reliably.
  const reactId = useId();
  const childId = (children.props as { id?: string }).id ?? reactId;
  const enhancedChild = isValidElement(children)
    ? cloneElement(children, { id: childId } as { id: string })
    : children;
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={childId}>{label}</Label>
      {enhancedChild}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
