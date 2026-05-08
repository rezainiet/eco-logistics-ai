"use client";

import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  Info,
  type LucideIcon,
} from "lucide-react";

/**
 * Operational hint panel for the order detail drawer.
 *
 * Renders the `operationalHint` returned by `orders.getOrder` — a
 * merchant-readable label describing why this order needs attention.
 * Returns `null` when no hint fires (the engine returned `null`), so a
 * healthy order shows nothing extra.
 *
 * Visibility only — there are NO action buttons that mutate the order.
 * The "next step" is described in `suggestedAction` and the merchant
 * acts on it manually (call buyer, ping courier, etc.). NDR engagement
 * automation is a separate, future milestone.
 */

export interface OperationalHintData {
  code: string;
  severity: "info" | "warning" | "critical";
  label: string;
  suggestedAction: string;
  observedAt?: string | Date | null;
}

const SEVERITY_STYLE: Record<
  OperationalHintData["severity"],
  { cls: string; icon: LucideIcon; iconCls: string }
> = {
  info: {
    cls: "border-[rgba(96,165,250,0.18)] bg-[rgba(96,165,250,0.08)]",
    icon: Info,
    iconCls: "text-[#60A5FA]",
  },
  warning: {
    cls: "border-[rgba(251,191,36,0.20)] bg-[rgba(251,191,36,0.08)]",
    icon: AlertTriangle,
    iconCls: "text-[#FBBF24]",
  },
  critical: {
    cls: "border-[rgba(248,113,113,0.22)] bg-[rgba(248,113,113,0.08)]",
    icon: AlertCircle,
    iconCls: "text-[#F87171]",
  },
};

export function OperationalHintPanel({
  hint,
}: {
  hint: OperationalHintData | null | undefined;
}) {
  if (!hint) return null;
  const style = SEVERITY_STYLE[hint.severity];
  const Icon = style.icon;
  return (
    <div className={`rounded-lg border p-4 ${style.cls}`}>
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.iconCls}`} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[#F3F4F6]">{hint.label}</h3>
          <p className="mt-1 text-xs text-[#D1D5DB]">{hint.suggestedAction}</p>
          {hint.observedAt ? (
            <p className="mt-2 text-2xs uppercase tracking-[0.06em] text-[#9CA3AF]">
              Observed {formatRelative(hint.observedAt)}
            </p>
          ) : null}
        </div>
      </div>
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
