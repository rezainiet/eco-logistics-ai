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
  queued: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
  initiated: "bg-[rgba(59,130,246,0.15)] text-[#60A5FA]",
  ringing: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
  "in-progress": "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
  completed: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
  busy: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
  "no-answer": "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
  failed: "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
  canceled: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
};

function statusClass(status: string | null): string {
  if (!status) return "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]";
  return STATUS_STYLES[status] ?? "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]";
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
        <h1 className="text-3xl font-semibold tracking-tight text-[#F3F4F6]">Call customer</h1>
        <p className="mt-1 text-sm text-[#9CA3AF]">
          Place outbound calls via Twilio and track status in real time.
        </p>
      </div>

      {configured.isSuccess && !configured.data?.configured && (
        <Card className="border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] text-[#F3F4F6]">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="h-5 w-5 shrink-0 text-[#FBBF24]" />
            <div className="text-sm">
              <p className="font-medium text-[#FBBF24]">Twilio not configured</p>
              <p className="text-[#D1D5DB]">
                Set <code className="rounded bg-[#111318] px-1 py-0.5 text-xs">TWILIO_ACCOUNT_SID</code>,{" "}
                <code className="rounded bg-[#111318] px-1 py-0.5 text-xs">TWILIO_AUTH_TOKEN</code>, and{" "}
                <code className="rounded bg-[#111318] px-1 py-0.5 text-xs">TWILIO_PHONE_NUMBER</code>{" "}
                in the API env to enable calling.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">New call</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              Enter a customer number to start an outbound call.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="call-name" className="text-[#9CA3AF]">
                Customer name
              </Label>
              <Input
                id="call-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Optional"
                className="border-[rgba(209,213,219,0.15)] bg-[#111318] text-[#F3F4F6] placeholder:text-[#6B7280]"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="call-phone" className="text-[#9CA3AF]">
                Phone number
              </Label>
              <Input
                id="call-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+8801…"
                className="border-[rgba(209,213,219,0.15)] bg-[#111318] font-mono text-[#F3F4F6] placeholder:text-[#6B7280]"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] p-3 text-sm text-[#FCA5A5]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                className="flex-1 bg-[#10B981] text-white hover:bg-[#059669] disabled:bg-[#1A1D2E] disabled:text-[#6B7280]"
                disabled={!canCall}
                onClick={onCall}
              >
                <PhoneCall className="mr-2 h-4 w-4" />
                {initiate.isPending ? "Dialing…" : "Call"}
              </Button>
              <Button
                variant="outline"
                className="flex-1 border-[rgba(239,68,68,0.4)] bg-transparent text-[#FCA5A5] hover:bg-[rgba(239,68,68,0.1)] disabled:opacity-40"
                disabled={!isLive || hangup.isPending}
                onClick={onHangup}
              >
                <PhoneOff className="mr-2 h-4 w-4" />
                {hangup.isPending ? "Ending…" : "Hang up"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Live status</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              {activeSid ? "Updates every 2 seconds while the call is active." : "No active call."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!activeSid ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-[#9CA3AF]">
                <Phone className="h-6 w-6 text-[#6B7280]" />
                Place a call to see live status here.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.4px] text-[#9CA3AF]">Status</span>
                  <Badge
                    variant="outline"
                    className={`border-transparent ${statusClass(liveStatus.data?.status ?? null)}`}
                  >
                    {liveStatus.data?.status ?? "…"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.4px] text-[#9CA3AF]">
                    To
                  </span>
                  <span className="font-mono text-sm text-[#F3F4F6]">
                    {liveStatus.data?.customerPhone ?? "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.4px] text-[#9CA3AF]">
                    Duration
                  </span>
                  <span className="flex items-center gap-1.5 text-sm text-[#F3F4F6]">
                    <Timer className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    {formatDuration(liveStatus.data?.duration ?? 0)}
                  </span>
                </div>
                {liveStatus.data?.recordingUrl && (
                  <a
                    href={liveStatus.data.recordingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm text-[#0084D4] hover:underline"
                  >
                    Play recording →
                  </a>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Recent calls</CardTitle>
          <CardDescription className="text-[#9CA3AF]">Your last 20 outbound calls</CardDescription>
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
              <PhoneCall className="h-5 w-5 text-[#6B7280]" />
              <p className="text-sm text-[#9CA3AF]">No calls yet.</p>
            </div>
          ) : (
            <ul className="divide-y divide-[rgba(209,213,219,0.08)]">
              {calls.map((c) => (
                <li key={c.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[rgba(0,132,212,0.1)] text-[#60A5FA]">
                    <User className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-[#F3F4F6]">
                        {c.customerName ?? "Unknown"}
                      </span>
                      <span className="truncate font-mono text-xs text-[#9CA3AF]">
                        {c.customerPhone ?? "—"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-[#9CA3AF]">
                      <span>{formatRelative(c.timestamp)}</span>
                      <span className="text-[#4B5563]">·</span>
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
