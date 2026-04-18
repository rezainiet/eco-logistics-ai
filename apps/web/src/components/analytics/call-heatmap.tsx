"use client";

type Cell = { hour: number; total: number; answerRate: number; successRate: number; score: number };

function colorFor(score: number, total: number): string {
  if (total === 0) return "bg-muted";
  if (score >= 0.7) return "bg-green-600";
  if (score >= 0.5) return "bg-green-400";
  if (score >= 0.3) return "bg-amber-400";
  if (score >= 0.15) return "bg-orange-400";
  return "bg-red-400";
}

export function CallHeatmap({ data }: { data: Cell[] }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-12 gap-1 sm:grid-cols-24">
        {data.map((c) => (
          <div
            key={c.hour}
            title={`${c.hour}:00 — ${c.total} calls, answer ${(c.answerRate * 100).toFixed(0)}%, success ${(c.successRate * 100).toFixed(0)}%`}
            className={`aspect-square rounded-sm ${colorFor(c.score, c.total)}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Low</span>
        <div className="flex gap-0.5">
          <div className="h-3 w-3 rounded-sm bg-red-400" />
          <div className="h-3 w-3 rounded-sm bg-orange-400" />
          <div className="h-3 w-3 rounded-sm bg-amber-400" />
          <div className="h-3 w-3 rounded-sm bg-green-400" />
          <div className="h-3 w-3 rounded-sm bg-green-600" />
        </div>
        <span>High</span>
      </div>
    </div>
  );
}
