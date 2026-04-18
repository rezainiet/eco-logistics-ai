"use client";

import { useMemo, useState } from "react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Plus, Upload } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateOrderDialog } from "@/components/orders/create-order-dialog";
import { BulkUploadDialog } from "@/components/orders/bulk-upload-dialog";

const STATUSES = ["pending", "confirmed", "packed", "shipped", "in_transit", "delivered", "cancelled", "rto"] as const;
type Status = (typeof STATUSES)[number];

const statusVariant: Record<Status, "default" | "secondary" | "destructive" | "success" | "warning" | "outline"> = {
  pending: "secondary",
  confirmed: "secondary",
  packed: "secondary",
  shipped: "default",
  in_transit: "default",
  delivered: "success",
  cancelled: "outline",
  rto: "destructive",
};

type OrderRow = {
  id: string;
  orderNumber: string;
  status: Status;
  cod: number;
  total: number;
  customer: { name: string; phone: string; district: string };
  courier?: string;
  riskScore: number;
  createdAt: string | Date;
};

const PAGE_SIZE = 25;

export default function OrdersPage() {
  const [status, setStatus] = useState<Status | "">("");
  const [courier, setCourier] = useState("");
  const [phone, setPhone] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const filters = useMemo(
    () => ({
      ...(status ? { status } : {}),
      ...(courier ? { courier } : {}),
      ...(phone ? { phone } : {}),
      ...(dateFrom ? { dateFrom: new Date(dateFrom) } : {}),
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [status, courier, phone, dateFrom, page]
  );

  const list = trpc.orders.listOrders.useQuery(filters);
  const utils = trpc.useUtils();

  const columns = useMemo<ColumnDef<OrderRow>[]>(
    () => [
      { header: "Order #", accessorKey: "orderNumber" },
      {
        header: "Customer",
        accessorFn: (row) => `${row.customer.name} — ${row.customer.phone}`,
        id: "customer",
      },
      { header: "District", accessorFn: (row) => row.customer.district, id: "district" },
      {
        header: "Status",
        accessorKey: "status",
        cell: ({ getValue }) => {
          const s = getValue<Status>();
          return <Badge variant={statusVariant[s]}>{s.replace("_", " ")}</Badge>;
        },
      },
      { header: "Courier", accessorFn: (row) => row.courier ?? "—", id: "courier" },
      {
        header: "COD",
        accessorKey: "cod",
        cell: ({ getValue }) => `৳ ${getValue<number>().toLocaleString()}`,
      },
      {
        header: "Risk",
        accessorKey: "riskScore",
        cell: ({ getValue }) => {
          const s = getValue<number>();
          return <Badge variant={s >= 70 ? "destructive" : s >= 40 ? "warning" : "outline"}>{s}</Badge>;
        },
      },
      {
        header: "Created",
        accessorKey: "createdAt",
        cell: ({ getValue }) => new Date(getValue<string>()).toLocaleDateString(),
      },
    ],
    []
  );

  const rows = (list.data?.items ?? []) as OrderRow[];
  const total = list.data?.total ?? 0;
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

  async function refresh() {
    await utils.orders.listOrders.invalidate();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Orders</h1>
          <p className="text-sm text-muted-foreground">{total.toLocaleString()} total</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setUploadOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Bulk upload
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create order
          </Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border bg-card p-4 md:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="f-status">Status</Label>
          <select
            id="f-status"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as Status | "");
              setPage(0);
            }}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-courier">Courier</Label>
          <Input
            id="f-courier"
            value={courier}
            onChange={(e) => {
              setCourier(e.target.value);
              setPage(0);
            }}
            placeholder="Steadfast"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-phone">Customer phone</Label>
          <Input
            id="f-phone"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setPage(0);
            }}
            placeholder="+8801…"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-date">From date</Label>
          <Input
            id="f-date"
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(0);
            }}
          />
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id}>
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {list.isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No orders match your filters.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <CreateOrderDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh} />
      <BulkUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} onUploaded={refresh} />
    </div>
  );
}
