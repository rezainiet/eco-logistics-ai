"use client";

import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  Info,
  ShieldCheck,
} from "lucide-react";

/**
 * Delivery Reliability — observation-only operational context for the
 * order detail drawer.
 *
 * Surface contract:
 *   - Reads `order.deliveryReliability` from `orders.getOrder` (S6 wire).
 *   - Renders nothing when the field is `null` / `undefined` (the
 *     DELIVERY_RELIABILITY_READ_ENABLED flag is off, OR the backend
 *     read failed gracefully). Order detail rendering is unaffected.
 *   - Renders a soft no-data state when `tier === "no_data"`.
 *   - Otherwise renders a compact operational card: tier badge,
 *     confidence label, sample-count summary, signal list (verbatim
 *     `detail` strings from the classifier).
 *   - NEVER triggers writes, mutations, fraud workflows, or queues.
 *
 * UX posture (per S8 spec):
 *   - Calm, operational, trustworthy. No "fraud" / "AI" / "threat"
 *     language. No raw weights, formulas, or hashes.
 *   - Subdued palette matching `intelligence-panels.tsx`. Compact
 *     layout — fits in the same drawer column as the existing
 *     intent / address-quality panels.
 *   - Defensive: every prop is null-checked before use.
 */

type Tier = "verified" | "implicit" | "unverified" | "no_data";
type Confidence = "high" | "medium" | "low" | "unknown";
type SignalTone = "positive" | "negative" | "neutral";

export interface DeliveryReliabilitySignalShape {
  key: string;
  weight?: number;
  detail: string;
}

export interface DeliveryReliabilityPanelData {
  score: number;
  tier: Tier;
  confidence: Confidence;
  signals: DeliveryReliabilitySignalShape[];
  samplesConsidered: { customer: number; address: number; courier: number };
  computedAt?: string | Date | null;
  stale: boolean;
  noData: boolean;
}

const TIER_BADGE: Record<
  Tier,
  { label: string; cls: string; icon: typeof CheckCircle2; description: string }
> = {
  verified: {
    label: "Verified delivery context",
    cls: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
    icon: ShieldCheck,
    description:
      "Historical delivery patterns for this buyer, address, and courier lane look reliable.",
  },
  implicit: {
    label: "Mixed delivery context",
    cls: "bg-[rgba(59,130,246,0.15)] text-[#60A5FA]",
    icon: Info,
    description:
      "Some delivery history is available — outcomes are mixed but not concerning on their own.",
  },
  unverified: {
    label: "Watch delivery context",
    cls: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
    icon: AlertCircle,
    description:
      "Historical patterns suggest this order has elevated delivery risk. Worth a closer look before dispatch.",
  },
  no_data: {
    label: "Limited history",
    cls: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
    icon: HelpCircle,
    description:
      "Not enough delivery history yet to score this order. The reliability picture will fill in as outcomes accumulate.",
  },
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High confidence",
  medium: "Moderate confidence",
  low: "Limited confidence",
  unknown: "Insufficient historical data",
};

/**
 * Stable mapping from classifier signal keys → presentation tone. Keys not
 * in the map default to "neutral" — graceful for additions to the engine
 * that ship before the UI updates.
 */
const SIGNAL_TONE: Record<string, SignalTone> = {
  no_history_data: "neutral",
  customer_repeat_success: "positive",
  customer_repeat_rto: "negative",
  customer_low_success_rate: "negative",
  address_clean_history: "positive",
  address_repeat_rto: "negative",
  address_multi_buyer: "negative",
  courier_lane_strong: "positive",
  courier_lane_weak: "negative",
  courier_lane_unknown: "neutral",
  network_warning: "negative",
  address_quality_warning: "negative",
};

const TONE_VISUAL: Record<
  SignalTone,
  { icon: typeof CheckCircle2; iconCls: string; textCls: string }
> = {
  positive: {
    icon: CheckCircle2,
    iconCls: "text-[#34D399]",
    textCls: "text-[#D1D5DB]",
  },
  negative: {
    icon: AlertCircle,
    iconCls: "text-[#FBBF24]",
    textCls: "text-[#D1D5DB]",
  },
  neutral: {
    icon: Info,
    iconCls: "text-[#9CA3AF]",
    textCls: "text-[#D1D5DB]",
  },
};

function toneFor(key: string | undefined | null): SignalTone {
  if (!key) return "neutral";
  return SIGNAL_TONE[key] ?? "neutral";
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

function summarizeSamples(samples: {
  customer: number;
  address: number;
  courier: number;
}): string | null {
  const parts: string[] = [];
  const cust = safeNumber(samples?.customer);
  const addr = safeNumber(samples?.address);
  const cour = safeNumber(samples?.courier);
  if (cust > 0) parts.push(`${cust} buyer order${cust === 1 ? "" : "s"}`);
  if (addr > 0) parts.push(`${addr} address order${addr === 1 ? "" : "s"}`);
  if (cour > 0) parts.push(`${cour} courier observation${cour === 1 ? "" : "s"}`);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/**
 * Defensive guard — accept anything the wire might surface and refuse to
 * crash on legacy / malformed shapes.
 */
function isValidPanelData(d: unknown): d is DeliveryReliabilityPanelData {
  if (!d || typeof d !== "object") return false;
  const obj = d as Record<string, unknown>;
  if (typeof obj.tier !== "string") return false;
  if (!["verified", "implicit", "unverified", "no_data"].includes(obj.tier as string)) {
    return false;
  }
  if (typeof obj.noData !== "boolean") return false;
  if (typeof obj.stale !== "boolean") return false;
  if (typeof obj.score !== "number") return false;
  if (!obj.samplesConsidered || typeof obj.samplesConsidered !== "object") return false;
  return true;
}

export function DeliveryReliabilityPanel({
  reliability,
}: {
  reliability: DeliveryReliabilityPanelData | null | undefined;
}) {
  // Flag-off / read failure — render absolutely nothing. Order detail
  // rendering is unaffected.
  if (!reliability) return null;
  if (!isValidPanelData(reliability)) return null;

  const tier = reliability.tier;
  const meta = TIER_BADGE[tier];
  const TierIcon = meta.icon;
  const confidenceText = CONFIDENCE_LABEL[reliability.confidence] ?? CONFIDENCE_LABEL.unknown;
  const sampleSummary = summarizeSamples(reliability.samplesConsidered);
  const signals = Array.isArray(reliability.signals) ? reliability.signals : [];
  const computed = formatRelative(reliability.computedAt ?? null);

  return (
    <div className="rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#1A1D2E] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[#60A5FA]" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">
            Delivery reliability
          </h3>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${meta.cls}`}
        >
          <TierIcon className="h-3 w-3" />
          {meta.label}
        </span>
      </div>

      <p className="mt-2 text-xs text-[#9CA3AF]">{meta.description}</p>

      {tier !== "no_data" ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
          <span>{confidenceText}</span>
          {sampleSummary ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="lowercase tracking-normal text-[#9CA3AF]">
                Based on {sampleSummary}
              </span>
            </>
          ) : null}
          {computed ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Computed {computed}</span>
            </>
          ) : null}
        </div>
      ) : null}

      {reliability.stale && tier !== "no_data" ? (
        <div className="mt-2 inline-flex items-center gap-1 rounded bg-[rgba(156,163,175,0.10)] px-2 py-0.5 text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
          <Info className="h-3 w-3" />
          Some history is older than 6 months
        </div>
      ) : null}

      {tier === "no_data" ? null : signals.length > 0 ? (
        <ul className="mt-3 space-y-1.5 border-t border-[rgba(209,213,219,0.08)] pt-3">
          {signals.map((s, i) => {
            const tone = toneFor(s?.key);
            const visual = TONE_VISUAL[tone];
            const Icon = visual.icon;
            const detail =
              typeof s?.detail === "string" && s.detail.length > 0
                ? s.detail
                : "Operational signal observed.";
            return (
              <li
                key={`${s?.key ?? "unknown"}-${i}`}
                className={`flex items-start gap-2 text-xs ${visual.textCls}`}
              >
                <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${visual.iconCls}`} />
                <span>{detail}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Internal exports — exposed for future unit tests if apps/web ever gains    */
/* a unit-test runner. Not part of the public component API.                  */
/* -------------------------------------------------------------------------- */
export const __INTERNAL = {
  toneFor,
  summarizeSamples,
  formatRelative,
  isValidPanelData,
  TIER_BADGE,
  CONFIDENCE_LABEL,
  SIGNAL_TONE,
};
