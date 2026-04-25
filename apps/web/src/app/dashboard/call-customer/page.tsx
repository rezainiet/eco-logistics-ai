"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Phone,
  PhoneCall,
  PhoneOff,
  Timer,
  User,
  AlertCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const LIVE_STATUSES = new Set(["queued", "initiated", "ringing", "in-progress"]);

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-surface-raised text-fg-muted",
  initiated: "bg-info-subtle text-info",
  ringing: "bg-warning-subtle text-warning",
  "in-progress": "bg-success-subtle text-success",
  completed: "bg-success-subtle text-success",
  busy: "bg-warning-subtle text-warning",
  "no-answer": "bg-danger-subtle text-danger",
  failed: "bg-danger-subtle text-danger",
  canceled: "bg-surface-raised text-fg-muted",
};

function statusClass(status: string | null): string {
  if (!status) return "bg-surface-raised text-fg-muted";
  return STATUS_STYLES[status] ?? "bg-surface-raised text-fg-muted";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function CallCustomerPage() {
  const utils = trpc.useUtils();
  const configured = trpc.call.isConfigured.useQuery();
  const recent = trpc.call.getRecentCalls.useQuery({ limit: 20 });

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeSid, setActiveSid] = useState<string | null>(null);

  const liveStatus = trpc.call.getCallStatus.useQuery(
    { callSid: activeSid ?? "" },
    {
      enabled: !!activeSid,
      refetchInterval: (data) => {
        const s = data?.status;
        return s && LIVE_STATUSES.has(s) ? 2000 : false;
      },
    },
  );

  const initiate = trpc.call.initiateCall.useMutation({
    onSuccess: async (data) => {
      setActiveSid(data.callSid);
      setError(null);
      await utils.call.getRecentCalls.invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const hangup = trpc.call.hangupCall.useMutation({
    onSuccess: async () => {
      await utils.call.getRecentCalls.invalidate();
      await utils.call.getCallStatus.invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const isLive = useMemo(() => {
    const s = liveStatus.data?.status;
    return !!s && LIVE_STATUSES.has(s);
  }, [liveStatus.data?.status]);

  useEffect(() => {
    if (activeSid && liveStatus.data && !isLive) {
      void utils.call.getRecentCalls.invalidate();
    }
  }, [activeSid, liveStatus.data, isLive, utils]);

  const canCall =
    configured.data?.configured === true &&
    phone.trim().length >= 7 &&
    !initiate.isPending &&
    !isLive;

  function onCall() {
    setError(null);
    initiate.mutate({
      customerPhone: phone.trim(),
      customerName: name.trim() || undefined,
    });
  }

  function onHangup() {
    if (!activeSid) return;
    hangup.mutate({ callSid: activeSid });
  }

  const calls = recent.data ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Call customer</h1>
        <p className="mt-1 text-sm text-fg-subtle">
          Place outbound calls via Twilio and track status in real time.
        </p>
      </div>

      {configured.isSuccess && !configured.data?.configured && (
        <Card className="border-warning/30 bg-warning/8 text-fg">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="h-5 w-5 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-medium text-warning">Twilio not configured</p>
              <p className="text-fg-muted">
                Set <code className="rounded bg-surface-overlay px-1 py-0.5 text-xs">TWILIO_ACCOUNT_SID</code>,{" "}
                <code className="rounded bg-surface-overlay px-1 py-0.5 text-xs">TWILIO_AUTH_TOKEN</code>, and{" "}
                <code className="rounded bg-surface-overlay px-1 py-0.5 text-xs">TWILIO_PHONE_NUMBER</code>{" "}
                in the API env to enable calling.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-stroke/10 bg-surface text-fg">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">New call</CardTitle>
            <CardDescription className="text-fg-subtle">
              Enter a customer number to start an outbound call.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="call-name" className="text-fg-subtle">
                Customer name
              </Label>
              <Input
                id="call-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Optional"
                className="border-stroke/14 bg-surface-overlay text-fg placeholder:text-fg-faint"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="call-phone" className="text-fg-subtle">
                Phone number
              </Label>
              <Input
                id="call-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+8801…"
                className="border-stroke/14 bg-surface-overlay font-mono text-fg placeholder:text-fg-faint"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/8 p-3 text-sm text-danger">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                className="flex-1 bg-success text-white hover:bg-success/90 disabled:bg-surface disabled:text-fg-faint"
                disabled={!canCall}
                onClick={onCall}
              >
                <PhoneCall className="mr-2 h-4 w-4" />
                {initiate.isPending ? "Dialing…" : "Call"}
              </Button>
              <Button
                variant="outline"
                className="flex-1 border-danger/40 bg-transparent text-danger hover:bg-danger-subtle disabled:opacity-40"
                disabled={!isLive || hangup.isPending}
                onClick={onHangup}
              >
                <PhoneOff className="mr-2 h-4 w-4" />
                {hangup.isPending ? "Ending…" : "Hang up"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-stroke/10 bg-surface text-fg">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Live status</CardTitle>
            <CardDescription className="text-fg-subtle">
              {activeSid ? "Updates every 2 seconds while the call is active." : "No active call."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!activeSid ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-fg-subtle">
                <Phone className="h-6 w-6 text-fg-faint" />
                Place a call to see live status here.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.4px] text-fg-subtle">Status</span>
                  <Badge
                    variant="outline"
                    className={`border-transparent ${statusClass(liveStatus.data?.status ?? null)}`}
                  >
                    {liveStatus.data?.status ?? "…"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.4px] text-fg-subtle">
                    To
                  </span>
                  <span className="font-mono text-sm text-fg">
                    {liveStatus.data?.customerPhone ?? "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.4px] text-fg-subtle">
                    Duration
                  </span>
                  <span className="flex items-center gap-1.5 text-sm text-fg">
                    <Timer className="h-3.5 w-3.5 text-fg-subtle" />
                    {formatDuration(liveStatus.data?.duration ?? 0)}
                  </span>
                </div>
                {liveStatus.data?.recordingUrl && (
                  <a
                    href={liveStatus.data.recordingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm text-brand hover:underline"
                  >
                    Play recording →
                  </a>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-stroke/10 bg-surface text-fg">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Recent calls</CardTitle>
          <CardDescription className="text-fg-subtle">Your last 20 outbound calls</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-14 animate-shimmer rounded-md" />
              ))}
            </div>
          ) : calls.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <PhoneCall className="h-5 w-5 text-fg-faint" />
              <p className="text-sm text-fg-subtle">No calls yet.</p>
            </div>
          ) : (
            <ul className="divide-y divide-[rgba(209,213,219,0.08)]">
              {calls.map((c) => (
                <li key={c.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-info">
                    <User className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">
                        {c.customerName ?? "Unknown"}
                      </span>
                      <span className="truncate font-mono text-xs text-fg-subtle">
                        {c.customerPhone ?? "—"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-subtle">
                      <span>{formatRelative(c.timestamp)}</span>
                      <span className="text-fg-faint">·</span>
                      <span>{formatDuration(c.duration)}</span>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={`border-transparent ${statusClass(c.status)}`}
                  >
                    {c.status ?? "—"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
