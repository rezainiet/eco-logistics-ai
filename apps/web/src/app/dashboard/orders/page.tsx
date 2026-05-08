"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import Link from "next/link";
import {
  AlertCircle,
  PackageCheck,
  PackagePlus,
  Plug,
  Plus,
  RefreshCw,
  SearchX,
  Timer,
  Upload,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
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
import {
  AutomationBadge,
  type AutomationState,
} from "@/components/automation/automation-badge";
import { BulkAutomationBar } from "@/components/automation/bulk-automation-bar";
import { OrdersCardList } from "@/components/orders/orders-card-list";
import { SampleOrdersPreview } from "@/components/orders/sample-orders-preview";
import { formatBDT, formatDate } from "@/lib/formatters";
import { humanizeError } from "@/lib/friendly-errors";
import {
  ORDER_STATUSES,
  type OrderStatus as Status,
  REVIEW_BADGE,
  type ReviewStatus,
  orderStatusClass,
  resolveTrackingBadge,
  riskBadgeClass,
} from "@/lib/status-badges";

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
  automationState?: AutomationState;
  bookedByAutomation?: boolean;
  createdAt: string | Date;
};

const PAGE_SIZE = 25;

export default function OrdersPage() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status | "all">("all");
  const [courier, setCourier] = useState("");
  const [phone, setPhone] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const [createOpen, setCreateOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Deep-link from /dashboard/integrations CSV card: ?bulk=1 auto-opens the
  // bulk uploader so the CSV path is one click instead of two. Also handles
  // ?new=1 from the onboarding "create your first order" CTA so the dialog
  // is open the moment the merchant lands here.
  useEffect(() => {
    if (searchParams?.get("bulk") === "1") setUploadOpen(true);
    if (searchParams?.get("new") === "1") setCreateOpen(true);
  }, [searchParams]);
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
      toast.error("Refresh failed", humanizeError(err));
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
  // True when at least one filter is active. Drives the empty-state copy:
  // a merchant with zero orders and zero filters needs a "get started" CTA,
  // not a "try broadening the filters" message about filters they never set.
  const hasActiveFilters =
    status !== "all" || courier !== "" || phone !== "" || dateFrom !== "";

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
            className="h-4 w-4 cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-40"
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
              className="h-4 w-4 cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-30"
            />
          );
        },
        size: 32,
      },
      {
        header: "Order #",
        accessorKey: "orderNumber",
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-fg">{getValue<string>()}</span>
        ),
      },
      {
        header: "Customer",
        id: "customer",
        cell: ({ row }) => {
          const c = row.original.customer;
          return (
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">{c.name}</p>
              <p className="truncate font-mono text-[11px] text-fg-subtle">{c.phone}</p>
            </div>
          );
        },
      },
      {
        header: "District",
        accessorFn: (row) => row.customer.district,
        id: "district",
        cell: ({ getValue }) => (
          <span className="text-sm text-fg-muted">{getValue<string>()}</span>
        ),
      },
      {
        header: "Status",
        accessorKey: "status",
        cell: ({ getValue }) => {
          const s = getValue<Status>();
          return (
            <Badge variant="outline" className={`border-transparent capitalize ${orderStatusClass[s]}`}>
              {s.replace("_", " ")}
            </Badge>
          );
        },
      },
      {
        header: "Automation",
        id: "automation",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.automationState || r.automationState === "not_evaluated") {
            return <span className="text-xs text-fg-faint">—</span>;
          }
          return (
            <AutomationBadge
              state={r.automationState}
              bookedByAutomation={r.bookedByAutomation}
            />
          );
        },
      },
      {
        header: "Courier",
        accessorFn: (row) => row.courier ?? "—",
        id: "courier",
        cell: ({ getValue }) => (
          <span className="text-sm text-fg-muted">{getValue<string>()}</span>
        ),
      },
      {
        header: "Tracking",
        id: "tracking",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.trackingNumber) {
            return <span className="text-xs text-fg-faint">—</span>;
          }
          const badge = resolveTrackingBadge(r.normalizedStatus);
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
                className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              </button>
              {r.pollError && (
                <span
                  title={r.pollError}
                  className="flex items-center text-danger"
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
        cell: ({ getValue }) => (
          <span className="font-mono text-sm tabular-nums text-fg">
            {formatBDT(getValue<number>())}
          </span>
        ),
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
                className={`border-transparent font-mono tabular-nums ${riskBadgeClass(r.riskScore)}`}
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
        cell: ({ getValue }) => (
          <span className="text-xs text-fg-subtle">{formatDate(getValue<string>())}</span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setTimelineId(row.original.id)}
            className="inline-flex items-center gap-1 rounded-md border border-stroke/12 bg-transparent px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
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
      <PageHeader
        eyebrow="Operations"
        title="Orders"
        description={`${total.toLocaleString()} total orders across all statuses`}
        actions={
          <>
            <Button
              variant="outline"
              className="border-stroke/14 bg-transparent text-fg hover:bg-surface"
              onClick={() => setUploadOpen(true)}
            >
              <Upload className="mr-2 h-4 w-4" />
              Bulk upload
            </Button>
            <Button
              className="bg-brand text-white hover:bg-brand-hover"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create order
            </Button>
          </>
        }
      />

      <div className="rounded-xl border border-stroke/10 bg-surface p-4 shadow-card">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="f-status" className="text-fg-subtle">
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
                {ORDER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-courier" className="text-fg-subtle">
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
            <Label htmlFor="f-phone" className="text-fg-subtle">
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
              className="border-stroke/14 bg-surface-raised text-fg placeholder:text-fg-faint"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-date" className="text-fg-subtle">
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
              className="border-stroke/14 bg-surface-raised text-fg [color-scheme:dark]"
            />
          </div>
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="sticky top-16 z-20 flex flex-col gap-3 rounded-lg border border-brand/35 bg-brand-subtle px-4 py-3 shadow-elevated animate-slide-down sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-fg">
            <span className="font-semibold">{selectedIds.length}</span> order
            {selectedIds.length === 1 ? "" : "s"} selected
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-stroke/14 bg-transparent text-fg hover:bg-surface-raised"
              onClick={() => setSelected(new Set())}
            >
              <X className="mr-1.5 h-3.5 w-3.5" />
              Clear
            </Button>
            <Button
              size="sm"
              className="bg-brand text-white hover:bg-brand-hover"
              onClick={() => setBookOpen(true)}
            >
              <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
              Book courier pickup
            </Button>
          </div>
        </div>
      )}

      <div className="hidden overflow-hidden rounded-xl border border-stroke/10 bg-surface shadow-card sm:block">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow
                  key={hg.id}
                  className="border-stroke/8 bg-surface-raised/40 hover:bg-transparent"
                >
                  {hg.headers.map((h) => (
                    <TableHead
                      key={h.id}
                      className="h-11 px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle"
                    >
                      {h.isPlaceholder
                        ? null
                        : flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {list.isError ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="p-0">
                    <EmptyState
                      icon={AlertCircle}
                      title="Could not load orders"
                      description="Something went wrong on our end. Try again in a moment."
                      className="m-4 border-0 bg-transparent"
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-stroke/14 text-fg-muted"
                          onClick={() => list.refetch()}
                        >
                          Retry
                        </Button>
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : list.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i} className="border-stroke/8">
                    <TableCell colSpan={columns.length} className="py-3.5">
                      <div className="h-4 w-full animate-shimmer rounded" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="p-0">
                    {hasActiveFilters ? (
                      <EmptyState
                        icon={SearchX}
                        title="No orders match your filters"
                        description="Try broadening the status, phone number, or date range. Clearing filters returns to your full order list."
                        className="m-4 border-0 bg-transparent"
                        action={
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-stroke/14 text-fg-muted"
                            onClick={() => {
                              setStatus("all");
                              setCourier("");
                              setPhone("");
                              setDateFrom("");
                              resetToFirstPage();
                            }}
                          >
                            Reset filters
                          </Button>
                        }
                      />
                    ) : (
                      <EmptyState
                        icon={PackagePlus}
                        title="No orders yet"
                        description="Connect your store to ingest orders automatically, or create one manually to see how they flow through."
                        className="m-4 border-0 bg-transparent"
                        action={
                          <div className="flex flex-wrap gap-2">
                            <Button
                              asChild
                              size="sm"
                              className="bg-brand text-white hover:bg-brand-hover"
                            >
                              <Link href="/dashboard/integrations">
                                <Plug className="mr-1.5 h-3.5 w-3.5" />
                                Connect store
                              </Link>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-stroke/14 text-fg-muted"
                              onClick={() => setCreateOpen(true)}
                            >
                              <Plus className="mr-1.5 h-3.5 w-3.5" />
                              Create order
                            </Button>
                          </div>
                        }
                      />
                    )}
                    {/*
                      Skeleton-of-real-data preview rendered BELOW the
                      EmptyState CTAs, only on the "no orders ever, no
                      filters" onboarding path. Shows the merchant what
                      an order with risk-score / status / COD looks
                      like so the value of Cordon is legible before
                      their first webhook arrives. Hidden when filters
                      are active (debug state, not onboarding) and once
                      real orders exist (the table speaks for itself).
                    */}
                    {!hasActiveFilters ? <SampleOrdersPreview /> : null}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => {
                  const r = row.original;
                  const flagged =
                    r.reviewStatus === "pending_call" || r.reviewStatus === "no_answer";
                  const rejected = r.reviewStatus === "rejected";
                  const rowClass = rejected
                    ? "bg-danger/5 hover:bg-danger/10"
                    : flagged
                      ? "bg-warning/5 hover:bg-warning/10"
                      : "hover:bg-surface-raised/50";
                  return (
                    <TableRow
                      key={row.id}
                      className={`border-stroke/6 transition-colors ${rowClass}`}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="px-3 py-3 align-middle text-fg-muted">
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
      </div>


      {/* Mobile card layout — extracted to <OrdersCardList /> */}
      <OrdersCardList
        rows={rows}
        isLoading={list.isLoading}
        selected={selected}
        onToggleRow={toggleRow}
        onResetFilters={() => {
          setStatus("all");
          setCourier("");
          setPhone("");
          setDateFrom("");
          resetToFirstPage();
        }}
      />

      <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-xs text-fg-subtle">
          Page <span className="font-medium text-fg">{pageIndex + 1}</span> ·{" "}
          <span className="font-medium text-fg">{total.toLocaleString()}</span> total
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-stroke/14 bg-transparent text-fg hover:bg-surface disabled:opacity-40"
            disabled={pageIndex === 0}
            onClick={() => setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-stroke/14 bg-transparent text-fg hover:bg-surface disabled:opacity-40"
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

      <BulkAutomationBar
        selectedIds={selectedIds}
        onActionDone={refresh}
        onClearSelection={() => setSelected(new Set())}
      />

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
