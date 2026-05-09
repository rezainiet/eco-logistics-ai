"use client";

import * as React from "react";
import {
  CheckCircle2,
  HelpCircle,
  Info,
  PackageCheck,
  Truck,
} from "lucide-react";

/**
 * External delivery history card.
 *
 * Surfaces the canonical mapped shape from `Order.source.externalDelivery`
 * (read-only Mongo lookup, populated when `EXTERNAL_DELIVERY_ENABLED=1`
 * server-side). Renders compact per-provider rows + advisory signals.
 *
 * UX posture (binding):
 *   - Operational tone. NEVER fraud-y / accusatory wording.
 *   - "Cancelled" is a counter, not a verdict. Many BD-COD cancellations
 *     are merchant-side; the card never claims otherwise.
 *   - Defensive: returns null on null / malformed input.
 *   - Mobile-safe: rows wrap on overflow; no horizontal scroll.
 *   - Visibility-only — no mutations, no fraud-workflow triggers.
 */

type SignalKey =
  | "strong_delivery_history"
  | "elevated_return_pattern"
  | "sparse_history"
  | "mixed_delivery_history";

interface ProviderSnapshot {
  configured: boolean;
  ok: boolean;
  total: number;
  delivered: number;
  rto: number;
  cancelled: number;
  successRate: number | null;
  lastFetchedAt?: string | Date | null;
  sourceVersion: string;
  error?: string;
}

export interface ExternalDeliveryHistoryData {
  providers: Record<string, ProviderSnapshot>;
  aggregate: {
    total: number;
    delivered: number;
    rto: number;
    cancelled: number;
    successRate: number | null;
    contributingProviders: string[];
  };
  signals: Record<SignalKey, boolean>;
  freshness?: {
    fetchedAt?: string | Date | null;
    expiresAt?: string | Date | null;
    stale?: boolean;
  };
}

const SIGNAL_LABELS: Record<SignalKey, { label: string; tone: "good" | "watch" | "muted" }> = {
  strong_delivery_history: {
    label: "Strong delivery history",
    tone: "good",
  },
  elevated_return_pattern: {
    label: "Elevated return pattern",
    tone: "watch",
  },
  sparse_history: {
    label: "Limited delivery history",
    tone: "muted",
  },
  mixed_delivery_history: {
    label: "Mixed operational history",
    tone: "muted",
  },
};

const TONE_CLS: Record<"good" | "watch" | "muted", string> = {
  good: "bg-[rgba(16,185,129,0.12)] text-[#34D399]",
  watch: "bg-[rgba(245,158,11,0.12)] text-[#FBBF24]",
  muted: "bg-[rgba(156,163,175,0.10)] text-[#9CA3AF]",
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeNonNeg(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

function formatPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  if (!Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

function formatRelative(d: string | Date | null | undefined): string | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const ms = Date.now() - date.getTime();
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isValidData(d: unknown): d is ExternalDeliveryHistoryData {
  if (!d || typeof d !== "object") return false;
  const obj = d as Record<string, unknown>;
  if (!obj.providers || typeof obj.providers !== "object") return false;
  if (!obj.aggregate || typeof obj.aggregate !== "object") return false;
  if (!obj.signals || typeof obj.signals !== "object") return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Per-provider row                                                           */
/* -------------------------------------------------------------------------- */

function providerDisplayName(name: string): string {
  switch (name) {
    case "bdcourier":
      return "BDCourier network";
    case "pathao":
      return "Pathao";
    case "steadfast":
      return "Steadfast";
    case "redx":
      return "RedX";
    default:
      return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

function ProviderRow({
  name,
  snapshot,
}: {
  name: string;
  snapshot: ProviderSnapshot;
}) {
  if (!snapshot.configured) return null;
  const fresh = formatRelative(snapshot.lastFetchedAt ?? null);
  const totalDecided = safeNonNeg(snapshot.delivered) + safeNonNeg(snapshot.rto);
  const cancelled = safeNonNeg(snapshot.cancelled);
  const total = safeNonNeg(snapshot.total) || totalDecided + cancelled;

  if (!snapshot.ok) {
    // Provider was tried but didn't return data. Render as a calm
    // "no data right now" line — never as a failure / error visual.
    return (
      <li className="flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <Truck className="h-3 w-3 text-[#9CA3AF]" />
          <span className="font-medium text-[#D1D5DB]">
            {providerDisplayName(name)}
          </span>
        </div>
        <span className="text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
          No data right now
        </span>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
      <div className="flex items-center gap-2">
        <PackageCheck className="h-3 w-3 text-[#60A5FA]" />
        <span className="font-medium text-[#D1D5DB]">
          {providerDisplayName(name)}
        </span>
      </div>
      <div className="flex items-center gap-3 text-[#D1D5DB] tabular-nums">
        <span className="font-medium">
          {safeNonNeg(snapshot.delivered)}
          <span className="text-[#9CA3AF]"> delivered</span>
        </span>
        {cancelled > 0 ? (
          <span>
            {cancelled}
            <span className="text-[#9CA3AF]"> cancelled</span>
          </span>
        ) : null}
        {snapshot.successRate !== null && total >= 5 ? (
          <span className="text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
            {formatPct(snapshot.successRate)}
          </span>
        ) : null}
      </div>
      {fresh ? (
        <span className="basis-full text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
          Updated {fresh}
        </span>
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Main component                                                             */
/* -------------------------------------------------------------------------- */

export function ExternalDeliveryHistoryCard({
  data,
}: {
  data: ExternalDeliveryHistoryData | null | undefined;
}) {
  if (!data) return null;
  if (!isValidData(data)) return null;

  // Unconfigured-only providers → nothing to show. Render nothing
  // (drawer doesn't get a useless empty card).
  const configuredEntries = Object.entries(data.providers).filter(
    ([, snap]) => snap.configured,
  );
  if (configuredEntries.length === 0) return null;

  // If no provider returned ok AND there's no aggregate data, render a
  // calm "no history available" state rather than nothing — the merchant
  // sees that we tried and came up empty.
  const anyOk = configuredEntries.some(([, s]) => s.ok);
  const total = safeNonNeg(data.aggregate.total);

  const signalChips = (Object.entries(data.signals) as [SignalKey, boolean][])
    .filter(([, fired]) => fired)
    .map(([key]) => ({ key, ...SIGNAL_LABELS[key] }));

  return (
    <div className="rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#1A1D2E] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Truck className="h-4 w-4 text-[#60A5FA]" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">
            Courier delivery history
          </h3>
        </div>
        {total > 0 && data.aggregate.successRate !== null ? (
          <span className="inline-flex items-center gap-1 rounded bg-[rgba(96,165,250,0.10)] px-2 py-0.5 text-2xs uppercase tracking-[0.06em] text-[#60A5FA] tabular-nums">
            {formatPct(data.aggregate.successRate)} delivered
          </span>
        ) : null}
      </div>

      {!anyOk ? (
        <p className="mt-2 text-xs text-[#9CA3AF]">
          No external delivery history is available right now. The picture
          will fill in as more data becomes available.
        </p>
      ) : total === 0 ? (
        <p className="mt-2 text-xs text-[#9CA3AF]">
          Limited delivery history for this customer. Treat as a
          first-look case rather than a known buyer.
        </p>
      ) : (
        <p className="mt-2 text-xs text-[#9CA3AF]">
          Aggregated across{" "}
          {data.aggregate.contributingProviders.length} provider
          {data.aggregate.contributingProviders.length === 1 ? "" : "s"}{" "}
          on {total} prior order{total === 1 ? "" : "s"}.
        </p>
      )}

      <ul className="mt-3 space-y-2 border-t border-[rgba(209,213,219,0.08)] pt-3">
        {configuredEntries.map(([name, snap]) => (
          <ProviderRow key={name} name={name} snapshot={snap} />
        ))}
      </ul>

      {signalChips.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[rgba(209,213,219,0.08)] pt-3">
          {signalChips.map(({ key, label, tone }) => (
            <span
              key={key}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-2xs uppercase tracking-[0.06em] ${TONE_CLS[tone]}`}
            >
              {tone === "good" ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : tone === "watch" ? (
                <Info className="h-3 w-3" />
              ) : (
                <HelpCircle className="h-3 w-3" />
              )}
              {label}
            </span>
          ))}
        </div>
      ) : null}

      {data.freshness?.stale ? (
        <p className="mt-2 text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
          Some evidence is older — a refresh will update it.
        </p>
      ) : null}

      <p className="mt-3 text-2xs text-[#9CA3AF]">
        Operational evidence only. Cancellations may include
        merchant-side cancellations and are not buyer accusations.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Internal exports                                                           */
/* -------------------------------------------------------------------------- */

export const __INTERNAL = {
  isValidData,
  formatPct,
  formatRelative,
  providerDisplayName,
  SIGNAL_LABELS,
};
