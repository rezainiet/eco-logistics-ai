"use client";

import { Bot, CheckCircle2, MessageSquare, Truck, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export interface SystemActionEntry {
  /** ISO timestamp of the action. */
  at: string;
  /** "automation.auto_confirmed" / "automation.sms_confirm" / "automation.auto_booked" / etc. */
  action: string;
  /** Order number / id label for context. */
  subject: string;
  /** Optional one-line detail. */
  detail?: string;
}

const META: Record<string, { icon: typeof Bot; label: string; tone: string }> = {
  "automation.auto_confirmed": { icon: Bot, label: "Auto-confirmed", tone: "text-success" },
  "automation.auto_confirm_and_book": { icon: Bot, label: "Auto-confirmed + book", tone: "text-success" },
  "automation.sms_confirm": { icon: MessageSquare, label: "Customer confirmed via SMS", tone: "text-success" },
  "automation.sms_reject": { icon: XCircle, label: "Customer rejected via SMS", tone: "text-danger" },
  "automation.auto_booked": { icon: Truck, label: "Auto-booked", tone: "text-success" },
  "automation.auto_book_failed": { icon: XCircle, label: "Auto-book failed", tone: "text-danger" },
  "automation.confirmation_sms_delivered": { icon: CheckCircle2, label: "SMS delivered", tone: "text-success" },
  "automation.confirmation_sms_undelivered": { icon: XCircle, label: "SMS not delivered", tone: "text-danger" },
  "automation.escalated_no_reply": { icon: MessageSquare, label: "Escalated — no reply", tone: "text-warning" },
};

const FALLBACK = { icon: Bot, label: "System action", tone: "text-fg-muted" };

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * "Recent system actions" feed — the merchant SEES what automation is
 * doing in real time. Builds trust ("the bot is actually working") and
 * makes failures visible ("oh, that one bounced").
 *
 * Pure UI — caller passes the list (typically derived from auditLog).
 */
export function SystemActionsLog({ entries }: { entries: SystemActionEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Automation activity</CardTitle>
          <CardDescription>
            Once automation starts running, the things it does for you
            appear here.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-6 text-center text-sm text-fg-muted">
          Nothing yet — confirmed orders, bookings, and SMS replies will
          show up here.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Automation activity</CardTitle>
        <CardDescription>What the bot has done recently for you.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {entries.slice(0, 12).map((e, i) => {
            const m = META[e.action] ?? FALLBACK;
            const Icon = m.icon;
            return (
              <li
                key={`${e.at}-${i}`}
                className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <Icon className={`mt-0.5 h-4 w-4 ${m.tone}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-fg">{m.label}</span>
                    <span className="text-xs text-fg-muted">{formatRel(e.at)}</span>
                  </div>
                  <div className="text-xs text-fg-muted">
                    Order <span className="font-mono">{e.subject}</span>
                    {e.detail ? <span> · {e.detail}</span> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
