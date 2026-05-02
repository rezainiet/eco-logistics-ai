"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/formatters";

type ActorTypeFilter = "any" | "merchant" | "agent" | "admin" | "system";

interface QuickFilter {
  id: string;
  label: string;
  actorType?: ActorTypeFilter;
  action?: string;
  className?: string;
}

const QUICK_FILTERS: QuickFilter[] = [
  { id: "all", label: "All events" },
  {
    id: "admin",
    label: "Admin actions",
    actorType: "admin",
    className: "border-info/30 text-info",
  },
  {
    id: "payment",
    label: "Payments",
    action: "payment.",
    className: "border-success/30 text-success",
  },
  {
    id: "fraud",
    label: "Fraud decisions",
    action: "review.",
    className: "border-warning/30 text-warning",
  },
  {
    id: "alerts",
    label: "Alerts",
    action: "alert.fired",
    className: "border-danger/30 text-danger",
  },
  {
    id: "auth",
    label: "Auth",
    action: "auth.",
    className: "border-violet-500/30 text-violet-300",
  },
  {
    id: "automation",
    label: "Automation",
    action: "automation.",
    className: "border-cyan-500/30 text-cyan-300",
  },
];

/**
 * Audit log explorer. Filters compose into one tRPC search call; rows
 * expand inline to show before/after diffs. The chain-verify button calls
 * the super_admin-only verifyChain endpoint and renders the result inline
 * (success or first break point).
 *
 * The URL accepts ?action= and ?actorType= so other admin pages can deep-
 * link straight to a pre-filtered view (e.g. fraud → review.* events).
 */
export default function AdminAuditPage() {
  const params = useSearchParams();
  const [actorType, setActorType] = useState<ActorTypeFilter>(
    (params.get("actorType") as ActorTypeFilter) ?? "any",
  );
  const [action, setAction] = useState(params.get("action") ?? "");
  const [subjectId, setSubjectId] = useState(params.get("subjectId") ?? "");
  const [merchantId, setMerchantId] = useState(params.get("merchantId") ?? "");
  const [activeQuick, setActiveQuick] = useState<string>(() => {
    const a = params.get("action") ?? "";
    const at = params.get("actorType") ?? "";
    if (at === "admin") return "admin";
    if (a.startsWith("payment.")) return "payment";
    if (a.startsWith("review.")) return "fraud";
    if (a === "alert.fired") return "alerts";
    if (a.startsWith("auth.")) return "auth";
    if (a.startsWith("automation.")) return "automation";
    return "all";
  });

  const search = trpc.adminAudit.search.useQuery({
    actorType: actorType === "any" ? undefined : actorType,
    action: action || undefined,
    subjectId: subjectId || undefined,
    merchantId: merchantId || undefined,
    limit: 100,
  });
  const verify = trpc.adminAudit.verifyChain.useQuery(
    { limit: 5000 },
    { enabled: false },
  );

  // Sync URL → state when navigating with browser back/forward.
  useEffect(() => {
    const a = params.get("action") ?? "";
    const at = (params.get("actorType") as ActorTypeFilter) ?? "any";
    setAction(a);
    setActorType(at);
  }, [params]);

  function applyQuick(id: string) {
    const q = QUICK_FILTERS.find((x) => x.id === id);
    if (!q) return;
    setActiveQuick(id);
    setActorType(q.actorType ?? "any");
    setAction(q.action ?? "");
    // Leave subjectId / merchantId alone — those are user-driven drills.
  }

  function clearAll() {
    setActorType("any");
    setAction("");
    setSubjectId("");
    setMerchantId("");
    setActiveQuick("all");
  }

  const rows = search.data?.rows ?? [];
  const filterCount = useMemo(() => {
    let n = 0;
    if (actorType !== "any") n++;
    if (action) n++;
    if (subjectId) n++;
    if (merchantId) n++;
    return n;
  }, [actorType, action, subjectId, merchantId]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin · Audit"
        title="Audit log explorer"
        description="Tamper-evident, append-only ledger of every admin and merchant action. Each row carries before/after state and the actor's IP."
      />

      {/* Chain verification banner */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-2 text-sm">
            {verify.data ? (
              verify.data.ok ? (
                <span className="flex items-center gap-2 text-success">
                  <ShieldCheck className="h-4 w-4" />
                  Chain intact — {verify.data.message}
                </span>
              ) : (
                <span className="flex items-center gap-2 text-danger">
                  <ShieldAlert className="h-4 w-4" />
                  Tamper detected at{" "}
                  {verify.data.firstBreakAt
                    ? formatDateTime(verify.data.firstBreakAt)
                    : "?"}{" "}
                  — {verify.data.message}
                </span>
              )
            ) : (
              <span className="flex items-center gap-2 text-fg-subtle">
                <ShieldCheck className="h-4 w-4" />
                Chain status unverified. Run verification to walk the hash chain.
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => verify.refetch()}
            disabled={verify.isFetching}
          >
            <RefreshCw
              className={`mr-1 h-3 w-3 ${verify.isFetching ? "animate-spin" : ""}`}
            />
            {verify.isFetching ? "Verifying…" : "Verify chain"}
          </Button>
        </CardContent>
      </Card>

      {/* Quick filter chips */}
      <div className="flex flex-wrap gap-2">
        {QUICK_FILTERS.map((q) => (
          <button
            key={q.id}
            onClick={() => applyQuick(q.id)}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              activeQuick === q.id
                ? "border-brand bg-brand/10 text-brand"
                : `border-stroke/14 text-fg-muted hover:border-stroke/28 ${q.className ?? ""}`
            }`}
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* Detailed filters */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Search className="h-4 w-4 text-fg-subtle" />
            Filters
            {filterCount > 0 ? (
              <Badge className="ml-1 bg-info-subtle text-info">
                {filterCount}
              </Badge>
            ) : null}
          </CardTitle>
          {filterCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={clearAll}>
              <X className="mr-1 h-3 w-3" /> Clear
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Actor type</Label>
            <Select
              value={actorType}
              onValueChange={(v) => setActorType(v as ActorTypeFilter)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="merchant">Merchant</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Action prefix or exact</Label>
            <Input
              placeholder="e.g. payment.approved or review."
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setActiveQuick("all");
              }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Subject ID</Label>
            <Input
              placeholder="ObjectId"
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Merchant ID</Label>
            <Input
              placeholder="ObjectId"
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-sm">
            Events
            <span className="ml-2 text-xs text-fg-subtle">
              ({rows.length} loaded)
            </span>
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => search.refetch()}
            disabled={search.isFetching}
          >
            <RefreshCw
              className={`mr-1 h-3 w-3 ${search.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="pt-0">
          {search.isLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-12 animate-shimmer rounded-md bg-surface-raised/40"
                />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-fg-subtle">
              No events match these filters.
            </div>
          ) : (
            <div className="space-y-1">
              {rows.map((r) => (
                <AuditRow
                  key={r.id}
                  row={r as AuditRowType}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface AuditRowType {
  id: string;
  merchantId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  actorType: string | null;
  actorScope: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  meta: unknown;
  prevState: unknown;
  nextState: unknown;
  ip: string | null;
  userAgent: string | null;
  at: Date | string;
  prevHash: string | null;
  selfHash: string | null;
}

function AuditRow({ row }: { row: AuditRowType }) {
  const [open, setOpen] = useState(false);
  const hasDiff =
    row.prevState !== null && row.prevState !== undefined &&
    row.nextState !== null && row.nextState !== undefined;
  const expandable =
    hasDiff || row.meta !== null || row.userAgent || row.ip;

  // Color-code the row based on action prefix.
  const actionTone = row.action.startsWith("admin.unauthorized")
    ? "border-danger/40 bg-danger-subtle/20"
    : row.action.startsWith("alert.")
      ? "border-warning/40 bg-warning-subtle/20"
      : row.action.startsWith("payment.approved") ||
          row.action.startsWith("subscription.activated") ||
          row.action.startsWith("review.verified")
        ? "border-success/30"
        : row.action.startsWith("payment.rejected") ||
            row.action.startsWith("review.rejected") ||
            row.action.startsWith("subscription.suspended")
          ? "border-danger/30"
          : "border-stroke/12";

  return (
    <div
      className={`rounded-md border ${actionTone} bg-surface-raised/40 transition`}
    >
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
        disabled={!expandable}
      >
        {expandable ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-fg-subtle" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-fg-subtle" />
          )
        ) : (
          <span className="h-3 w-3 shrink-0" />
        )}
        <span className="shrink-0 font-mono text-2xs text-fg-faint">
          {formatDateTime(row.at)}
        </span>
        <code className="shrink-0 font-mono text-xs text-fg">{row.action}</code>
        {row.actorScope ? (
          <Badge className="shrink-0 bg-info-subtle text-info text-2xs">
            {row.actorScope}
          </Badge>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-2xs text-fg-subtle">
          {row.actorEmail ?? row.actorType ?? "—"}
        </span>
        <span className="shrink-0 font-mono text-2xs text-fg-faint">
          {row.subjectType}:{String(row.subjectId).slice(-8)}
        </span>
      </button>
      {open && expandable ? (
        <div className="space-y-2 border-t border-stroke/8 px-3 py-2 text-xs">
          {row.ip || row.userAgent ? (
            <div className="flex flex-wrap gap-3 text-2xs text-fg-subtle">
              {row.ip ? (
                <span>
                  IP: <span className="font-mono text-fg">{row.ip}</span>
                </span>
              ) : null}
              {row.userAgent ? (
                <span className="truncate" title={row.userAgent}>
                  UA:{" "}
                  <span className="font-mono text-fg">
                    {row.userAgent.slice(0, 80)}
                  </span>
                </span>
              ) : null}
            </div>
          ) : null}
          {hasDiff ? (
            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <div className="mb-1 text-2xs uppercase tracking-wide text-fg-faint">
                  Before
                </div>
                <pre className="overflow-auto rounded bg-[#0B0E1A] p-2 text-2xs text-fg-subtle">
                  {JSON.stringify(row.prevState, null, 2)}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-2xs uppercase tracking-wide text-fg-faint">
                  After
                </div>
                <pre className="overflow-auto rounded bg-[#0B0E1A] p-2 text-2xs text-fg-subtle">
                  {JSON.stringify(row.nextState, null, 2)}
                </pre>
              </div>
            </div>
          ) : null}
          {row.meta !== null && row.meta !== undefined ? (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-wide text-fg-faint">
                Meta
              </div>
              <pre className="overflow-auto rounded bg-[#0B0E1A] p-2 text-2xs text-fg-subtle">
                {JSON.stringify(row.meta, null, 2)}
              </pre>
            </div>
          ) : null}
          {row.selfHash ? (
            <div className="flex flex-wrap gap-3 text-2xs text-fg-faint">
              <span>
                hash:{" "}
                <span className="font-mono text-fg-subtle">
                  {row.selfHash.slice(0, 16)}…
                </span>
              </span>
              <span>
                prev:{" "}
                <span className="font-mono text-fg-subtle">
                  {row.prevHash?.slice(0, 16) ?? "—"}…
                </span>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
