"use client";

type Cell = {
  hour: number;
  total: number;
  answerRate: number;
  successRate: number;
  score: number;
};

function colorFor(score: number, total: number): string {
  if (total === 0) return "bg-surface-raised";
  if (score >= 0.7) return "bg-[hsl(160_84%_39%)]";
  if (score >= 0.5) return "bg-[hsl(160_84%_52%)]";
  if (score >= 0.3) return "bg-[hsl(38_92%_55%)]";
  if (score >= 0.15) return "bg-[hsl(22_92%_55%)]";
  return "bg-[hsl(0_84%_66%)]";
}

export function CallHeatmap({ data }: { data: Cell[] }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-12 gap-1 sm:grid-cols-24">
        {data.map((c) => (
          <div
            key={c.hour}
            title={`${c.hour}:00 — ${c.total} calls · answered ${(c.answerRate * 100).toFixed(0)}% · success ${(c.successRate * 100).toFixed(0)}%`}
            className={`aspect-square rounded-sm ${colorFor(c.score, c.total)}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-fg-faint">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-subtle">
        <span>Low</span>
        <div className="flex gap-0.5">
          <div className="h-3 w-3 rounded-sm bg-[hsl(0_84%_66%)]" />
          <div className="h-3 w-3 rounded-sm bg-[hsl(22_92%_55%)]" />
          <div className="h-3 w-3 rounded-sm bg-[hsl(38_92%_55%)]" />
          <div className="h-3 w-3 rounded-sm bg-[hsl(160_84%_52%)]" />
          <div className="h-3 w-3 rounded-sm bg-[hsl(160_84%_39%)]" />
        </div>
        <span>High</span>
      </div>
    </div>
  );
}
