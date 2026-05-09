"use client";

import * as React from "react";
import {
  CheckCircle2,
  HelpCircle,
  Lightbulb,
  Phone,
} from "lucide-react";
import {
  buildOperationalRecommendations,
  type RecommendationInputs,
  type RecommendationTone,
  type OperationalRecommendation,
} from "@/lib/operational-recommendations";

/**
 * Operational recommendation list — advisory next-steps merged from
 * all evidence available on the order.
 *
 * UX posture (binding):
 *   - ADVISORY ONLY. Every entry is a suggestion, never an
 *     enforcement.
 *   - Operational tone — consistent with the existing
 *     ExternalDeliveryHistoryCard / NetworkEvidencePanel.
 *   - Defensive: returns null when no recommendations apply (drawer
 *     never gets an empty card).
 *   - Mobile-safe: rows wrap on overflow.
 */

const TONE_CLS: Record<
  RecommendationTone,
  { iconCls: string; bg: string }
> = {
  good: {
    iconCls: "text-[#34D399]",
    bg: "bg-[rgba(16,185,129,0.10)]",
  },
  watch: {
    iconCls: "text-[#FBBF24]",
    bg: "bg-[rgba(245,158,11,0.10)]",
  },
  muted: {
    iconCls: "text-[#9CA3AF]",
    bg: "bg-[rgba(156,163,175,0.08)]",
  },
};

function iconFor(rec: OperationalRecommendation) {
  if (rec.key === "low_friction_order") return CheckCircle2;
  if (rec.key === "confirm_by_phone") return Phone;
  if (rec.key === "consider_partial_advance") return HelpCircle;
  return Lightbulb;
}

export function OperationalRecommendationList({
  inputs,
}: {
  inputs: RecommendationInputs | null | undefined;
}) {
  const recommendations = React.useMemo(
    () => buildOperationalRecommendations(inputs ?? null),
    [inputs],
  );

  if (recommendations.length === 0) return null;

  return (
    <div className="rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#1A1D2E] p-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="h-4 w-4 text-[#60A5FA]" />
        <h3 className="text-sm font-semibold text-[#F3F4F6]">
          Operational recommendations
        </h3>
      </div>
      <p className="mt-1 text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
        Advisory only — merchant decides
      </p>

      <ul className="mt-3 space-y-2">
        {recommendations.map((rec) => {
          const Icon = iconFor(rec);
          const tone = TONE_CLS[rec.tone];
          return (
            <li
              key={rec.key}
              className={`flex items-start gap-2 rounded px-2 py-1.5 ${tone.bg}`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.iconCls}`} />
              <div className="text-xs">
                <div className="font-medium text-[#F3F4F6]">{rec.label}</div>
                <div className="text-[#9CA3AF]">{rec.description}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
