"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Copy, Package, Radio } from "lucide-react";
import type { RouterOutputs } from "@ecom/types";
import { formatRelative } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { ISSUE_LABEL, healthTone, shipmentsLine, updatesLine } from "@/lib/couriers/health-view";

type CourierHealth = RouterOutputs["merchants"]["courierHealth"][number];

/**
 * Connection & sync health under one courier card: the webhook URL to paste
 * in the courier portal, how updates are arriving, shipments that need a
 * look (each links to the order), and failed / orphaned bookings.
 */
export function CourierHealthPanel({ health }: { health: CourierHealth }) {
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const tone = healthTone(health);
  const attention = health.shipments.attention;
  const visible = showAll ? attention : attention.slice(0, 5);

  return (
    <div className="space-y-3 border-t border-stroke/8 pt-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-fg-subtle">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 font-medium",
            tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-danger",
          )}
        >
          {tone === "ok" ? <Check className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          {tone === "ok" ? "Healthy" : tone === "warn" ? "Needs a look" : "Action needed"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" /> {shipmentsLine(health.shipments)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Radio className="h-3.5 w-3.5" /> {updatesLine(health, (d) => formatRelative(d))}
        </span>
        {health.connection.lastValidatedAt && !health.connection.validationError ? (
          <span>Credentials checked {formatRelative(health.connection.lastValidatedAt)}</span>
        ) : null}
      </div>

      {health.webhook.callbackUrl ? (
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
          <span className="shrink-0 text-fg-subtle">Webhook URL</span>
          <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-2xs text-fg-muted" title={health.webhook.callbackUrl}>
            {health.webhook.callbackUrl}
            {health.name === "redx" ? "?token=<your API secret>" : ""}
          </code>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 self-start rounded px-2 py-1 text-fg-subtle hover:bg-surface hover:text-fg sm:self-auto"
            onClick={() => {
              void navigator.clipboard?.writeText(health.webhook.callbackUrl ?? "").then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}

      {health.webhook.failedLast7d > 0 ? (
        <p className="text-warning">
          {health.webhook.failedLast7d} courier update{health.webhook.failedLast7d === 1 ? "" : "s"} failed to apply this week — they are retried automatically.
        </p>
      ) : null}
      {health.bookings.failedLast7d > 0 ? (
        <p className="text-warning">
          {health.bookings.failedLast7d} booking{health.bookings.failedLast7d === 1 ? "" : "s"} failed this week
          {health.bookings.lastFailure?.error ? ` — last: ${health.bookings.lastFailure.error}` : ""}.
        </p>
      ) : null}
      {health.bookings.orphaned > 0 ? (
        <p className="text-danger">
          {health.bookings.orphaned} parcel{health.bookings.orphaned === 1 ? " was" : "s were"} created at the courier but not attached to an order — check the courier portal and cancel or book manually.
        </p>
      ) : null}

      {attention.length > 0 ? (
        <ul className="divide-y divide-stroke/8 rounded-md border border-stroke/8">
          {visible.map((a) => (
            <li key={a.orderId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <Link href={`/dashboard/orders?focus=${a.orderId}`} className="font-medium text-fg hover:underline">
                {a.orderNumber}
              </Link>
              <span className={cn("min-w-0 truncate", a.issue === "delivery_issue" ? "text-warning" : "text-fg-subtle")} title={a.detail}>
                {ISSUE_LABEL[a.issue]} · {a.detail}
              </span>
            </li>
          ))}
          {attention.length > 5 ? (
            <li className="px-3 py-2">
              <button type="button" className="text-brand hover:underline" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${attention.length}`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
