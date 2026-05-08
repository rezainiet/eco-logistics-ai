"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";

/**
 * Operational incident banner — env-var driven, dashboard-only.
 *
 * Reads two PUBLIC env vars at build time:
 *
 *   NEXT_PUBLIC_INCIDENT_BANNER_TEXT   — one short message, plain text
 *   NEXT_PUBLIC_INCIDENT_BANNER_LEVEL  — "info" | "warning" | "critical"
 *
 * When TEXT is set, every dashboard route renders a top-of-page
 * banner. Critical-level renders cannot be dismissed (it's a hard
 * service-state signal); info / warning levels can be dismissed once
 * per browser via localStorage, keyed by a hash of the message so a
 * NEW incident text re-prompts even if the user dismissed an earlier
 * one.
 *
 * Why no backend / status-page service:
 *   - Real incidents are time-critical; redeploying the env var is
 *     faster (and more reliable) than updating a SaaS dashboard.
 *   - Zero new dependency. Zero new failure mode. The banner can
 *     never be the reason the dashboard breaks.
 *
 * Limitations (intentional, for now):
 *   - Banner state is tied to the deployed build. Clearing requires
 *     a redeploy (or a runtime equivalent — out of scope here).
 *   - One global banner; no per-merchant targeting.
 *   - No scheduled start/end. If you need that, escalate to a real
 *     status page; this is the bridge until then.
 */

const TEXT_ENV = process.env.NEXT_PUBLIC_INCIDENT_BANNER_TEXT ?? "";
const LEVEL_ENV = (
  process.env.NEXT_PUBLIC_INCIDENT_BANNER_LEVEL ?? "warning"
).toLowerCase() as "info" | "warning" | "critical";

const VALID_LEVELS = ["info", "warning", "critical"] as const;
type Level = (typeof VALID_LEVELS)[number];

function dismissalKey(text: string): string {
  // Tiny non-cryptographic hash — keyed on the message text so
  // changing the env var resets dismissals across all merchants
  // automatically.
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) & 0xffffffff;
  }
  return `cordon:incident:dismissed:${h.toString(16)}`;
}

export function IncidentBanner() {
  const text = TEXT_ENV.trim();
  const level: Level = (VALID_LEVELS as ReadonlyArray<string>).includes(
    LEVEL_ENV,
  )
    ? (LEVEL_ENV as Level)
    : "warning";
  const dismissible = level !== "critical";

  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!text) return;
    setHydrated(true);
    if (!dismissible) return;
    try {
      const stored = window.localStorage.getItem(dismissalKey(text));
      if (stored === "1") setDismissed(true);
    } catch {
      /* private mode / quota — ignore */
    }
  }, [text, dismissible]);

  if (!text) return null;
  if (dismissed) return null;
  if (!hydrated && dismissible) return null; // avoid hydration flicker

  const tone =
    level === "critical"
      ? "border-danger-border bg-danger-subtle text-danger"
      : level === "warning"
        ? "border-warning-border bg-warning-subtle text-warning"
        : "border-info-border bg-info-subtle text-info";

  const Icon = level === "info" ? Info : AlertTriangle;

  return (
    <div
      role={level === "critical" ? "alert" : "status"}
      className={
        "mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm " +
        tone
      }
    >
      <Icon
        className="mt-0.5 h-4 w-4 shrink-0"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <span className="font-medium">
          {level === "critical"
            ? "Service incident"
            : level === "warning"
              ? "Heads-up"
              : "Notice"}
          {": "}
        </span>
        <span>{text}</span>
      </div>
      {dismissible ? (
        <button
          type="button"
          onClick={() => {
            try {
              window.localStorage.setItem(dismissalKey(text), "1");
            } catch {
              /* ignore */
            }
            setDismissed(true);
          }}
          aria-label="Dismiss"
          className="-my-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
