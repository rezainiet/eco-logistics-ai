"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  HelpCircle,
  Loader2,
  Lock,
  PartyPopper,
  Plug,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "@/components/ui/toast";
import { formatLastSync, formatRelative, formatRelativeOr } from "@/lib/formatters";
import { InlineLockedFeature } from "@/components/billing/locked-feature";
import { TrackerInstallBadge } from "@/components/integrations/tracker-install-badge";
import { ImportProgressDialog } from "@/components/integrations/import-progress-dialog";
import { InspectWebhookDialog } from "@/components/integrations/inspect-webhook-dialog";

type ProviderKey = "shopify" | "woocommerce" | "custom_api" | "csv";

const PROVIDER_META: Record<
  ProviderKey,
  { label: string; description: string; icon: typeof ShoppingBag; tone: string }
> = {
  shopify: {
    label: "Shopify",
    description: "Real-time order sync via OAuth + verified automatic updates.",
    icon: ShoppingBag,
    tone: "bg-[hsl(146_60%_42%/0.12)] text-[hsl(146_60%_60%)]",
  },
  woocommerce: {
    label: "WooCommerce",
    description: "REST API connect with signed automatic updates.",
    icon: Store,
    tone: "bg-[hsl(286_67%_52%/0.12)] text-[hsl(286_67%_72%)]",
  },
  custom_api: {
    label: "Custom API",
    description: "Push orders from any storefront via signed automatic update.",
    icon: Code2,
    tone: "bg-info-subtle text-info",
  },
  csv: {
    label: "CSV import",
    description: "Not a connector — bulk-upload a spreadsheet of orders any time from the Orders page.",
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

  // Inline state for the post-connect "Open Shopify install" fallback
  // card. Always-visible install URL means popup-blockers can't strand
  // the merchant — they get a copyable link + a primary button to
  // continue manually.
  const [pendingInstall, setPendingInstall] = useState<{
    integrationId: string;
    installUrl: string;
    shop: string;
  } | null>(null);

  // When `connect` returns `alreadyConnected: true`, we surface a
  // confirmation dialog instead of silently overwriting the merchant's
  // working integration. Stored input is what we re-issue on confirm.
  const [reconnectPrompt, setReconnectPrompt] = useState<{
    payload: ConnectPayload;
    integrationId: string;
  } | null>(null);

  const connect = trpc.integrations.connect.useMutation({
    onSuccess: (data, variables) => {
      void utils.integrations.list.invalidate();
      void utils.integrations.getEntitlements.invalidate();
      // Reconnect-safety short-circuit. The router refused to overwrite
      // a connected store; ask the merchant first.
      if ("alreadyConnected" in data && data.alreadyConnected) {
        setOpenProvider(null);
        setReconnectPrompt({
          payload: variables as ConnectPayload,
          integrationId: data.id,
        });
        return;
      }
      // Shopify OAuth path — show the popup-fallback card with an
      // always-visible install URL. We still try `window.open` as a
      // convenience, but the card is the source of truth so blocked
      // popups never strand the merchant.
      if (data.installUrl && variables.provider === "shopify") {
        const shop =
          (variables as { shopDomain?: string }).shopDomain ?? "your store";
        setPendingInstall({
          integrationId: data.id,
          installUrl: data.installUrl,
          shop,
        });
        setOpenProvider(null);
        // Best-effort popup. Ignore failure — the inline button below is
        // the primary action.
        try {
          window.open(data.installUrl, "_blank", "noopener,noreferrer");
        } catch {
          /* popup blocked — inline button covers us */
        }
        toast.success(
          "Almost there — click 'Open Shopify install' below to finish.",
        );
        return;
      }
      // Non-Shopify connectors land directly in connected state. Show the
      // celebratory success card.
      toast.success(
        data.status === "connected"
          ? "Integration connected"
          : "We're verifying your store — finish OAuth to activate",
      );
      setOpenProvider(null);
      if (data.status === "connected") {
        setSuccessState({
          integrationId: data.id,
          shop: null,
          provider: variables.provider as ProviderKey,
        });
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
      // Backend signals "we have no Shopify app credentials configured —
      // ask the merchant to fill the Advanced section."
      if (err.message.startsWith("shopify_credentials_required")) {
        toast.error(
          "Connect needs your Shopify app credentials. Open Advanced (for developers) and paste your API key + secret.",
        );
        return;
      }
      // One-shop-per-provider guard. Server returns
      // `integration_provider_one_shop_only:<existing-account-key>` so we
      // can name the existing store in the toast and tell the merchant
      // exactly what to do.
      if (err.message.startsWith("integration_provider_one_shop_only")) {
        const existing = err.message.split(":")[1] ?? "another store";
        toast.error(
          `You're already connected to ${existing}.`,
          "Disconnect that store first to switch to a different one.",
        );
        setOpenProvider(null);
        return;
      }
      toast.error(humanizeError(err));
    },
  });

  /**
   * Last test-connection result, keyed by integration id. Displayed
   * inline below the row for ~10s so the merchant sees a clear pass/fail
   * banner without hunting for a toast.
   */
  const [testResult, setTestResult] = useState<{
    id: string;
    ok: boolean;
    detail: string | null;
    latencyMs: number | null;
    at: number;
  } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const test = trpc.integrations.test.useMutation({
    onMutate: ({ id }) => {
      setTestingId(id);
    },
    onSuccess: (r, vars) => {
      setTestResult({
        id: vars.id,
        ok: r.ok,
        detail: r.detail ?? null,
        latencyMs: "latencyMs" in r ? r.latencyMs : null,
        at: Date.now(),
      });
      if (r.ok) {
        toast.success(r.detail ?? "Connection successful");
      } else {
        toast.error(r.detail ?? "Connection failed");
      }
      void utils.integrations.list.invalidate();
    },
    onError: (err, vars) => {
      setTestResult({
        id: vars.id,
        ok: false,
        detail: err.message,
        latencyMs: null,
        at: Date.now(),
      });
      toast.error(humanizeError(err));
    },
    onSettled: () => {
      setTestingId(null);
    },
  });
  // Auto-clear the inline banner 10s after each test so the row reverts
  // to its normal appearance.
  useEffect(() => {
    if (!testResult) return;
    const t = setTimeout(() => setTestResult(null), 10_000);
    return () => clearTimeout(t);
  }, [testResult]);

  const [activeImportJobId, setActiveImportJobId] = useState<string | null>(null);
  const importNow = trpc.integrations.importOrders.useMutation({
    onSuccess: (r) => {
      setActiveImportJobId(r.jobId);
      toast.success("Import queued — progress will appear in a moment.");
      void utils.integrations.recentWebhooks.invalidate();
    },
    onError: (err) => toast.error(humanizeError(err)),
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

  // Disconnect needs to invalidate BOTH integrations.list (so the row
  // disappears from the Connections panel) AND getEntitlements (so the
  // Shopify/WooCommerce card flips back from disabled "Connected" to
  // active "Connect" — `existingShopByProvider` and `activeIntegrationCount`
  // both come out of getEntitlements).
  const disconnect = trpc.integrations.disconnect.useMutation({
    onSuccess: () => {
      toast.success("Integration disconnected");
      void utils.integrations.list.invalidate();
      void utils.integrations.getEntitlements.invalidate();
    },
    onError: (err) => toast.error(humanizeError(err)),
  });

  const replay = trpc.integrations.replayWebhook.useMutation({
    onSuccess: (r) => {
      if (r.status === "succeeded") {
        toast.success(
          r.duplicate
            ? "Replay succeeded (duplicate — order already existed)"
            : "Update replayed successfully",
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
    onError: (err) => toast.error(humanizeError(err)),
  });

  // Post-connection celebratory state — shows the merchant a clear "you
  // did it" moment with a single big CTA to import their last 25 orders.
  // Set when the OAuth callback lands AND when the simple connect flow
  // completes for a non-Shopify provider that goes straight to "connected".
  const [successState, setSuccessState] = useState<{
    integrationId: string | null;
    shop: string | null;
    provider: ProviderKey;
  } | null>(null);

  // Pick up the redirect from the Shopify OAuth callback. Strips the search
  // params after notifying so a refresh doesn't re-fire the toast. Also
  // broadcasts the event to other open tabs so they refresh immediately
  // rather than showing stale "pending" rows.
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
      setSuccessState({
        integrationId: null,
        shop,
        provider: "shopify",
      });
      // Notify any other tab the merchant left open. Listener below picks
      // this up and invalidates its own cache.
      try {
        const ch = new BroadcastChannel("ecom:integrations");
        ch.postMessage({ type: "shopify_connected", shop });
        ch.close();
      } catch {
        /* BroadcastChannel unsupported — fall through to localStorage. */
      }
      try {
        // localStorage write fires a `storage` event in OTHER tabs (not
        // the originating one) — this is our second sync channel for
        // browsers without BroadcastChannel (Safari < 15.4 etc.).
        window.localStorage.setItem(
          "ecom:integrations:bump",
          String(Date.now()),
        );
      } catch {
        /* Storage may be blocked in some incognito modes. */
      }
    } else if (error) {
      // Merchant-friendly mapping. Whenever a code might confuse a
      // non-technical merchant, we say what likely went wrong + how to
      // recover, without leaking the upstream error vocabulary.
      const detail: Record<string, string> = {
        user_cancelled:
          "You cancelled the connection on Shopify. Click Connect to try again.",
        missing_params:
          "Shopify didn't return the expected information. Click Connect to start again.",
        invalid_shop:
          "Your store address looks wrong. Use the format mystore.myshopify.com.",
        integration_not_found:
          "We couldn't find your in-progress connection. Click Connect to start again.",
        state_mismatch:
          "The connection took too long to complete. Click Connect to try again.",
        credential_decrypt_failed:
          "We couldn't read your stored credentials. Click Connect to try again.",
        hmac_mismatch:
          "Your store address or API key is incorrect. Double-check and try again.",
        token_exchange_failed:
          "We couldn't connect right now. Please try again in a moment.",
        shopify_install_rejected:
          "Shopify didn't accept the install request. Make sure your store address is correct and try again.",
      };
      toast.error(
        detail[error] ?? "Something went wrong while connecting. Please try again.",
      );
    }
    const url = new URL(window.location.href);
    url.search = "";
    window.history.replaceState({}, "", url.toString());
  }, [utils]);

  // Cross-tab sync — listen for connection events broadcast by another
  // tab and refresh our own integrations list without requiring the
  // merchant to manually reload. Two channels for browser coverage:
  //   - BroadcastChannel (modern, same-origin, instant)
  //   - localStorage `storage` event (legacy fallback)
  useEffect(() => {
    if (typeof window === "undefined") return;
    let ch: BroadcastChannel | null = null;
    const handleMessage = () => {
      void utils.integrations.list.invalidate();
      void utils.integrations.recentWebhooks.invalidate();
    };
    try {
      ch = new BroadcastChannel("ecom:integrations");
      ch.addEventListener("message", handleMessage);
    } catch {
      /* not supported — fall through to storage */
    }
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "ecom:integrations:bump") handleMessage();
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      if (ch) {
        ch.removeEventListener("message", handleMessage);
        ch.close();
      }
      window.removeEventListener("storage", handleStorage);
    };
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
          // For domain-keyed connectors (Shopify, WooCommerce) a merchant
          // may only have ONE active integration. Surface the existing
          // store right on the card so the merchant doesn't try to add a
          // second one and hit the server-side guard mid-OAuth.
          const existingShop =
            (key === "shopify" || key === "woocommerce") && ent?.existingShopByProvider
              ? ent.existingShopByProvider[key] ?? null
              : null;
          const oneShopBlocked = !!existingShop;
          // slotAvailable is always true for "csv" (set on the line above), so
          // we don't need a redundant key check here.
          const locked = !providerAllowed || !slotAvailable || oneShopBlocked;
          const lockReason = !providerAllowed
            ? `Requires ${TIER_LABEL[ent?.recommendedUpgradeTier ?? "growth"] ?? "upgrade"}`
            : !slotAvailable
              ? `Plan cap (${ent?.activeIntegrationCount}/${ent?.maxIntegrations})`
              : oneShopBlocked
                ? `Already connected to ${existingShop}`
                : null;
          return (
            <Card
              key={key}
              data-testid={`provider-card-${key}`}
              className={locked ? "opacity-80" : undefined}
            >
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
                  {key === "csv"
                    ? "Manual upload · always available"
                    : list.length === 0
                      ? "Not connected"
                      : formatLastSync(list[0]?.lastSyncAt, list[0]?.connectedAt)}
                </span>
                {oneShopBlocked ? (
                  // Already connected to a store on this provider — surface
                  // that explicitly instead of routing to billing (which is
                  // what plan-cap locks do).
                  <Button
                    size="sm"
                    variant="outline"
                    disabled
                    title={`Already connected to ${existingShop}. Disconnect first to switch stores.`}
                  >
                    Connected
                  </Button>
                ) : locked ? (
                  <Button asChild size="sm" variant="outline">
                    <a href="/dashboard/billing">
                      <Sparkles className="mr-1 h-3.5 w-3.5" /> Upgrade
                    </a>
                  </Button>
                ) : key === "csv" ? (
                  // CSV isn't a real connector — there's no API to wire up.
                  // Send the merchant straight to the Orders page where the
                  // Bulk Upload dialog lives, instead of opening a modal that
                  // would just create a placeholder integration record.
                  <Button asChild size="sm" variant="outline">
                    <a href="/dashboard/orders?bulk=1">
                      <FileText className="mr-1 h-3.5 w-3.5" /> Open uploader
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
            Active and historical connectors. Update delivery health is tracked per integration.
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
                const showTestBanner = testResult?.id === it.id;
                return (
                  <div key={it.id} className="border-b border-stroke/8 py-4 last:border-0">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
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
                          {it.counts.ordersImported === 0 &&
                          it.counts.ordersFailed === 0 &&
                          !it.webhookStatus.lastEventAt
                            ? "Waiting for the first event — usually within a minute of a real order"
                            : `${it.counts.ordersImported} imported · ${it.counts.ordersFailed} failed · last update ${formatRelativeOr(
                                it.webhookStatus.lastEventAt,
                                "—",
                              )}`}
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
                        disabled={testingId === it.id}
                        onClick={() => test.mutate({ id: it.id })}
                      >
                        {testingId === it.id ? (
                          <>
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            Testing…
                          </>
                        ) : (
                          <>
                            <Plug className="mr-1 h-3.5 w-3.5" />
                            Test connection
                          </>
                        )}
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
                    {showTestBanner && testResult ? (
                      <div
                        role="status"
                        aria-live="polite"
                        className={`mt-3 flex items-start gap-2 rounded-md border p-3 text-xs ${
                          testResult.ok
                            ? "border-success-border bg-success-subtle text-success"
                            : "border-danger-border bg-danger-subtle text-danger"
                        }`}
                      >
                        {testResult.ok ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        ) : (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="font-semibold">
                            {testResult.ok ? "Connection successful" : "Connection failed"}
                            {testResult.ok && testResult.latencyMs !== null ? (
                              <span className="ml-2 font-normal opacity-80">
                                ({testResult.latencyMs}ms)
                              </span>
                            ) : null}
                          </p>
                          {testResult.detail ? (
                            <p className="break-words font-normal opacity-90">
                              {testResult.detail}
                            </p>
                          ) : null}
                          {!testResult.ok ? (
                            <p className="font-normal opacity-80">
                              Common fixes: check your API key &amp; secret, re-approve the
                              custom app in Shopify, or reconnect to refresh the access token.
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
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
                <Webhook className="h-4 w-4" /> Recent automatic updates
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
              <p className="text-xs text-fg-faint">No updates received yet.</p>
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
        platformShopifyConfigured={
          entitlements.data?.platformShopifyConfigured ?? true
        }
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

      <ShopifyInstallFallback
        state={pendingInstall}
        onClose={() => setPendingInstall(null)}
      />

      <ConnectionSuccessDialog
        state={successState}
        onClose={() => setSuccessState(null)}
        onImport={(integrationId) => {
          importNow.mutate({ id: integrationId, limit: 25 });
          setSuccessState(null);
        }}
      />

      <ReconnectConfirmDialog
        state={reconnectPrompt}
        isPending={connect.isPending}
        onCancel={() => setReconnectPrompt(null)}
        onConfirm={() => {
          if (!reconnectPrompt) return;
          // Re-issue the same payload with the explicit overwrite flag set
          // so the backend allows credential rotation. Only meaningful for
          // Shopify today; other providers don't reach this branch.
          const payload = reconnectPrompt.payload;
          if (payload.provider !== "shopify") {
            setReconnectPrompt(null);
            return;
          }
          connect.mutate({ ...payload, confirmOverwrite: true });
          setReconnectPrompt(null);
        }}
      />
    </div>
  );
}

import type { RouterOutputs } from "@ecom/types";

import { humanizeError } from "@/lib/friendly-errors";
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

interface ShopifyForm {
  provider: "shopify";
  shopDomain: string;
  // All credential fields are optional now — the platform-level OAuth app
  // covers the simple flow. Merchants who insist on the legacy custom-app
  // path supply these via the collapsed Advanced section.
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  scopes: string[];
  /** Set when a reconnect-overwrite confirmation dialog re-issues this. */
  confirmOverwrite?: boolean;
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
  platformShopifyConfigured,
}: {
  open: boolean;
  provider: ProviderKey | null;
  onClose: () => void;
  onSubmit: (payload: ConnectPayload) => void;
  isPending: boolean;
  /**
   * Whether the platform has SHOPIFY_APP_API_KEY/SECRET set in env. When
   * false, "one-click connect" cannot work for any merchant — the modal
   * surfaces an honest "platform creds not configured" notice and
   * auto-expands the Advanced panel so the merchant doesn't have to dig.
   */
  platformShopifyConfigured: boolean;
}) {
  const [shopify, setShopify] = useState({
    shopDomain: "",
    apiKey: "",
    apiSecret: "",
    accessToken: "",
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [woo, setWoo] = useState({ siteUrl: "", consumerKey: "", consumerSecret: "" });
  const [label, setLabel] = useState("");

  // Reset transient form state every time the dialog opens so a half-typed
  // value from a previous attempt doesn't carry over. When the platform's
  // Shopify Partner-app creds aren't configured, force-open Advanced — the
  // merchant *has* to paste their own creds for the connect to succeed.
  useEffect(() => {
    if (!open) {
      setShowAdvanced(false);
      return;
    }
    if (provider === "shopify" && !platformShopifyConfigured) {
      setShowAdvanced(true);
    }
  }, [open, provider, platformShopifyConfigured]);

  // Inline shop-domain validation. Mirrors the backend Zod regex so the
  // merchant gets immediate feedback rather than a round-trip rejection.
  const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
  const trimmedDomain = shopify.shopDomain.trim().toLowerCase();
  const domainTouched = shopify.shopDomain.length > 0;
  const domainValid = SHOP_DOMAIN_RE.test(trimmedDomain);
  const showDomainError = domainTouched && !domainValid;

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {provider ? PROVIDER_META[provider].label : ""}</DialogTitle>
        </DialogHeader>
        {provider === "shopify" ? (
          <div className="space-y-4">
            {platformShopifyConfigured ? (
              <div className="rounded-lg border border-success-border/60 bg-success-subtle/40 p-3 text-xs text-fg">
                <div className="flex items-start gap-2">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  <div className="space-y-1">
                    <p className="font-semibold">One-click connect</p>
                    <p className="text-fg-muted">
                      Just enter your Shopify store address. We'll send you to
                      Shopify to approve — no API keys, no copy-paste.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-warning-border/60 bg-warning-subtle/40 p-3 text-xs text-fg">
                <div className="flex items-start gap-2">
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden
                  />
                  <div className="space-y-1">
                    <p className="font-semibold">Custom-app credentials needed</p>
                    <p className="text-fg-muted">
                      The platform's shared Shopify app isn't set up here yet,
                      so one-click connect isn't available. Paste an API key +
                      secret from a Shopify custom app below to continue. (Ops:
                      set <code>SHOPIFY_APP_API_KEY</code> +{" "}
                      <code>SHOPIFY_APP_API_SECRET</code> in the API env to
                      enable one-click for everyone.)
                    </p>
                  </div>
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="shopify-domain">Your Shopify store address</Label>
              <Input
                id="shopify-domain"
                placeholder="mystore.myshopify.com"
                autoFocus
                value={shopify.shopDomain}
                onChange={(e) =>
                  setShopify({ ...shopify, shopDomain: e.target.value })
                }
                aria-invalid={showDomainError || undefined}
                aria-describedby="shopify-domain-help"
              />
              <p
                id="shopify-domain-help"
                className={`text-2xs ${
                  showDomainError ? "text-danger" : "text-fg-faint"
                }`}
              >
                {showDomainError
                  ? "Use your Shopify store address like mystore.myshopify.com"
                  : "Find it in your Shopify admin URL bar — it always ends in .myshopify.com."}
              </p>
            </div>

            {/* Advanced disclosure — hidden by default. Only merchants who
                already created a Shopify custom app and want to paste keys
                directly need to expand this. */}
            <div className="rounded-md border border-stroke/14 bg-surface-raised/40">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-2xs font-medium text-fg-subtle transition-colors hover:text-fg"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="h-3 w-3" aria-hidden />
                  Advanced (for developers)
                </span>
                {showAdvanced ? (
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
              {showAdvanced ? (
                <div className="space-y-3 border-t border-stroke/12 px-3 py-3">
                  <p className="text-2xs text-fg-muted">
                    Skip the one-click flow and paste credentials from a
                    Shopify custom app you already created. Most merchants
                    don't need this.
                  </p>
                  <div className="space-y-1.5">
                    <Label>API key</Label>
                    <Input
                      placeholder="From Shopify admin → Develop apps → API credentials"
                      value={shopify.apiKey}
                      onChange={(e) =>
                        setShopify({ ...shopify, apiKey: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>API secret key</Label>
                    <Input
                      type="password"
                      placeholder="Paste the secret from Shopify"
                      value={shopify.apiSecret}
                      onChange={(e) =>
                        setShopify({ ...shopify, apiSecret: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Admin API access token (optional)</Label>
                    <Input
                      type="password"
                      placeholder="Paste only if you already installed the app"
                      value={shopify.accessToken}
                      onChange={(e) =>
                        setShopify({ ...shopify, accessToken: e.target.value })
                      }
                    />
                    <p className="text-2xs text-fg-faint">
                      With a token, we skip OAuth and connect immediately.
                      Otherwise we'll send you to Shopify to approve.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <Button
              className="w-full"
              disabled={isPending || !domainValid}
              onClick={() =>
                onSubmit({
                  provider: "shopify",
                  shopDomain: trimmedDomain,
                  apiKey: shopify.apiKey.trim() || undefined,
                  apiSecret: shopify.apiSecret.trim() || undefined,
                  accessToken: shopify.accessToken?.trim() || undefined,
                  // Must be a SUBSET of what the deployed Shopify app
                  // declares in its `[access_scopes].scopes` config —
                  // requesting any scope outside the declared set causes
                  // Shopify to silently bounce the merchant back to
                  // `app_url` (no `?code` -> our callback never runs ->
                  // integration stuck on `pending` forever, no error
                  // surfaced). When you add a new scope to the deployed
                  // app version, mirror it here AND vice-versa.
                  scopes: [
                    "read_orders",
                    "read_products",
                    "read_customers",
                    "read_fulfillments",
                  ],
                })
              }
            >
              {isPending ? "Connecting…" : "Continue to Shopify"}
              <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </Button>
            <p className="text-2xs text-fg-faint">
              <ShieldCheck className="mr-1 inline h-3 w-3 align-text-bottom" aria-hidden />
              We never see your password. Tokens are encrypted on our side
              and you can disconnect any time.
            </p>
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

/**
 * Popup-fallback card. After the merchant clicks "Continue to Shopify"
 * we try `window.open` once, but Chrome/Safari popup blockers can
 * silently swallow that. This dialog gives the merchant a primary,
 * always-clickable button + a copyable URL so they're never stranded.
 */
function ShopifyInstallFallback({
  state,
  onClose,
}: {
  state: { integrationId: string; installUrl: string; shop: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!state) return null;
  return (
    <Dialog open={true} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Finish on Shopify</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            We tried to open Shopify in a new tab. If nothing happened (some
            browsers block popups), use the button below to continue
            installing the connection for{" "}
            <span className="font-medium text-fg">{state.shop}</span>.
          </p>
          <Button asChild className="w-full">
            <a
              href={state.installUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                // Best-effort: bump the cache when the merchant comes
                // back so a returning tab doesn't show stale state.
              }}
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" /> Open Shopify install
            </a>
          </Button>
          <div className="space-y-1.5">
            <Label className="text-2xs">Or copy the install link</Label>
            <div className="flex items-center gap-2">
              <Input readOnly value={state.installUrl} className="font-mono text-2xs" />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(state.installUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <p className="text-2xs text-fg-faint">
              Paste this in your browser if the popup is blocked.
            </p>
          </div>
          <p className="text-2xs text-fg-faint">
            <Sparkles className="mr-1 inline h-3 w-3 align-text-bottom" aria-hidden />
            Once you approve on Shopify, you'll come right back here. We'll
            also refresh any other tabs you have open.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Post-connection celebratory state. The merchant has just finished OAuth
 * (or the immediate-connect path for non-Shopify providers). One big CTA
 * to import their last 25 orders + reassurance that future orders will
 * arrive automatically.
 */
function ConnectionSuccessDialog({
  state,
  onClose,
  onImport,
}: {
  state: { integrationId: string | null; shop: string | null; provider: ProviderKey } | null;
  onClose: () => void;
  onImport: (integrationId: string) => void;
}) {
  // For the OAuth-redirect path the integration id isn't carried in the
  // URL (only the shop is). We resolve it from the integrations list so
  // the "Import last 25 orders" button can call importNow with the right
  // id. This list is already cached by the page above.
  const list = trpc.integrations.list.useQuery(undefined, {
    enabled: !!state,
    staleTime: 0,
  });
  const integration = useMemo(() => {
    if (!state) return null;
    if (state.integrationId) {
      return (list.data ?? []).find((r) => r.id === state.integrationId) ?? null;
    }
    if (state.provider === "shopify" && state.shop) {
      return (
        (list.data ?? []).find(
          (r) => r.provider === "shopify" && r.accountKey === state.shop,
        ) ?? null
      );
    }
    return (list.data ?? []).find((r) => r.provider === state.provider) ?? null;
  }, [list.data, state]);

  if (!state) return null;
  const meta = PROVIDER_META[state.provider];
  const label = state.shop ?? meta?.label ?? "your store";
  const canImport =
    state.provider !== "csv" &&
    state.provider !== "custom_api" &&
    !!integration?.id;

  return (
    <Dialog open={true} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              <PartyPopper className="h-5 w-5 text-success" aria-hidden />
              Your store is connected!
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            <span className="font-medium text-fg">{label}</span> is now
            connected. From now on, every new order will appear here
            automatically — no copy-paste, no CSVs.
          </p>

          {canImport ? (
            <div className="rounded-lg border border-brand/30 bg-brand/8 p-4">
              <p className="text-sm font-semibold text-fg">
                Pull your recent orders to see the dashboard come alive
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                We'll import the last 25 orders from {label} so you can
                explore right away. Future orders sync automatically.
              </p>
              <Button
                className="mt-3 w-full"
                size="lg"
                disabled={!integration?.id}
                onClick={() => integration?.id && onImport(integration.id)}
              >
                <Download className="mr-2 h-4 w-4" />
                Import your last 25 orders
              </Button>
            </div>
          ) : null}

          <ul className="space-y-2 text-xs text-fg-muted">
            <li className="flex items-start gap-2">
              <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
              New orders flow in within seconds.
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
              Tokens are encrypted on our side. Disconnect any time.
            </li>
            <li className="flex items-start gap-2">
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
              Failed deliveries auto-retry. You can replay them manually too.
            </li>
          </ul>

          <Button variant="outline" className="w-full" onClick={onClose}>
            I'll do it later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reconnect confirmation. The router refused to clobber a working
 * connection on a plain re-submit. The merchant gets one explicit prompt
 * before we rotate credentials / restart OAuth.
 */
function ReconnectConfirmDialog({
  state,
  isPending,
  onCancel,
  onConfirm,
}: {
  state: { payload: ConnectPayload; integrationId: string } | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!state) return null;
  const shop =
    state.payload.provider === "shopify"
      ? state.payload.shopDomain
      : state.payload.provider === "woocommerce"
        ? state.payload.siteUrl
        : "this connector";
  return (
    <Dialog open={true} onOpenChange={(v) => (!v ? onCancel() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" aria-hidden />
              Already connected
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-fg-muted">
            <span className="font-medium text-fg">{shop}</span> is already
            connected and working. Reconnecting will reset the connection
            and ask Shopify to re-approve it.
          </p>
          <ul className="space-y-1 text-xs text-fg-muted">
            <li>• Your imported orders stay where they are.</li>
            <li>• You will need to approve again on Shopify.</li>
            <li>• If anything goes wrong, your old connection still works until you finish.</li>
          </ul>
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button onClick={onConfirm} disabled={isPending} className="sm:flex-1">
              {isPending ? "Reconnecting…" : "Yes, reconnect"}
            </Button>
            <Button variant="outline" onClick={onCancel} className="sm:flex-1">
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
