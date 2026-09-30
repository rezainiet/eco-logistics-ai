"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UnsavedChangesDialogState } from "@/lib/unsaved-changes/use-unsaved-changes-guard";

/**
 * The one "Unsaved changes" prompt. Escape, the close button and clicking
 * outside all mean "Keep editing" — the safe choice — and focus goes back to
 * whatever the merchant clicked.
 */
export function UnsavedChangesDialog({
  open,
  kind,
  description,
  saving,
  onKeepEditing,
  onDiscard,
  onSave,
  restoreFocus,
}: UnsavedChangesDialogState) {
  const leaving = kind === "navigate";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onKeepEditing()}>
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={(e) => saving && e.preventDefault()}
        // Opened programmatically (no Dialog.Trigger), so Radix has nothing
        // to return focus to — send it back to the link/button that asked.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            {description ??
              (leaving
                ? "You have changes that haven't been saved. Leave without saving?"
                : "You have changes that haven't been saved. They will be lost if you continue.")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onKeepEditing} disabled={saving} autoFocus>
            Keep editing
          </Button>
          <Button type="button" variant="destructive" onClick={onDiscard} disabled={saving}>
            {leaving ? "Leave without saving" : "Discard changes"}
          </Button>
          {onSave ? (
            <Button type="button" variant="brand" onClick={onSave} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : null}
              {leaving ? "Save draft and leave" : "Save draft and continue"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
