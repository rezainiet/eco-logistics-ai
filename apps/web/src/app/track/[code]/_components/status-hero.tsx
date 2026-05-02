import { type StatusPresentation } from "../_lib/status";

interface StatusHeroProps {
  presentation: StatusPresentation;
  /** Hex (#rrggbb) — already sanitized by safeHexColor on the server. */
  primaryColor?: string | null;
}

/**
 * Big visual status hero. Uses the merchant primary color as the bar
 * accent if provided, otherwise falls back to neutral grays. The merchant
 * color is applied via inline `style={{ backgroundColor }}`, which is safe
 * because the value is `#rrggbb` and validated upstream — there is no way
 * for a hostile color to escape into a CSS expression.
 */
export function StatusHero({ presentation, primaryColor }: StatusHeroProps) {
  const accent = primaryColor ?? "#0f172a";
  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium ${presentation.pillClass}`}
        >
          <span aria-hidden>{presentation.emoji}</span>
          {presentation.label}
        </span>
      </div>
      <h1 className="mt-3 text-2xl font-semibold text-gray-900">{presentation.label}</h1>
      <p className="mt-1 text-sm text-gray-600">{presentation.hint}</p>
      <ProgressBar step={presentation.step} accent={accent} />
    </div>
  );
}

const STEPS = ["Processing", "Packed", "Shipped", "Out for delivery", "Delivered"] as const;

function ProgressBar({ step, accent }: { step: number; accent: string }) {
  const pct = Math.max(0, Math.min(4, step)) * 25;
  return (
    <div className="mt-5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, backgroundColor: accent }}
        />
      </div>
      <ol className="mt-3 flex items-start justify-between text-[10px] font-medium uppercase tracking-wider text-gray-400 sm:text-xs">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`flex flex-1 flex-col items-center gap-1 ${i <= step ? "text-gray-900" : ""}`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: i <= step ? accent : undefined }}
              aria-hidden
            />
            <span className="text-center leading-tight">{label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
