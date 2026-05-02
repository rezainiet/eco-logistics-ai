"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CreditCard,
  Loader2,
  Mail,
  MessageSquare,
  Send,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Webhook,
  Zap,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/formatters";

/**
 * Alert panel — backend writes `alert.fired` audit rows from the anomaly
 * worker. We surface them grouped by `meta.kind` so the on-call admin
 * can see at a glance which subsystems are screaming.
 *
 * Alerts are deliberately read-only here: they're informational. Each kind
 * links to the page that lets you actually act (system health for queue
 * issues, billing queue for payment spikes, etc.).
 */

type AlertKind =
  | "payment_spike"
  | "webhook_failure_spike"
  | "automation_failure_spike"
  | "fraud_spike";

type AlertSeverity = "info" | "warning" | "critical";

interface AlertMeta {
  kind?: AlertKind;
  severity?: AlertSeverity;
  message?: string;
  shortCount?: number;
  baselineRate?: number;
  shortRate?: number;
  dedupeKey?: string;
}

const KIND_META: Record<
  AlertKind,
  { label: string; icon: typeof AlertTriangle; href: string; description: string }
> = {
  payment_spike: {
    label: "Payment spike",
    icon: CreditCard,
    href: "/admin/billing",
    description:
      "Manual payment submissions are running well above the 24h baseline.",
  },
  webhook_failure_spike: {
    label: "Webhook failures",
    icon: Webhook,
    href: "/admin/system",
    description:
      "Inbound courier or integration webhooks are failing at an elevated rate.",
  },
  automation_failure_spike: {
    label: "Automation failures",
    icon: Zap,
    href: "/admin/system",
    description:
      "auto_book / SMS / watchdog failures are spiking versus baseline.",
  },
  fraud_spike: {
    label: "Fraud spike",
    icon: ShieldAlert,
    href: "/admin/fraud",
    description: "High-risk orders are arriving faster than typical baseline.",
  },
};

type WindowChoice = "1h" | "24h" | "7d";

const WINDOW_HOURS: Record<WindowChoice, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
};

export default function AdminAlertsPage() {
  const [window, setWindow] = useState<WindowChoice>("24h");
  const since = useMemo(
    () => new Date(Date.now() - WINDOW_HOURS[window] * 3600_000),
    [window],
  );

  const alerts = trpc.adminAudit.search.useQuery(
    { action: "alert.fired", since, limit: 200 },
    { refetchInterval: 30_000 },
  );

  const rows = alerts.data?.rows ?? [];
  const grouped = useMemo(() => {
    const map = new Map<AlertKind, typeof rows>();
    for (const r of rows) {
      const meta = (r.meta ?? {}) as AlertMeta;
      const kind = meta.kind;
      if (!kind || !(kind in KIND_META)) continue;
      const list = map.get(kind) ?? [];
      list.push(r);
      map.set(kind, list);
    }
    return map;
  }, [rows]);

  const totalCritical = rows.filter(
    (r) => ((r.meta ?? {}) as AlertMeta).severity === "critical",
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin · Alerts"
        title="Anomaly alerts"
        description="Spike + failure detectors over rolling baselines. Hour-bucketed dedupe — each alert kind fires at most once per hour."
      />

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {rows.length === 0 ? (
              <span className="flex items-center gap-2 text-success">
                <ShieldCheck className="h-4 w-4" />
                No alerts firing in this window.
              </span>
            ) : (
              <>
                <span className="font-medium text-fg">
                  {rows.length} alert{rows.length === 1 ? "" : "s"}
                </span>
                {totalCritical > 0 ? (
                  <Badge className="bg-danger-subtle text-danger">
                    {totalCritical} critical
                  </Badge>
                ) : null}
                <span className="text-fg-subtle">
                  in the last{" "}
                  {window === "1h" ? "hour" : window === "24h" ? "24 hours" : "7 days"}
                </span>
              </>
            )}
          </div>
          <div className="flex gap-1.5">
            {(["1h", "24h", "7d"] as WindowChoice[]).map((w) => (
              <Button
                key={w}
                size="sm"
                variant={w === window ? "default" : "outline"}
                onClick={() => setWindow(w)}
              >
                {w}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {alerts.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="py-8">
                <div className="h-12 animate-shimmer rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : grouped.size === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
            <ShieldCheck className="h-10 w-10 text-success" />
            <p className="text-sm text-fg-subtle">
              All detectors quiet. Nothing for you to triage right now.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {(Object.keys(KIND_META) as AlertKind[]).map((kind) => {
            const items = grouped.get(kind) ?? [];
            if (items.length === 0) return null;
            return (
              <AlertGroup key={kind} kind={kind} items={items} />
            );
          })}
        </div>
      )}

      <AlertPreferencesPanel />

      <Card>
        <CardContent className="py-3 text-xs text-fg-subtle">
          Anomaly detection runs every 5 minutes. The detectors compare a
          1-hour short window against a 23-hour baseline; alerts dedupe by
          (kind, hour) so a sustained anomaly fires once per hour rather
          than every tick.
        </CardContent>
      </Card>
    </div>
  );
}

function AlertGroup({
  kind,
  items,
}: {
  kind: AlertKind;
  items: Array<{
    id: string;
    at: Date | string;
    meta?: unknown;
  }>;
}) {
  const cfg = KIND_META[kind];
  const Icon = cfg.icon;
  const newest = items[0];
  const newestMeta = (newest?.meta ?? {}) as AlertMeta;
  const severity: AlertSeverity = newestMeta.severity ?? "warning";
  const severityClass =
    severity === "critical"
      ? "border-danger/40 bg-danger-subtle/30"
      : severity === "warning"
        ? "border-warning/40 bg-warning-subtle/30"
        : "border-stroke/12 bg-surface-raised/40";

  return (
    <Card className={`overflow-hidden border-2 ${severityClass}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                severity === "critical"
                  ? "bg-danger-subtle text-danger"
                  : "bg-warning-subtle text-warning"
              }`}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">{cfg.label}</CardTitle>
              <p className="text-xs text-fg-subtle">{cfg.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              className={
                severity === "critical"
                  ? "bg-danger-subtle text-danger"
                  : "bg-warning-subtle text-warning"
              }
            >
              {severity}
            </Badge>
            <span className="font-mono text-xs text-fg">
              {items.length}×
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {items.slice(0, 5).map((r) => {
          const meta = (r.meta ?? {}) as AlertMeta;
          return (
            <div
              key={r.id}
              className="flex items-start justify-between gap-3 rounded-md bg-surface-raised/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">{meta.message ?? "(no message)"}</p>
                <div className="mt-1 flex flex-wrap gap-3 text-2xs text-fg-subtle">
                  {meta.shortCount !== undefined ? (
                    <span>
                      <TrendingUp className="mr-0.5 inline h-3 w-3" />
                      <span className="font-mono text-fg">
                        {meta.shortCount}
                      </span>{" "}
                      this hour
                    </span>
                  ) : null}
                  {meta.baselineRate !== undefined ? (
                    <span>
                      baseline:{" "}
                      <span className="font-mono">
                        {meta.baselineRate.toFixed(1)}/h
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>
              <span className="shrink-0 text-2xs text-fg-faint">
                {formatDateTime(r.at)}
              </span>
            </div>
          );
        })}
        {items.length > 5 ? (
          <p className="pt-1 text-center text-2xs text-fg-faint">
            … and {items.length - 5} earlier in this window
          </p>
        ) : null}
        <div className="pt-2 text-right">
          <a
            href={cfg.href}
            className="text-xs text-brand hover:underline"
          >
            Triage →
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

type Severity = "info" | "warning" | "critical";
type Channel = "email" | "sms";

interface PrefsState {
  info: { email: boolean; sms: boolean };
  warning: { email: boolean; sms: boolean };
  critical: { email: boolean; sms: boolean };
}

const SEVERITY_TONE: Record<Severity, string> = {
  info: "text-info",
  warning: "text-warning",
  critical: "text-danger",
};

/**
 * Per-admin alert preferences. Each admin owns their own row in this UI —
 * we read/write only their own merchant doc. In-app delivery is not
 * configurable (it's the safety net) so we don't surface a toggle for it.
 */
function AlertPreferencesPanel() {
  const prefsQuery = trpc.adminAccess.getAlertPrefs.useQuery();
  const setPrefs = trpc.adminAccess.setAlertPrefs.useMutation({
    onSuccess: () => {
      toast.success("Preferences saved");
      prefsQuery.refetch();
    },
    onError: (err) => toast.error("Save failed", err.message),
  });
  const sendTest = trpc.adminAccess.sendTestAlert.useMutation({
    onSuccess: (res) => {
      const channels = [
        res.inApp > 0 ? "in-app" : null,
        res.emails > 0 ? "email" : null,
        res.sms > 0 ? "SMS" : null,
      ]
        .filter(Boolean)
        .join(", ");
      toast.success(
        "Test alert sent",
        channels ? `Delivered via ${channels}` : "In-app only — enable channels to verify",
      );
    },
    onError: (err) => toast.error("Test alert failed", err.message),
  });

  const [state, setState] = useState<PrefsState | null>(null);
  useEffect(() => {
    if (prefsQuery.data?.prefs && state === null) {
      setState(prefsQuery.data.prefs);
    }
  }, [prefsQuery.data, state]);

  const dirty = useMemo(() => {
    if (!state || !prefsQuery.data) return false;
    return JSON.stringify(state) !== JSON.stringify(prefsQuery.data.prefs);
  }, [state, prefsQuery.data]);

  function toggle(severity: Severity, channel: Channel) {
    setState((s) => {
      if (!s) return s;
      return {
        ...s,
        [severity]: { ...s[severity], [channel]: !s[severity][channel] },
      };
    });
  }

  const hasPhone = prefsQuery.data?.hasPhone ?? false;
  const hasEmail = prefsQuery.data?.hasEmail ?? false;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bell className="h-4 w-4 text-fg-subtle" />
          Your alert preferences
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => sendTest.mutate({ severity: "warning" })}
          disabled={sendTest.isPending}
        >
          {sendTest.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Send className="mr-1 h-3 w-3" />
          )}
          Send test
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <p className="text-xs text-fg-subtle">
          In-app delivery is always on — every admin sees alerts in their
          inbox. Email and SMS are opt-in per severity. Defaults: warnings
          go to email, criticals also page over SMS.
        </p>
        {!state || prefsQuery.isLoading ? (
          <div className="space-y-2">
            <div className="h-10 animate-shimmer rounded bg-surface-raised/40" />
            <div className="h-10 animate-shimmer rounded bg-surface-raised/40" />
            <div className="h-10 animate-shimmer rounded bg-surface-raised/40" />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[80px_1fr_auto_auto] items-center gap-3 border-b border-stroke/8 pb-2 text-2xs uppercase tracking-wide text-fg-faint">
              <div>Severity</div>
              <div>Description</div>
              <div className="flex items-center gap-1">
                <Mail className="h-3 w-3" /> Email
              </div>
              <div className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" /> SMS
              </div>
            </div>
            {(["info", "warning", "critical"] as Severity[]).map((sev) => (
              <div
                key={sev}
                className="grid grid-cols-[80px_1fr_auto_auto] items-center gap-3 rounded-md border border-stroke/8 bg-surface-raised/40 px-3 py-2"
              >
                <div className={`text-sm font-medium ${SEVERITY_TONE[sev]}`}>
                  {sev.toUpperCase()}
                </div>
                <div className="text-xs text-fg-subtle">
                  {sev === "info"
                    ? "Routine signals — fraud-rate ticks, low-volume spikes"
                    : sev === "warning"
                      ? "Anomalies above baseline — investigate when convenient"
                      : "Pageable — page on-call immediately"}
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={state[sev].email}
                    onCheckedChange={() => toggle(sev, "email")}
                    disabled={!hasEmail}
                    title={hasEmail ? "" : "No email on file"}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={state[sev].sms}
                    onCheckedChange={() => toggle(sev, "sms")}
                    disabled={!hasPhone}
                    title={hasPhone ? "" : "No phone on file"}
                  />
                </div>
              </div>
            ))}
            {!hasPhone ? (
              <p className="text-2xs text-fg-faint">
                SMS toggles disabled — add a phone number under your profile to enable.
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 pt-2">
              <p className="text-2xs text-fg-faint">
                In-app inbox is always on, regardless of these settings.
              </p>
              <Button
                size="sm"
                onClick={() => state && setPrefs.mutate(state)}
                disabled={!dirty || setPrefs.isPending}
              >
                {setPrefs.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : null}
                Save preferences
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
