"use client";

import * as React from "react";
import {
  CheckCircle2,
  HelpCircle,
  Info,
  Network,
  ShieldCheck,
} from "lucide-react";

/**
 * Network evidence panel — cross-merchant FraudSignal aggregate
 * surfaced as merchant-facing operational evidence (Phase 4A.5 F2).
 *
 * UX posture (binding):
 *   - Operational tone. Renders the server-side classifier output
 *     (`classifyNetworkEvidence`) verbatim — same tone the backend
 *     already produces.
 *   - K-anonymity preserved: the underlying lookup never exposes
 *     fewer than 2 OTHER merchants, and the classifier suppresses
 *     single-merchant signals. The component shows "X+ merchants"
 *     wording rather than exact counts at low merchantCounts.
 *   - Defensive: returns null on null / unmatched / invalid data.
 *   - Visibility-only — no mutations, no fraud-workflow triggers.
 */

type Label = "strong" | "caution" | "neutral" | "no_data";

interface NetworkEvidenceSignal {
  key: string;
  detail: string;
}

export interface NetworkEvidencePanelData {
  label: Label;
  matched: boolean;
  matchedOn: "phone+address" | "phone" | "address" | "none";
  merchantCount: number;
  totalObserved: number;
  successRate: number | null;
  rtoRate: number | null;
  signals: NetworkEvidenceSignal[];
  firstSeenAt?: string | Date | null;
  lastSeenAt?: string | Date | null;
  source?: "fraud_signal_v1";
}

const LABEL_META: Record<
  Label,
  { title: string; tone: "good" | "watch" | "muted"; icon: typeof CheckCircle2; description: string }
> = {
  strong: {
    title: "Strong network evidence",
    tone: "good",
    icon: ShieldCheck,
    description:
      "Customer has been observed delivering reliably across other merchants on the platform.",
  },
  caution: {
    title: "Network evidence to review",
    tone: "watch",
    icon: Info,
    description:
      "Other merchants have observed an elevated return pattern for this customer. Worth a closer look before booking.",
  },
  neutral: {
    title: "Mixed network evidence",
    tone: "muted",
    icon: Network,
    description:
      "Other merchants have seen this customer with mixed delivery outcomes. Treat as inconclusive.",
  },
  no_data: {
    title: "No network evidence",
    tone: "muted",
    icon: HelpCircle,
    description:
      "Cross-merchant evidence isn't available for this customer yet — either the network is still warming up or this is a new fingerprint.",
  },
};

const TONE_HEADER_CLS: Record<"good" | "watch" | "muted", string> = {
  good: "bg-[rgba(16,185,129,0.15)] text-[#34D399]",
  watch: "bg-[rgba(245,158,11,0.15)] text-[#FBBF24]",
  muted: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isValidData(d: unknown): d is NetworkEvidencePanelData {
  if (!d || typeof d !== "object") return false;
  const obj = d as Record<string, unknown>;
  if (typeof obj.matched !== "boolean") return false;
  if (typeof obj.label !== "string") return false;
  if (!["strong", "caution", "neutral", "no_data"].includes(obj.label as string)) {
    return false;
  }
  if (typeof obj.merchantCount !== "number") return false;
  if (typeof obj.totalObserved !== "number") return false;
  return true;
}

/**
 * K-anonymity-safe merchant count rendering. The server-side floor
 * (`MIN_MERCHANTS_FOR_SIGNAL=2`) means we never see counts below 2
 * via the classifier-applied path. We still render a "+ merchants"
 * suffix at small counts so a future change in floor doesn't expose
 * a precise small number that could be backed out.
 */
function formatMerchantCount(n: number): string {
  if (n < 2) return "—";
  if (n <= 5) return `${n}+ merchants`;
  if (n <= 10) return `${Math.round(n)} merchants`;
  // Round to the nearest 5 above 10 — k-anonymity hardening.
  const rounded = Math.round(n / 5) * 5;
  return `${rounded}+ merchants`;
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
  const days = Math.floor(ms / (24 * 3_600_000));
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/* -------------------------------------------------------------------------- */
/* Main component                                                             */
/* -------------------------------------------------------------------------- */

export function NetworkEvidencePanel({
  evidence,
}: {
  evidence: NetworkEvidencePanelData | null | undefined;
}) {
  if (!evidence) return null;
  if (!isValidData(evidence)) return null;
  // Server-side classifier returns matched=false for a no-network-hit
  // (every signal in the EMPTY result). We render nothing in that
  // case — drawer doesn't get a useless empty card.
  if (!evidence.matched && evidence.label === "no_data") return null;

  const meta = LABEL_META[evidence.label];
  const Icon = meta.icon;
  const lastSeen = formatRelative(evidence.lastSeenAt ?? null);

  return (
    <div className="rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#1A1D2E] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-[#60A5FA]" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">
            Network observations
          </h3>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${TONE_HEADER_CLS[meta.tone]}`}
        >
          <Icon className="h-3 w-3" />
          {meta.title}
        </span>
      </div>

      <p className="mt-2 text-xs text-[#9CA3AF]">{meta.description}</p>

      {/* Aggregate counters. Always rounded / k-anonymity-safe. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[rgba(209,213,219,0.08)] pt-3 text-xs text-[#D1D5DB]">
        <span className="tabular-nums">
          {formatMerchantCount(evidence.merchantCount)}
        </span>
        {evidence.totalObserved > 0 ? (
          <>
            <span className="text-[#9CA3AF]" aria-hidden>
              ·
            </span>
            <span className="tabular-nums">
              {evidence.totalObserved} order
              {evidence.totalObserved === 1 ? "" : "s"} observed
            </span>
          </>
        ) : null}
        {evidence.successRate !== null ? (
          <>
            <span className="text-[#9CA3AF]" aria-hidden>
              ·
            </span>
            <span className="tabular-nums">
              {formatPct(evidence.successRate)} delivered
            </span>
          </>
        ) : null}
        {lastSeen ? (
          <>
            <span className="text-[#9CA3AF]" aria-hidden>
              ·
            </span>
            <span className="text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
              Last seen {lastSeen}
            </span>
          </>
        ) : null}
      </div>

      {/* Server-classified signals — rendered verbatim. */}
      {Array.isArray(evidence.signals) && evidence.signals.length > 0 ? (
        <ul className="mt-3 space-y-1.5 border-t border-[rgba(209,213,219,0.08)] pt-3">
          {evidence.signals.map((s, i) => {
            const detail =
              typeof s?.detail === "string" && s.detail.length > 0
                ? s.detail
                : "Network observation recorded.";
            return (
              <li
                key={`${s?.key ?? "unknown"}-${i}`}
                className="flex items-start gap-2 text-xs text-[#D1D5DB]"
              >
                <Info className="mt-0.5 h-3 w-3 shrink-0 text-[#9CA3AF]" />
                <span>{detail}</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="mt-3 text-2xs text-[#9CA3AF]">
        Aggregate only — individual merchants are never disclosed.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Internal exports                                                           */
/* -------------------------------------------------------------------------- */

export const __INTERNAL = {
  isValidData,
  formatMerchantCount,
  formatPct,
  formatRelative,
  LABEL_META,
};
