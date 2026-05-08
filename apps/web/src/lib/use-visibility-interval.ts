"use client";

import { useEffect, useState } from "react";

/**
 * Visibility-aware polling-interval helper for react-query.
 *
 * Pass the result straight into `useQuery({ refetchInterval })`:
 *
 *   const interval = useVisibilityInterval(30_000);
 *   trpc.x.useQuery(undefined, { refetchInterval: interval });
 *
 * When the tab is hidden (background, locked phone, switched workspace)
 * the function returns `false` and react-query stops the timer. When the
 * tab returns to `visible`, it resumes at the requested interval.
 *
 * Why this matters at scale:
 *
 *   • A merchant who keeps the dashboard open in a background tab pays
 *     the cost of every dashboard poller every interval — for the
 *     integrations page that's 4 timers ticking forever. Pausing while
 *     hidden cuts steady-state load against the API at zero UX cost
 *     (the visibility-change listener triggers an immediate refetch on
 *     return, so the data is fresh by the time the merchant looks).
 *
 *   • react-query's `refetchOnWindowFocus` already handles the "user
 *     came back" path. Using `refetchInterval: false` while hidden
 *     defers to that behaviour instead of fighting it.
 *
 * SSR-safe: the initial render reads `document.visibilityState`
 * defensively (treating "no document" as visible) so server snapshots
 * don't disagree with the first client paint.
 */
export function useVisibilityInterval(ms: number): number | false {
  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === "undefined"
      ? true
      : document.visibilityState === "visible",
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => {
      setVisible(document.visibilityState === "visible");
    };
    // Initial sync — the SSR fallback may have over-counted the tab as
    // visible. Reading once on mount catches the case where the
    // dashboard was restored into a background tab.
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible ? ms : false;
}
