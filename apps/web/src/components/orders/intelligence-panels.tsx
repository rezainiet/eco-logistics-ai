"use client";

import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  HelpCircle,
  MapPin,
  Sparkles,
} from "lucide-react";

/**
 * Intent + Address Intelligence panels for the order detail drawer.
 *
 * Observation-only surfaces — they READ `order.intent` and
 * `order.addressQuality` returned by `analytics.getOrder` (and by extension
 * `orders.getOrder`). Each panel is null-safe: legacy orders without the
 * subdocs render a soft "No data" state, never crash.
 *
 * Copy is operator-readable. No "AI", no "predictions", no probability
 * percentages. Each signal carries its own `detail` string from the engine,
 * surfaced verbatim — that is the contract: the merchant always knows WHY
 * a tier was picked.
 */

export interface IntentPanelData {
  score: number;
  tier: "verified" | "implicit" | "unverified" | "no_data";
  signals: Array<{ key: string; weight: number; detail: string }>;
  sessionsConsidered: number;
  computedAt?: string | Date | null;
}

export interface AddressQualityPanelData {
  score: number;
  completeness: "complete" | "partial" | "incomplete";
  landmarks: string[];
  hasNumber: boolean;
  tokenCount: number;
  scriptMix: "latin" | "bangla" | "mixed";
  missingHints: string[];
  computedAt?: string | Date | null;
}

const INTENT_TIER_BADGE: Record<
  IntentPanelData["tier"],
  { label: string; cls: string; icon: typeof CheckCircle2; description: string }
> = {
  verified: {
    label: "Verified",
    cls: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
    icon: CheckCircle2,
    description: "This buyer engaged with your store and showed clear commitment.",
  },
  implicit: {
    label: "Implicit",
    cls: "bg-[rgba(59,130,246,0.15)] text-[#60A5FA]",
    icon: Eye,
    description: "This buyer placed the order with moderate engagement signals.",
  },
  unverified: {
    label: "Unverified",
    cls: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
    icon: AlertCircle,
    description: "This buyer did not engage with your store before checkout.",
  },
  no_data: {
    label: "No session data",
    cls: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
    icon: HelpCircle,
    description:
      "This order was placed via dashboard, CSV, or a storefront where Cordon's SDK is not installed.",
  },
};

const COMPLETENESS_BADGE: Record<
  AddressQualityPanelData["completeness"],
  { label: string; cls: string }
> = {
  complete: {
    label: "Complete",
    cls: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
  },
  partial: {
    label: "Partial",
    cls: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
  },
  incomplete: {
    label: "Incomplete",
    cls: "bg-[rgba(239,68,68,0.15)] text-[#F87171]",
  },
};

const HINT_COPY: Record<string, string> = {
  no_anchor:
    "No landmark and no road/house number — rider has no anchor point.",
  no_landmark:
    "No landmark detected — ask the buyer for a nearby mosque, bazar, or school.",
  no_number:
    "No road or house number — request one before dispatch.",
  too_short: "Address is too short to deliver reliably.",
  too_few_tokens: "Address has too few details — ask for more.",
  mixed_script:
    "Address mixes Bangla and English — couriers may interpret unevenly.",
};

export function IntentPanel({ intent }: { intent: IntentPanelData | null | undefined }) {
  if (!intent) return null;
  const meta = INTENT_TIER_BADGE[intent.tier];
  const Icon = meta.icon;
  return (
    <div className="rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#1A1D2E] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[#A78BFA]" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">Buyer intent</h3>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${meta.cls}`}
        >
          <Icon className="h-3 w-3" />
          {meta.label}
        </span>
      </div>

      <p className="mt-2 text-xs text-[#9CA3AF]">{meta.description}</p>

      <div className="mt-3 flex items-center gap-3 text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
        <span>Score: <span className="text-[#F3F4F6]">{intent.score}</span></span>
        <span>·</span>
        <span>
          Sessions:{" "}
          <span className="text-[#F3F4F6]">{intent.sessionsConsidered}</span>
        </span>
        {intent.computedAt ? (
          <>
            <span>·</span>
            <span>Computed {formatRelative(intent.computedAt)}</span>
          </>
        ) : null}
      </div>

      {intent.signals.length > 0 ? (
        <ul className="mt-3 space-y-1.5 border-t border-[rgba(209,213,219,0.08)] pt-3">
          {intent.signals.map((s, i) => (
            <li
              key={`${s.key}-${i}`}
              className="flex items-start gap-2 text-xs text-[#D1D5DB]"
            >
              <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#A78BFA]" />
              <span>{s.detail}</span>
              {s.weight > 0 ? (
                <span className="ml-auto shrink-0 text-2xs text-[#9CA3AF]">
                  +{s.weight}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AddressQualityPanel({
  addressQuality,
  thana,
}: {
  addressQuality: AddressQualityPanelData | null | undefined;
  thana?: string | null;
}) {
  if (!addressQuality) return null;
  const meta = COMPLETENESS_BADGE[addressQuality.completeness];
  return (
    <div className="rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#1A1D2E] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-[#34D399]" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">
            Address quality
          </h3>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${meta.cls}`}
        >
          {meta.label}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
        <div>
          <span>Score</span>
          <span className="ml-2 text-[#F3F4F6]">{addressQuality.score}</span>
        </div>
        <div>
          <span>Tokens</span>
          <span className="ml-2 text-[#F3F4F6]">{addressQuality.tokenCount}</span>
        </div>
        <div>
          <span>Has number</span>
          <span className="ml-2 text-[#F3F4F6]">
            {addressQuality.hasNumber ? "yes" : "no"}
          </span>
        </div>
        <div>
          <span>Script</span>
          <span className="ml-2 text-[#F3F4F6] capitalize">
            {addressQuality.scriptMix}
          </span>
        </div>
        {thana ? (
          <div className="col-span-2">
            <span>Thana</span>
            <span className="ml-2 text-[#F3F4F6] capitalize">{thana}</span>
          </div>
        ) : null}
      </div>

      {addressQuality.landmarks.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[rgba(209,213,219,0.08)] pt-3">
          <span className="text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
            Detected landmarks:
          </span>
          {addressQuality.landmarks.map((l) => (
            <span
              key={l}
              className="rounded bg-[rgba(52,211,153,0.12)] px-2 py-0.5 text-2xs text-[#34D399] capitalize"
            >
              {l}
            </span>
          ))}
        </div>
      ) : null}

      {addressQuality.missingHints.length > 0 ? (
        <ul className="mt-3 space-y-1.5 border-t border-[rgba(209,213,219,0.08)] pt-3">
          {addressQuality.missingHints.map((h) => (
            <li
              key={h}
              className="flex items-start gap-2 text-xs text-[#FBBF24]"
            >
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{HINT_COPY[h] ?? h.replace(/_/g, " ")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatRelative(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
