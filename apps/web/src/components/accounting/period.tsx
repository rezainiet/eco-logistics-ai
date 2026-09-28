"use client";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { dhakaToday } from "./entry-dialog";

export type PeriodValue =
  | { preset: "today" | "month" | "year" }
  | { preset: "custom"; from: string; to: string };

const PRESETS = [
  ["today", "Today"],
  ["month", "This month"],
  ["year", "This year"],
  ["custom", "Custom"],
] as const;

export function periodLabel(p: PeriodValue): string {
  if (p.preset === "custom") return `${p.from} – ${p.to}`;
  return p.preset === "today" ? "Today" : p.preset === "month" ? "This month" : "This year";
}

/** Today / This month / This year / Custom date range (Bangladesh days). */
export function PeriodPicker({ value, onChange }: { value: PeriodValue; onChange: (p: PeriodValue) => void }) {
  const custom = value.preset === "custom" ? value : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Period">
        {PRESETS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={value.preset === key}
            onClick={() => {
              if (key === "custom") {
                const today = dhakaToday();
                onChange({ preset: "custom", from: `${today.slice(0, 7)}-01`, to: today });
              } else onChange({ preset: key });
            }}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              value.preset === key ? "border-brand/40 bg-brand/10 text-fg" : "border-stroke/12 text-fg-subtle hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {custom ? (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="From"
            className="h-9 w-40"
            value={custom.from}
            max={custom.to}
            onChange={(e) => e.target.value && onChange({ ...custom, from: e.target.value })}
          />
          <span className="text-xs text-fg-subtle">to</span>
          <Input
            type="date"
            aria-label="To"
            className="h-9 w-40"
            value={custom.to}
            min={custom.from}
            onChange={(e) => e.target.value && onChange({ ...custom, to: e.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}
