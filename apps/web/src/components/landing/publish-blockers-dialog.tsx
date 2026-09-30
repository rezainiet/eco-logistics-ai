"use client";

import { type Ref, useRef } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type PublishBlocker, blockerHeadline, blockerWhere } from "./publish-blockers";

/**
 * Shown instead of the publish confirmation when the page can't be published
 * yet. Lists every blocking field by its human label; each entry jumps to its
 * field, and the primary action jumps to the first one. Closing it (Escape,
 * ×, Cancel) keeps the fields marked in the editor.
 */
export function PublishBlockersDialog({
  open,
  onOpenChange,
  blockers,
  multiLocale,
  onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blockers: readonly PublishBlocker[];
  multiLocale: boolean;
  /** Close the dialog, open the field's section and focus it. */
  onJump: (blocker: PublishBlocker) => void;
}) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  // After a jump the field takes focus; don't let the dialog hand it back to
  // the Publish button on close. (Escape / Cancel still return it there.)
  const jumped = useRef(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md flex-col gap-4 p-5 sm:p-6"
        onOpenAutoFocus={(e) => {
          // Land on the action that fixes things, not on the first list entry.
          e.preventDefault();
          primaryRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          if (jumped.current) {
            e.preventDefault();
            jumped.current = false;
          }
        }}
      >
        <PublishBlockersBody
          blockers={blockers}
          multiLocale={multiLocale}
          primaryRef={primaryRef}
          onCancel={() => onOpenChange(false)}
          onJump={(b) => {
            jumped.current = true;
            onJump(b);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Dialog body: title, the list of blocking fields, and the actions. Hook-free. */
export function PublishBlockersBody({
  blockers,
  multiLocale,
  primaryRef,
  onCancel,
  onJump,
}: {
  blockers: readonly PublishBlocker[];
  multiLocale: boolean;
  primaryRef?: Ref<HTMLButtonElement>;
  onCancel: () => void;
  onJump: (blocker: PublishBlocker) => void;
}) {
  const first = blockers.find((b) => b.fieldPath) ?? null;
  const anyMissing = blockers.some((b) => b.missing);
  return (
    <>
      <DialogHeader className="text-left">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-danger-subtle text-danger">
          <AlertTriangle className="h-5 w-5" aria-hidden />
        </div>
        <DialogTitle>{blockerHeadline(blockers)}</DialogTitle>
        <DialogDescription>
          Your page can&apos;t be published until {blockers.length === 1 ? "this is" : "these are"} filled in. Your draft is kept as it is.
        </DialogDescription>
      </DialogHeader>

      <ul aria-label="Fields to fix" className="-mx-1 min-h-0 space-y-1 overflow-y-auto px-1">
        {blockers.map((b) => {
          const where = blockerWhere(b, multiLocale);
          const body = (
            <>
              <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-danger" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{b.fieldLabel}</span>
                <span className="block text-2xs text-fg-subtle">
                  {where ? `${where} — ` : ""}
                  {b.message}
                </span>
              </span>
            </>
          );
          return (
            <li key={b.key}>
              {b.fieldPath ? (
                <button
                  type="button"
                  onClick={() => onJump(b)}
                  className="flex w-full items-start gap-2.5 rounded-md border border-danger-border/60 bg-danger-subtle/40 px-3 py-2 text-left transition-colors hover:bg-danger-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                  aria-label={`Go to ${b.fieldLabel}${where ? ` (${where})` : ""}`}
                >
                  {body}
                  <ChevronRight aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />
                </button>
              ) : (
                <div className="flex items-start gap-2.5 rounded-md border border-danger-border/60 bg-danger-subtle/40 px-3 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>

      <DialogFooter className="gap-2 sm:gap-0">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button ref={primaryRef} disabled={!first} onClick={() => first && onJump(first)}>
          {anyMissing ? "Fix missing fields" : "Fix these fields"}
        </Button>
      </DialogFooter>
    </>
  );
}
