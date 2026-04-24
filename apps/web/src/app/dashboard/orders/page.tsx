"use client";

import { useMemo, useState } from "react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  PackageCheck,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Truck,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { CreateOrderDialog } from "@/components/orders/create-order-dialog";
import { BulkUploadDialog } from "@/components/orders/bulk-upload-dialog";
import { BookShipmentDialog } from "@/components/orders/book-shipment-dialog";
import { TrackingTimelineDrawer } from "@/components/orders/tracking-timeline-drawer";

const STATUSES = [
  "pending",
  "confirmed",
  "packed",
  "shipped",
  "in_transit",
  "delivered",
  "cancelled",
  "rto",
] as const;
type Status = (typeof STATUSES)[number];

const statusClass: Record<Status, string> = {
  pending: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
  confirmed: "bg-[rgba(59,130,246,0.15)] text-[#60A5FA]",
  packed: "bg-[rgba(59,130,246,0.15)] text-[#60A5FA]",
  shipped: "bg-[rgba(14,165,233,0.15)] text-[#38BDF8]",
  in_transit: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
  delivered: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
  cancelled: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
  rto: "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
};

function riskClass(score: number): string {
  if (score >= 70) return "bg-[rgba(239,68,68,0.15)] text-[#F87171]";
  if (score >= 40) return "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]";
  return "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]";
}

type TrackingBadge = { label: string; className: string; icon: typeof Clock };
const FALLBACK_BADGE: TrackingBadge = {
  label: "Unknown",
  className: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
  icon: Clock,
};
const NORMALIZED_BADGE: Record<string, TrackingBadge> = {
  pending: { label: "Pending", className: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]", icon: Clock },
  picked_up: {
    label: "Picked up",
    className: "bg-[rgba(59,130,246,0.15)] text-[#60A5FA]",
    icon: PackageCheck,
  },
  in_transit: {
    label: "In transit",
    className: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
    icon: Truck,
  },
  out_for_delivery: {
    label: "Out for delivery",
    className: "bg-[rgba(168,85,247,0.15)] text-[#C084FC]",
    icon: Truck,
  },
  delivered: {
    label: "Delivered",
    className: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
    icon: CheckCircle2,
  },
  failed: {
    label: "Failed",
    className: "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
    icon: AlertCircle,
  },
  rto: { label: "RTO", className: "bg-[rgba(239,68,68,0.15)] text-[#F87171]", icon: Undo2 },
  unknown: {
    label: "Unknown",
    className: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
    icon: Clock,
  },
};

type ReviewStatus = "not_required" | "pending_call" | "verified" | "rejected" | "no_answer";

type OrderRow = {
  id: string;
  orderNumber: string;
  status: Status;
  cod: number;
  total: number;
  customer: { name: string; phone: string; district: string };
  courier?: string;
  trackingNumber?: string;
  normalizedStatus?: string;
  eventCount?: number;
  lastPolledAt?: string | Date | null;
  deliveredAt?: string | Date | null;
  returnedAt?: string | Date | null;
  pollError?: string | null;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  reviewStatus: ReviewStatus;
  createdAt: string | Date;
};

const REVIEW_BADGE: Record<
  Exclude<ReviewStatus, "not_required">,
  { label: string; className: string; Icon: typeof ShieldAlert }
> = {
  pending_call: {
    label: "Pending call",
    className: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
    Icon: ShieldAlert,
  },
  no_answer: {
    label: "No answer",
    className: "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
    Icon: ShieldAlert,
  },
  verified: {
    label: "Verified",
    className: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
    Icon: ShieldCheck,
  },
  rejected: {
    label: "Rejected",
    className: "bg-[rgba(239,68,68,0.2)] text-[#FCA5A5]",
    Icon: ShieldAlert,
  },
};

const PAGE_SIZE = 25;

export default function OrdersPage() {
  const [status, setStatus] = useState<Status | "all">("all");
  const [courier, setCourier] = useState("");
  const [phone, setPhone] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const [createOpen, setCreateOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [timelineId, setTimelineId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());

  const currentCursor = cursorStack[cursorStack.length - 1];
  const pageIndex = cursorStack.length - 1;

  function resetToFirstPage() {
    setCursorStack([undefined]);
    setSelected(new Set());
  }

  const filters = useMemo(
    () => ({
      ...(status !== "all" ? { status } : {}),
      ...(courier ? { courier } : {}),
      ...(phone ? { phone } : {}),
      ...(dateFrom ? { dateFrom: new Date(dateFrom) } : {}),
      ...(currentCursor ? { cursor: currentCursor } : {}),
      limit: PAGE_SIZE,
    }),
    [status, courier, phone, dateFrom, currentCursor],
  );

  const list = trpc.orders.listOrders.useQuery(filters);
  const couriersQuery = trpc.orders.listCouriers.useQuery(undefined, { staleTime: 60_000 });
  const utils = trpc.useUtils();

  const refreshMutation = trpc.orders.refreshTracking.useMutation();

  async function refreshRow(id: string) {
    setRefreshing((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      const res = await refreshMutation.mutateAsync({ id });
      if (res.ok) {
        const newEvents = res.newEvents ?? 0;
        if (res.statusTransition) {
          toast.success(
            `Status: ${res.statusTransition.from} → ${res.statusTransition.to}`,
            newEvents > 0 ? `${newEvents} new event${newEvents === 1 ? "" : "s"}` : undefined,
          );
        } else if (newEvents > 0) {
          toast.success(`${newEvents} new event${newEvents === 1 ? "" : "s"}`);
        } else {
          toast.info("Already up to date");
        }
      } else if ("skipped" in res) {
        toast.info("Cannot refresh", res.skipped ?? "");
      } else if ("error" in res) {
        toast.error("Refresh failed", res.error ?? "");
      }
      await utils.orders.listOrders.invalidate();
    } catch (err) {
      toast.error("Refresh failed", (err as Error).message);
    } finally {
      setRefreshing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const rows = (list.data?.items ?? []) as OrderRow[];
  const total = list.data?.total ?? 0;

  const bookableIdsOnPage = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            ["pending", "confirmed", "packed"].includes(r.status) &&
            !r.courier &&
            r.reviewStatus !== "pending_call" &&
            r.reviewStatus !== "no_answer" &&
            r.reviewStatus !== "rejected",
        )
        .map((r) => r.id),
    [rows],
  );
  const allBookableSelected =
    bookableIdsOnPage.length > 0 && bookableIdsOnPage.every((id) => selected.has(id));
  const someBookableSelected = bookableIdsOnPage.some((id) => selected.has(id));

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allBookableSelected) {
        for (const id of bookableIdsOnPage) next.delete(id);
      } else {
        for (const id of bookableIdsOnPage) next.add(id);
      }
      return next;
    });
  }

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  const columns = useMemo<ColumnDef<OrderRow>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <input
            type="checkbox"
            aria-label="Select all bookable orders on this page"
            checked={allBookableSelected}
            ref={(el) => {
              if (el) el.indeterminate = !allBookableSelected && someBookableSelected;
            }}
            disabled={bookableIdsOnPage.length === 0}
            onChange={toggleAllOnPage}
            className="h-4 w-4 cursor-pointer accent-[#0084D4] disabled:cursor-not-allowed disabled:opacity-40"
          />
        ),
        cell: ({ row }) => {
          const r = row.original;
          const bookable =
            ["pending", "confirmed", "packed"].includes(r.status) &&
            !r.courier &&
            r.reviewStatus !== "pending_call" &&
            r.reviewStatus !== "no_answer" &&
            r.reviewStatus !== "rejected";
          return (
            <input
              type="checkbox"
              aria-label={`Select order ${r.orderNumber}`}
              checked={selected.has(r.id)}
              disabled={!bookable}
              onChange={() => toggleRow(r.id)}
              className="h-4 w-4 cursor-pointer accent-[#0084D4] disabled:cursor-not-allowed disabled:opacity-30"
            />
          );
        },
        size: 32,
      },
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
          return (
            <Badge variant="outline" className={`border-transparent ${statusClass[s]}`}>
              {s.replace("_", " ")}
            </Badge>
          );
        },
      },
      { header: "Courier", accessorFn: (row) => row.courier ?? "—", id: "courier" },
      {
        header: "Tracking",
        id: "tracking",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.trackingNumber) {
            return <span className="text-xs text-[#6B7280]">—</span>;
          }
          const badge: TrackingBadge =
            (r.normalizedStatus ? NORMALIZED_BADGE[r.normalizedStatus] : undefined) ??
            NORMALIZED_BADGE.pending ??
            FALLBACK_BADGE;
          const Icon = badge.icon;
          const isRefreshing = refreshing.has(r.id);
          return (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={`border-transparent ${badge.className}`}>
                <Icon className="mr-1 h-3 w-3" />
                {badge.label}
              </Badge>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void refreshRow(r.id);
                }}
                disabled={isRefreshing}
                aria-label="Refresh tracking"
                className="rounded p-1 text-[#9CA3AF] transition-colors hover:bg-[#111318] hover:text-[#F3F4F6] disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              </button>
              {r.pollError && (
                <span
                  title={r.pollError}
                  className="flex items-center text-[#F87171]"
                  aria-label="Last poll error"
                >
                  <AlertCircle className="h-3.5 w-3.5" />
                </span>
              )}
            </div>
          );
        },
      },
      {
        header: "COD",
        accessorKey: "cod",
        cell: ({ getValue }) => `৳ ${getValue<number>().toLocaleString()}`,
      },
      {
        header: "Risk",
        accessorKey: "riskScore",
        cell: ({ row }) => {
          const r = row.original;
          const review =
            r.reviewStatus !== "not_required" ? REVIEW_BADGE[r.reviewStatus] : null;
          return (
            <div className="flex flex-wrap items-center gap-1">
              <Badge
                variant="outline"
                className={`border-transparent ${riskClass(r.riskScore)}`}
              >
                {r.riskScore}
              </Badge>
              {review ? (
                <Badge
                  variant="outline"
                  className={`border-transparent ${review.className}`}
                >
                  <review.Icon className="mr-1 h-3 w-3" />
                  {review.label}
                </Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        header: "Created",
        accessorKey: "createdAt",
        cell: ({ getValue }) => new Date(getValue<string>()).toLocaleDateString(),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setTimelineId(row.original.id)}
            className="inline-flex items-center gap-1 rounded-md border border-[rgba(209,213,219,0.15)] bg-transparent px-2 py-1 text-xs text-[#D1D5DB] transition-colors hover:bg-[#111318] hover:text-[#F3F4F6]"
          >
            <Timer className="h-3 w-3" />
            Timeline
          </button>
        ),
      },
    ],
    [allBookableSelected, someBookableSelected, bookableIdsOnPage, selected, refreshing],
  );

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

  async function refresh() {
    await utils.orders.listOrders.invalidate();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-[#F3F4F6]">Orders</h1>
          <p className="mt-1 text-sm text-[#9CA3AF]">{total.toLocaleString()} total</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            className="border-[rgba(209,213,219,0.15)] bg-transparent text-[#F3F4F6] hover:bg-[#1A1D2E]"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="mr-2 h-4 w-4" />
            Bulk upload
          </Button>
          <Button
            className="bg-[#0084D4] text-white hover:bg-[#0072BB]"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create order
          </Button>
        </div>
      </div>

      <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
        <CardContent className="p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="f-status" className="text-[#9CA3AF]">
                Status
              </Label>
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus(v as Status | "all");
                  resetToFirstPage();
                }}
              >
                <SelectTrigger id="f-status">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-courier" className="text-[#9CA3AF]">
                Courier
              </Label>
              <Select
                value={courier || "all"}
                onValueChange={(v) => {
                  setCourier(v === "all" ? "" : v);
                  resetToFirstPage();
                }}
              >
                <SelectTrigger id="f-courier">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {(couriersQuery.data ?? []).map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-phone" className="text-[#9CA3AF]">
                Customer phone
              </Label>
              <Input
                id="f-phone"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  resetToFirstPage();
                }}
                placeholder="+8801…"
                className="border-[rgba(209,213,219,0.15)] bg-[#111318] text-[#F3F4F6] placeholder:text-[#6B7280]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-date" className="text-[#9CA3AF]">
                From date
              </Label>
              <Input
                id="f-date"
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  resetToFirstPage();
                }}
                className="border-[rgba(209,213,219,0.15)] bg-[#111318] text-[#F3F4F6]"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedIds.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-[rgba(0,132,212,0.3)] bg-[rgba(0,132,212,0.08)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[#F3F4F6]">
            <span className="font-semibold">{selectedIds.length}</span> order
            {selectedIds.length === 1 ? "" : "s"} selected
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-[rgba(209,213,219,0.15)] bg-transparent text-[#F3F4F6] hover:bg-[#111318]"
              onClick={() => setSelected(new Set())}
            >
              <X className="mr-1.5 h-3.5 w-3.5" />
              Clear
            </Button>
            <Button
              size="sm"
              className="bg-[#0084D4] text-white hover:bg-[#0072BB]"
              onClick={() => setBookOpen(true)}
            >
              <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
              Book courier pickup
            </Button>
          </div>
        </div>
      )}

      <Card className="overflow-hidden border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="border-[rgba(209,213,219,0.08)] hover:bg-transparent">
                  {hg.headers.map((h) => (
                    <TableHead key={h.id} className="text-[#9CA3AF]">
                      {h.isPlaceholder
                        ? null
                        : flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {list.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i} className="border-[rgba(209,213,219,0.05)]">
                    <TableCell colSpan={columns.length} className="py-3">
                      <div className="h-4 w-full animate-shimmer rounded" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-24 text-center text-[#9CA3AF]"
                  >
                    No orders match your filters.
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => {
                  const r = row.original;
                  const flagged =
                    r.reviewStatus === "pending_call" || r.reviewStatus === "no_answer";
                  const rejected = r.reviewStatus === "rejected";
                  const rowClass = rejected
                    ? "bg-[rgba(239,68,68,0.04)] hover:bg-[rgba(239,68,68,0.08)]"
                    : flagged
                      ? "bg-[rgba(245,158,11,0.04)] hover:bg-[rgba(245,158,11,0.08)]"
                      : "hover:bg-[rgba(26,29,46,0.6)]";
                  return (
                    <TableRow
                      key={row.id}
                      className={`border-[rgba(209,213,219,0.05)] transition-colors ${rowClass}`}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="text-[#D1D5DB]">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-[#9CA3AF]">
          Page {pageIndex + 1} · {total.toLocaleString()} total
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-[rgba(209,213,219,0.15)] bg-transparent text-[#F3F4F6] hover:bg-[#1A1D2E] disabled:opacity-40"
            disabled={pageIndex === 0}
            onClick={() => setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-[rgba(209,213,219,0.15)] bg-transparent text-[#F3F4F6] hover:bg-[#1A1D2E] disabled:opacity-40"
            disabled={!list.data?.nextCursor}
            onClick={() => {
              const next = list.data?.nextCursor;
              if (next) setCursorStack((s) => [...s, next]);
            }}
          >
            Next
          </Button>
        </div>
      </div>

      <CreateOrderDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh} />
      <BulkUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} onUploaded={refresh} />
      <BookShipmentDialog
        open={bookOpen}
        onOpenChange={setBookOpen}
        orderIds={selectedIds}
        onComplete={async () => {
          setSelected(new Set());
          await refresh();
        }}
      />
      <TrackingTimelineDrawer
        orderId={timelineId}
        open={timelineId !== null}
        onOpenChange={(v) => {
          if (!v) setTimelineId(null);
        }}
      />
    </div>
  );
}
