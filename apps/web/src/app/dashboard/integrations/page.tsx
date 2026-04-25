"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  Lock,
  Plug,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Trash2,
  Webhook,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "@/components/ui/toast";
import { formatRelative } from "@/lib/formatters";
import { InlineLockedFeature } from "@/components/billing/locked-feature";

type ProviderKey = "shopify" | "woocommerce" | "custom_api" | "csv";

const PROVIDER_META: Record<
  ProviderKey,
  { label: string; description: string; icon: typeof ShoppingBag; tone: string }
> = {
  shopify: {
    label: "Shopify",
    description: "Real-time order sync via OAuth + verified webhooks.",
    icon: ShoppingBag,
    tone: "bg-[hsl(146_60%_42%/0.12)] text-[hsl(146_60%_60%)]",
  },
  woocommerce: {
    label: "WooCommerce",
    description: "REST API connect with HMAC-signed webhook ingest.",
    icon: Store,
    tone: "bg-[hsl(286_67%_52%/0.12)] text-[hsl(286_67%_72%)]",
  },
  custom_api: {
    label: "Custom API",
    description: "Push orders from any storefront via signed webhook.",
    icon: Code2,
    tone: "bg-info-subtle text-info",
  },
  csv: {
    label: "CSV import",
    description: "Manual fallback — upload bulk orders via CSV.",
    icon: FileText,
    tone: "bg-warning-subtle text-warning",
  },
};

function StatusPill({ status, healthOk }: { status: string; healthOk: boolean }) {
  const tone =
    status === "connected" && healthOk
      ? "bg-success-subtle text-success border-success-border"
      : status === "pending"
        ? "bg-warning-subtle text-warning border-warning-border"
        : status === "disconnected"
          ? "bg-surface-raised text-fg-subtle border-stroke/14"
          : "bg-danger-subtle text-danger border-danger-border";
  return (
    <Badge variant="outline" className={tone}>
      {status}
    </Badge>
  );
}

const TIER_LABEL: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
  enterprise: "Enterprise",
};

export default function IntegrationsPage() {
  const list = trpc.integrations.list.useQuery();
  const tracking = trpc.tracking.getInstallation.useQuery();
  const recent = trpc.integrations.recentWebhooks.useQuery({ limit: 10 });
  const entitlements = trpc.integrations.getEntitlements.useQuery();
  const [openProvider, setOpenProvider] = useState<ProviderKey | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const connect = trpc.integrations.connect.useMutation({
    onSuccess: (data) => {
      toast.success(
        data.status === "connected"
          ? "Integration connected"
          : "Connection started — finish OAuth to activate",
      );
      void utils.integrations.list.invalidate();
      void utils.integrations.getEntitlements.invalidate();
      setOpenProvider(null);
      if (data.installUrl) {
        window.open(data.installUrl, "_blank", "noopener,noreferrer");
      }
    },
    onError: (err) => {
      // Plan-gate errors carry `entitlement_blocked:<code>[:detail]`. We
      // translate them to a friendlier prompt so the merchant knows it's a
      // billing issue, not an integration setup problem.
      if (err.message.startsWith("entitlement_blocked:")) {
        const code = err.message.split(":")[1] ?? "";
        if (code === "integration_provider_locked") {
          toast.error("This connector requires an upgrade — see your plan.");
        } else if (code === "integration_count_capped") {
          toast.error("You've hit your plan's connector cap — upgrade to add more.");
        } else {
          toast.error("Plan upgrade required for this feature.");
        }
        setOpenProvider(null);
        return;
      }
      toast.error(err.message);
    },
  });

  const test = trpc.integrations.test.useMutation({
    onSuccess: (r) => {
      if (r.ok) toast.success(r.detail ?? "Connection ok");
      else toast.error(r.detail ?? "Connection failed");
      void utils.integrations.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const [activeImportJobId, setActiveImportJobId] = useState<string | null>(null);
  const importNow = trpc.integrations.importOrders.useMutation({
    onSuccess: (r) => {
      setActiveImportJobId(r.jobId);
      toast.success("Import queued — progress will appear in a moment.");
      void utils.integrations.recentWebhooks.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const importProgress = trpc.integrations.getImportJob.useQuery(
    { id: activeImportJobId ?? "" },
    {
      enabled: !!activeImportJobId,
      refetchInterval: (data) => {
        const status = data?.status;
        if (status === "succeeded" || status === "failed" || status === "cancelled") return false;
        return 1500;
      },
      retry: false,
    },
  );

  // When the polled job finishes, refresh the integration list (counts) and
  // hold the modal so the merchant can see the final tally before dismissing.
  useEffect(() => {
    const status = importProgress.data?.status;
    if (!status) return;
    if (status === "succeeded" || status === "failed") {
      void utils.integrations.list.invalidate();
      void utils.integrations.recentWebhooks.invalidate();
    }
  }, [importProgress.data?.status, utils]);

  const disconnect = trpc.integrations.disconnect.useMutation({
    onSuccess: () => {
      toast.success("Integration disconnected");
      void utils.integrations.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const replay = trpc.integrations.replayWebhook.useMutation({
    onSuccess: (r) => {
      if (r.status === "succeeded") {
        toast.success(
          r.duplicate
            ? "Replay succeeded (duplicate — order already existed)"
            : "Webhook replayed successfully",
        );
      } else if (r.status === "dead_lettered") {
        toast.error("Replay failed — retry cap reached, dead-lettered");
      } else if (r.status === "skipped") {
        toast.success("Already succeeded — no-op");
      } else {
        toast.error(r.error ?? "Replay failed — will retry on next sweep");
      }
      void utils.integrations.recentWebhooks.invalidate();
      if (inspectId) void utils.integrations.inspectWebhook.invalidate({ id: inspectId });
    },
    onError: (err) => toast.error(err.message),
  });

  // Pick up the redirect from the Shopify OAuth callback. Strips the search
  // params after notifying so a refresh doesn't re-fire the toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    if (connected === "shopify") {
      const shop = params.get("shop");
      toast.success(shop ? `Shopify store ${shop} connected` : "Shopify connected");
      void utils.integrations.list.invalidate();
    } else if (error) {
      const detail: Record<string, string> = {
        missing_params: "Missing OAuth parameters",
        invalid_shop: "Invalid Shopify domain",
        integration_not_found: "Integration not found — start the connect flow again",
        state_mismatch: "Security check failed (state mismatch)",
        credential_decrypt_failed: "Couldn't read stored credentials",
        hmac_mismatch: "Shopify signature didn't verify",
        token_exchange_failed: "Shopify rejected the access token request",
      };
      toast.error(detail[error] ?? `Shopify install failed: ${error}`);
    }
    const url = new URL(window.location.href);
    url.search = "";
    window.history.replaceState({}, "", url.toString());
  }, [utils]);

  const integrations = list.data ?? [];

  const providersByKey = useMemo(() => {
    const grouped: Record<ProviderKey, typeof integrations> = {
      shopify: [],
      woocommerce: [],
      custom_api: [],
      csv: [],
    };
    for (const it of integrations) grouped[it.provider as ProviderKey].push(it);
    return grouped;
  }, [integrations]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Connectivity"
        title="Integrations"
        description="Connect Shopify, WooCommerce, your custom commerce stack, or fall back to CSV — orders, fraud scoring, and notifications are wired in automatically."
        actions={
          <Button variant="outline" onClick={() => list.refetch()}>
            <RefreshCcw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        }
      />

      {entitlements.data ? (
        <EntitlementBanner ent={entitlements.data} />
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(Object.keys(PROVIDER_META) as ProviderKey[]).map((key) => {
          const meta = PROVIDER_META[key];
          const Icon = meta.icon;
          const list = providersByKey[key];
          const ent = entitlements.data;
          const providerAllowed = !ent || ent.integrationProviders.includes(key);
          const slotAvailable =
            !ent ||
            key === "csv" ||
            ent.maxIntegrations === 0 ||
            ent.activeIntegrationCount < ent.maxIntegrations;
          // slotAvailable is always true for "csv" (set on the line above), so
          // we don't need a redundant key check here.
          const locked = !providerAllowed || !slotAvailable;
          const lockReason = !providerAllowed
            ? `Requires ${TIER_LABEL[ent?.recommendedUpgradeTier ?? "growth"] ?? "upgrade"}`
            : !slotAvailable
              ? `Plan cap (${ent?.activeIntegrationCount}/${ent?.maxIntegrations})`
              : null;
          return (
            <Card key={key} className={locked ? "opacity-80" : undefined}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${meta.tone}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <Badge variant="outline" className="border-stroke/12 text-2xs uppercase tracking-wide text-fg-subtle">
                    {list.length} active
                  </Badge>
                </div>
                <CardTitle className="mt-3 text-base">{meta.label}</CardTitle>
                <p className="text-xs text-fg-subtle">{meta.description}</p>
                {locked && lockReason ? (
                  <p className="mt-1 text-2xs">
                    <InlineLockedFeature
                      requiredTier={(ent?.recommendedUpgradeTier ?? "growth") as "growth" | "scale" | "enterprise" | "starter"}
                      locked
                      feature={`${meta.label} integration`}
                      hint="Upgrade to connect this commerce platform."
                    >
                      {lockReason}
                    </InlineLockedFeature>
                  </p>
                ) : null}
              </CardHeader>
              <CardContent className="flex items-center justify-between">
                <span className="text-xs text-fg-faint">
                  {list.length === 0 ? "Not connected" : `Last sync: ${formatRelative(list[0]?.lastSyncAt)}`}
                </span>
                {locked ? (
                  <Button asChild size="sm" variant="outline">
                    <a href="/dashboard/billing">
                      <Sparkles className="mr-1 h-3.5 w-3.5" /> Upgrade
                    </a>
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setOpenProvider(key)}>
                    <Plug className="mr-1 h-3.5 w-3.5" /> Connect
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <p className="text-xs text-fg-subtle">
            Active and historical connectors. Webhook delivery health is tracked per integration.
          </p>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <div className="flex items-center justify-center py-12 text-fg-subtle">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : integrations.length === 0 ? (
            <EmptyState
              icon={Plug}
              title="No integrations yet"
              description="Connect a commerce platform to start streaming orders, or paste your CSV in Orders › Bulk upload."
            />
          ) : (
            <div className="divide-y divide-stroke/8">
              {integrations.map((it) => {
                const meta = PROVIDER_META[it.provider as ProviderKey];
                const Icon = meta?.icon ?? Plug;
                return (
                  <div key={it.id} className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${meta?.tone ?? "bg-surface-raised"}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-fg">{it.label ?? meta?.label}</p>
                          <StatusPill status={it.status} healthOk={it.health.ok} />
                        </div>
                        <p className="text-xs text-fg-subtle">{it.accountKey}</p>
                        <p className="text-2xs text-fg-faint">
                          {it.counts.ordersImported} imported · {it.counts.ordersFailed} failed · webhook events {it.webhookStatus.lastEventAt ? formatRelative(it.webhookStatus.lastEventAt) : "—"}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {it.health.ok ? (
                        <span className="inline-flex items-center gap-1 text-2xs text-success">
                          <ShieldCheck className="h-3.5 w-3.5" /> Healthy
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-2xs text-danger">
                          <AlertTriangle className="h-3.5 w-3.5" /> {it.health.lastError ?? "Error"}
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={test.isPending}
                        onClick={() => test.mutate({ id: it.id })}
                      >
                        Test
                      </Button>
                      {it.provider !== "csv" && it.provider !== "custom_api" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={importNow.isPending}
                          onClick={() => importNow.mutate({ id: it.id, limit: 25 })}
                        >
                          Import recent
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disconnect.isPending}
                        onClick={() => disconnect.mutate({ id: it.id })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <Webhook className="h-4 w-4" /> Recent webhook deliveries
              </span>
            </CardTitle>
            <p className="text-xs text-fg-subtle">
              Idempotent ingestion — duplicates short-circuit before any order writes.
            </p>
          </CardHeader>
          <CardContent>
            {recent.isLoading ? (
              <div className="text-fg-subtle">Loading…</div>
            ) : (recent.data ?? []).length === 0 ? (
              <p className="text-xs text-fg-faint">No webhooks received yet.</p>
            ) : (
              <ul className="space-y-2">
                {(recent.data ?? []).map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-1 rounded-md border border-stroke/8 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-fg">
                        {row.provider} · {row.topic}
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={
                            row.deadLetteredAt
                              ? "bg-danger-subtle text-danger"
                              : row.status === "succeeded"
                                ? "bg-success-subtle text-success"
                                : row.status === "failed"
                                  ? "bg-danger-subtle text-danger"
                                  : "bg-warning-subtle text-warning"
                          }
                        >
                          {row.deadLetteredAt ? "dead-lettered" : row.status}
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-2xs"
                          onClick={() => setInspectId(row.id)}
                        >
                          <Eye className="mr-1 h-3 w-3" /> Inspect
                        </Button>
                        {row.canReplay ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-2xs"
                            disabled={replay.isPending}
                            onClick={() => replay.mutate({ id: row.id })}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" /> Replay
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div className="text-fg-faint">
                      ext: {row.externalId} · {formatRelative(row.receivedAt)}
                      {row.attempts ? ` · ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}` : ""}
                      {row.lastError ? ` · ${row.lastError}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> Behavior tracker
              </span>
            </CardTitle>
            <p className="text-xs text-fg-subtle">
              Drop this snippet on every storefront page. Browsing, cart, and checkout intent flow into
              behavior analytics + identity-resolves to orders automatically.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {tracking.isLoading ? (
              <div className="text-fg-subtle">Loading…</div>
            ) : tracking.data ? (
              <>
                <TrackerInstallBadge install={tracking.data.install} />
                <div className="space-y-1.5">
                  <Label>Public tracking key</Label>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={tracking.data.key} />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(tracking.data!.key);
                        toast.success("Tracking key copied");
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Embed snippet</Label>
                  <pre className="overflow-x-auto rounded-md border border-stroke/12 bg-surface-raised p-3 text-2xs text-fg">
                    <code>{tracking.data.snippet}</code>
                  </pre>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(tracking.data!.snippet);
                      toast.success("Snippet copied");
                    }}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" /> Copy snippet
                  </Button>
                </div>
                <p className="text-2xs text-fg-faint">
                  Need to rotate the key? Open Settings → Tracking and rotate. The new key invalidates the
                  old immediately.
                </p>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <ConnectDialog
        open={openProvider !== null}
        provider={openProvider}
        onClose={() => setOpenProvider(null)}
        onSubmit={(payload) => connect.mutate(payload)}
        isPending={connect.isPending}
      />

      <InspectWebhookDialog
        id={inspectId}
        onClose={() => setInspectId(null)}
        onReplay={(id) => replay.mutate({ id })}
        replayPending={replay.isPending}
      />

      <ImportProgressDialog
        jobId={activeImportJobId}
        progress={importProgress.data}
        onClose={() => setActiveImportJobId(null)}
      />
    </div>
  );
}

function ImportProgressDialog({
  jobId,
  progress,
  onClose,
}: {
  jobId: string | null;
  progress: RouterOutputs["integrations"]["getImportJob"] | undefined;
  onClose: () => void;
}) {
  const open = jobId !== null;
  const finished =
    progress?.status === "succeeded" ||
    progress?.status === "failed" ||
    progress?.status === "cancelled";
  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {progress?.status === "running"
              ? "Importing orders…"
              : progress?.status === "succeeded"
                ? "Import complete"
                : progress?.status === "failed"
                  ? "Import failed"
                  : "Import queued"}
          </DialogTitle>
        </DialogHeader>
        {!progress ? (
          <div className="flex items-center justify-center py-6 text-fg-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-fg-subtle">Provider</span>
              <span className="font-mono text-fg">{progress.provider}</span>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-fg-subtle">Progress</span>
                <span className="text-fg">
                  {progress.processedRows} / {progress.totalRows || "?"}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
                <div
                  className={`h-2 rounded-full transition-all ${
                    progress.status === "failed" ? "bg-danger" : "bg-brand"
                  }`}
                  style={{ width: `${progress.progressPct}%` }}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border border-stroke/8 px-2 py-2">
                <div className="text-fg-faint text-2xs uppercase">Imported</div>
                <div className="text-base font-semibold text-success">{progress.importedRows}</div>
              </div>
              <div className="rounded-md border border-stroke/8 px-2 py-2">
                <div className="text-fg-faint text-2xs uppercase">Duplicates</div>
                <div className="text-base font-semibold text-fg">{progress.duplicateRows}</div>
              </div>
              <div className="rounded-md border border-stroke/8 px-2 py-2">
                <div className="text-fg-faint text-2xs uppercase">Failed</div>
                <div className="text-base font-semibold text-danger">{progress.failedRows}</div>
              </div>
            </div>
            {progress.lastError ? (
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-danger-border bg-danger-subtle p-2 text-2xs text-danger">
                {progress.lastError}
              </pre>
            ) : null}
            {finished ? (
              <div className="flex justify-end">
                <Button size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import type { RouterOutputs } from "@ecom/types";

type EntitlementsViewData = RouterOutputs["integrations"]["getEntitlements"];

function EntitlementBanner({ ent }: { ent: EntitlementsViewData }) {
  // Don't badger Enterprise customers — they already have everything.
  if (ent.tier === "enterprise" || !ent.recommendedUpgradeTier) return null;
  const lockedProviders = (["shopify", "woocommerce", "custom_api"] as const).filter(
    (p) => !ent.integrationProviders.includes(p),
  );
  const slotsTight =
    ent.maxIntegrations > 0 && ent.remainingIntegrationSlots === 0;
  if (lockedProviders.length === 0 && !slotsTight) return null;
  const next = TIER_LABEL[ent.recommendedUpgradeTier] ?? ent.recommendedUpgradeTier;
  return (
    <Card className="border-warning-border bg-warning-subtle/40">
      <CardContent className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-4 w-4 text-warning" />
          <div>
            <p className="text-sm font-semibold text-fg">
              {slotsTight
                ? `You've used your plan's ${ent.maxIntegrations} commerce integration${ent.maxIntegrations === 1 ? "" : "s"}.`
                : `Unlock ${lockedProviders.map((p) => PROVIDER_META[p].label).join(", ")} on ${next}.`}
            </p>
            <p className="text-xs text-fg-subtle">
              {slotsTight
                ? `Upgrade to ${next} for additional connector slots.`
                : `Currently on ${TIER_LABEL[ent.tier]}.`}
            </p>
          </div>
        </div>
        <Button asChild size="sm">
          <a href="/dashboard/billing">
            <Sparkles className="mr-1 h-3.5 w-3.5" /> See plans
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}

function InspectWebhookDialog({
  id,
  onClose,
  onReplay,
  replayPending,
}: {
  id: string | null;
  onClose: () => void;
  onReplay: (id: string) => void;
  replayPending: boolean;
}) {
  const open = id !== null;
  const detail = trpc.integrations.inspectWebhook.useQuery(
    { id: id ?? "" },
    { enabled: open },
  );
  const row = detail.data;

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Webhook delivery</DialogTitle>
        </DialogHeader>
        {detail.isLoading ? (
          <div className="flex items-center justify-center py-8 text-fg-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : row ? (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Provider</Label>
                <p className="font-medium text-fg">{row.provider}</p>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Topic</Label>
                <p className="font-medium text-fg">{row.topic}</p>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">External id</Label>
                <p className="font-mono text-fg">{row.externalId}</p>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Status</Label>
                <Badge
                  variant="outline"
                  className={
                    row.deadLetteredAt
                      ? "bg-danger-subtle text-danger"
                      : row.status === "succeeded"
                        ? "bg-success-subtle text-success"
                        : row.status === "failed"
                          ? "bg-danger-subtle text-danger"
                          : "bg-warning-subtle text-warning"
                  }
                >
                  {row.deadLetteredAt ? "dead-lettered" : row.status}
                </Badge>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Attempts</Label>
                <p className="font-medium text-fg">{row.attempts}</p>
              </div>
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Received</Label>
                <p className="text-fg">{formatRelative(row.receivedAt)}</p>
              </div>
              {row.nextRetryAt ? (
                <div>
                  <Label className="text-2xs uppercase text-fg-faint">Next retry</Label>
                  <p className="text-fg">{formatRelative(row.nextRetryAt)}</p>
                </div>
              ) : null}
              {row.deadLetteredAt ? (
                <div>
                  <Label className="text-2xs uppercase text-fg-faint">Dead-lettered</Label>
                  <p className="text-danger">{formatRelative(row.deadLetteredAt)}</p>
                </div>
              ) : null}
            </div>

            {row.lastError ? (
              <div>
                <Label className="text-2xs uppercase text-fg-faint">Last error</Label>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-danger-border bg-danger-subtle p-2 text-2xs text-danger">
                  {row.lastError}
                </pre>
              </div>
            ) : null}

            <div>
              <Label className="text-2xs uppercase text-fg-faint">
                Payload ({row.payloadBytes} bytes)
              </Label>
              <pre className="max-h-72 overflow-auto rounded-md border border-stroke/12 bg-surface-raised p-2 text-2xs text-fg">
                {row.payload ? JSON.stringify(row.payload, null, 2) : "(empty)"}
              </pre>
            </div>

            <div className="flex justify-end gap-2">
              {row.canReplay ? (
                <Button
                  size="sm"
                  disabled={replayPending}
                  onClick={() => onReplay(row.id)}
                >
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                  {replayPending ? "Replaying…" : "Replay now"}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <p className="py-4 text-xs text-fg-faint">Webhook not found.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ShopifyForm {
  provider: "shopify";
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
  accessToken?: string;
  scopes: string[];
}
interface WooForm {
  provider: "woocommerce";
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
}
interface CustomForm {
  provider: "custom_api";
  label?: string;
}
interface CsvForm {
  provider: "csv";
  label?: string;
}

type ConnectPayload = ShopifyForm | WooForm | CustomForm | CsvForm;

function ConnectDialog({
  open,
  provider,
  onClose,
  onSubmit,
  isPending,
}: {
  open: boolean;
  provider: ProviderKey | null;
  onClose: () => void;
  onSubmit: (payload: ConnectPayload) => void;
  isPending: boolean;
}) {
  const [shopify, setShopify] = useState({
    shopDomain: "",
    apiKey: "",
    apiSecret: "",
    accessToken: "",
  });
  const [woo, setWoo] = useState({ siteUrl: "", consumerKey: "", consumerSecret: "" });
  const [label, setLabel] = useState("");

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {provider ? PROVIDER_META[provider].label : ""}</DialogTitle>
        </DialogHeader>
        {provider === "shopify" ? (
          <div className="space-y-3">
            <div>
              <Label>Shop domain</Label>
              <Input
                placeholder="my-shop.myshopify.com"
                value={shopify.shopDomain}
                onChange={(e) => setShopify({ ...shopify, shopDomain: e.target.value })}
              />
            </div>
            <div>
              <Label>App API key</Label>
              <Input
                value={shopify.apiKey}
                onChange={(e) => setShopify({ ...shopify, apiKey: e.target.value })}
              />
            </div>
            <div>
              <Label>App API secret</Label>
              <Input
                type="password"
                value={shopify.apiSecret}
                onChange={(e) => setShopify({ ...shopify, apiSecret: e.target.value })}
              />
            </div>
            <div>
              <Label>Access token (optional — leave blank to start OAuth)</Label>
              <Input
                type="password"
                value={shopify.accessToken}
                onChange={(e) => setShopify({ ...shopify, accessToken: e.target.value })}
              />
            </div>
            <Button
              className="w-full"
              disabled={isPending || !shopify.shopDomain || !shopify.apiKey || !shopify.apiSecret}
              onClick={() =>
                onSubmit({
                  provider: "shopify",
                  shopDomain: shopify.shopDomain.trim(),
                  apiKey: shopify.apiKey.trim(),
                  apiSecret: shopify.apiSecret.trim(),
                  accessToken: shopify.accessToken?.trim() || undefined,
                  scopes: ["read_orders", "write_orders", "read_customers"],
                })
              }
            >
              {isPending ? "Connecting…" : "Connect"}
              <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </Button>
          </div>
        ) : provider === "woocommerce" ? (
          <div className="space-y-3">
            <div>
              <Label>Site URL</Label>
              <Input
                placeholder="https://my-store.com"
                value={woo.siteUrl}
                onChange={(e) => setWoo({ ...woo, siteUrl: e.target.value })}
              />
            </div>
            <div>
              <Label>Consumer key</Label>
              <Input
                value={woo.consumerKey}
                onChange={(e) => setWoo({ ...woo, consumerKey: e.target.value })}
              />
            </div>
            <div>
              <Label>Consumer secret</Label>
              <Input
                type="password"
                value={woo.consumerSecret}
                onChange={(e) => setWoo({ ...woo, consumerSecret: e.target.value })}
              />
            </div>
            <Button
              className="w-full"
              disabled={isPending || !woo.siteUrl || !woo.consumerKey || !woo.consumerSecret}
              onClick={() =>
                onSubmit({
                  provider: "woocommerce",
                  siteUrl: woo.siteUrl.trim(),
                  consumerKey: woo.consumerKey.trim(),
                  consumerSecret: woo.consumerSecret.trim(),
                })
              }
            >
              {isPending ? "Connecting…" : "Connect"}
            </Button>
          </div>
        ) : provider === "custom_api" || provider === "csv" ? (
          <div className="space-y-3">
            <div>
              <Label htmlFor="connector-label">Label (optional)</Label>
              <Input
                id="connector-label"
                placeholder="e.g. Wholesale storefront"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <p className="text-xs text-fg-subtle">
              {provider === "custom_api"
                ? "We'll mint a signing key + webhook URL for your backend to push orders."
                : "Use Orders → Bulk upload to import CSVs. We'll register this connector for tracking."}
            </p>
            <Button
              className="w-full"
              disabled={isPending}
              onClick={() =>
                onSubmit({
                  provider: provider as "custom_api" | "csv",
                  label: label.trim() || undefined,
                })
              }
            >
              {isPending ? "Connecting…" : "Create"}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TrackerInstallBadge({
  install,
}: {
  install: {
    status: "not_installed" | "stale" | "healthy";
    lastSeenAt: Date | string | null;
    sessionCount: number;
    latestEventType: string | null;
  };
}) {
  if (install.status === "healthy") {
    return (
      <div
        data-testid="tracker-install-badge"
        data-status="healthy"
        className="flex items-start gap-2 rounded-md border border-success-border bg-success-subtle px-3 py-2 text-xs text-success"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="font-semibold">Tracker is firing</span> — last event{" "}
          {install.lastSeenAt ? formatRelative(install.lastSeenAt) : "just now"} ·{" "}
          {install.sessionCount.toLocaleString()} sessions captured.
        </span>
      </div>
    );
  }
  if (install.status === "stale") {
    return (
      <div
        data-testid="tracker-install-badge"
        data-status="stale"
        className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="font-semibold">Tracker has gone quiet</span> — no events in over 7
          days. Your storefront may have removed the snippet. Last seen{" "}
          {install.lastSeenAt ? formatRelative(install.lastSeenAt) : "—"}.
        </span>
      </div>
    );
  }
  return (
    <div
      data-testid="tracker-install-badge"
      data-status="not_installed"
      className="flex items-start gap-2 rounded-md border border-info-border bg-info-subtle px-3 py-2 text-xs text-info"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <span className="font-semibold">Tracker not installed yet</span> — paste the snippet on
        every page of your storefront and load any product page once. We'll detect the first
        event within seconds.
      </span>
    </div>
  );
}
