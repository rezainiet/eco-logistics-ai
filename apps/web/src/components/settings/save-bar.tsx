"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Sticky save-bar — the canonical "you have unsaved changes" pattern.
 *
 * Replaces five different ad-hoc save UIs in the old settings monolith
 * (audit P0-5). Mounted at the bottom of a section's form; it slides
 * into view when `dirty` is true, and stays out of the way otherwise.
 *
 * Mobile: pinned above the bottom-nav bar so the save action is
 * always reachable on long forms (audit P1-11). On desktop it pins to
 * the section's right edge so it doesn't overlap the sidebar.
 *
 * Sections are still in charge of their own state; this is a pure
 * presentation primitive. We intentionally do NOT pull form state in
 * here — every section has slightly different "is this dirty"
 * semantics (couriers compare account IDs; security compares password
 * hashes; branding compares hex colors), and a generic state
 * container would either be too rigid or recreate the same bugs in a
 * shared place. One save-bar look, many save-bar drivers.
 */
export type SaveBarProps = {
  /** Show the bar. Pass derived "form is dirty" state. */
  dirty: boolean;
  /** Show the spinner + disable buttons during async save. */
  saving?: boolean;
  /** Disable Save (e.g. validation failing). Bar still visible. */
  saveDisabled?: boolean;
  /** Custom Save label. Defaults to "Save changes". */
  saveLabel?: string;
  /** Custom Discard label. Defaults to "Discard". */
  discardLabel?: string;
  onSave: () => void;
  onDiscard: () => void;
  className?: string;
};

export function SaveBar({
  dirty,
  saving = false,
  saveDisabled = false,
  saveLabel = "Save changes",
  discardLabel = "Discard",
  onSave,
  onDiscard,
  className,
}: SaveBarProps) {
  /*
    We mount the bar always (so the slide transition has something to
    animate against) but flip pointer-events when hidden, so it can't
    grab clicks meant for the form below. Same trick the Stripe
    dashboard uses — feels much smoother than a `display: none`
    toggle.
  */
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      aria-hidden={!dirty}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 transition-all duration-200 md:bottom-3 md:pb-0",
        // Mobile: sit above the bottom-nav (h-14 + safe-area). Desktop:
        // float in the bottom of the content area.
        "pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem+3.5rem)] md:pb-0",
        dirty
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0",
        className,
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-xl border border-stroke/12 bg-surface/95 px-4 py-3 shadow-lg backdrop-blur-md supports-[backdrop-filter]:bg-surface/80",
          "sm:gap-4 sm:px-5",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full bg-warning shadow-[0_0_0_4px_hsl(var(--warning-subtle))]"
          />
          <p className="truncate text-sm font-medium text-fg">
            You have unsaved changes
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDiscard}
            disabled={saving}
            className="border-stroke/14 bg-surface-overlay text-fg-muted hover:bg-surface-hover"
          >
            {discardLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={saving || saveDisabled}
            className="bg-brand text-white hover:bg-brand-hover"
          >
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
