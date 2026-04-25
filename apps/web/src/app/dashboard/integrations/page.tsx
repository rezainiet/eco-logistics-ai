"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Plug,
  RefreshCcw,
  ShieldCheck,
  ShoppingBag,
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

export default function IntegrationsPage() {
  const list = trpc.integrations.list.useQuery();
  const tracking = trpc.tracking.getInstallation.useQuery();
  const recent = trpc.integrations.recentWebhooks.useQuery({ limit: 10 });
  const [openProvider, setOpenProvider] = useState<ProviderKey | null>(null);
  const utils = trpc.useUtils();

  const connect = trpc.integrations.connect.useMutation({
    onSuccess: (data) => {
      toast.success(
        data.status === "connected"
          ? "Integration connected"
          : "Connection started — finish OAuth to activate",
      );
      void utils.integrations.list.invalidate();
      setOpenProvider(null);
      if (data.installUrl) {
        window.open(data.installUrl, "_blank", "noopener,noreferrer");
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const test = trpc.integrations.test.useMutation({
    onSuccess: (r) => {
      if (r.ok) toast.success(r.detail ?? "Connection ok");
      else toast.error(r.detail ?? "Connection failed");
      void utils.integrations.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const importNow = trpc.integrations.importOrders.useMutation({
    onSuccess: (r) => {
      toast.success(
        `Imported ${r.imported}, deduped ${r.duplicates}, failed ${r.failed} (scanned ${r.scanned})`,
      );
      void utils.integrations.list.invalidate();
      void utils.integrations.recentWebhooks.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const disconnect = trpc.integrations.disconnect.useMutation({
    onSuccess: () => {
      toast.success("Integration disconnected");
      void utils.integrations.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(Object.keys(PROVIDER_META) as ProviderKey[]).map((key) => {
          const meta = PROVIDER_META[key];
          const Icon = meta.icon;
          const list = providersByKey[key];
          return (
            <Card key={key}>
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
              </CardHeader>
              <CardContent className="flex items-center justify-between">
                <span className="text-xs text-fg-faint">
                  {list.length === 0 ? "Not connected" : `Last sync: ${formatRelative(list[0]?.lastSyncAt)}`}
                </span>
                <Button size="sm" onClick={() => setOpenProvider(key)}>
                  <Plug className="mr-1 h-3.5 w-3.5" /> Connect
                </Button>
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
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-fg">
                        {row.provider} · {row.topic}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          row.status === "succeeded"
                            ? "bg-success-subtle text-success"
                            : row.status === "failed"
                              ? "bg-danger-subtle text-danger"
                              : "bg-warning-subtle text-warning"
                        }
                      >
                        {row.status}
                      </Badge>
                    </div>
                    <div className="text-fg-faint">
                      ext: {row.externalId} · {formatRelative(row.receivedAt)}
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
    </div>
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
              <Label>Label (optional)</Label>
              <Input
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
