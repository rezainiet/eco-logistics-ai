import { formatRelativeTime, statusPresentation } from "../_lib/status";
import type { PublicTrackingEvent } from "../_lib/fetch";

interface TimelineProps {
  events: PublicTrackingEvent[];
}

export function Timeline({ events }: TimelineProps) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-gray-500">No tracking updates yet — check back in a few hours.</p>
    );
  }
  return (
    <ol className="relative ml-3 space-y-5 border-l border-gray-200 pl-5">
      {events.map((e, i) => {
        const presentation = statusPresentation(e.status);
        const isLatest = i === 0;
        return (
          <li key={`${e.at}-${i}`} className="relative">
            <span
              className={`absolute -left-[27px] flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white ${
                isLatest ? "bg-gray-900" : "bg-gray-300"
              }`}
              aria-hidden
            />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-gray-900">{presentation.label}</span>
              <span className="text-xs text-gray-500">{formatRelativeTime(e.at)}</span>
            </div>
            {e.description ? (
              <p className="mt-0.5 text-sm text-gray-600">{e.description}</p>
            ) : null}
            {e.location ? (
              <p className="mt-0.5 text-xs text-gray-400">📍 {e.location}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
