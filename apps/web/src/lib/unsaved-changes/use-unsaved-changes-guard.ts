"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  type BackGuard,
  type GuardIntentKind,
  createBackGuard,
  createUnsavedChangesController,
  guardedNavigationTarget,
} from "./guard";

export interface UnsavedChangesDialogState {
  open: boolean;
  kind: GuardIntentKind;
  description?: string;
  saving: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
  /** Present only when the editor can save right now. */
  onSave?: () => void;
  /**
   * Put focus back on the control that triggered the prompt (the link or
   * button) when it closes without leaving. The prompt opens
   * programmatically, so the dialog has no trigger of its own to return to.
   */
  restoreFocus: () => void;
}

const focusableOrNull = (el: Element | null): HTMLElement | null =>
  el instanceof HTMLElement && el !== document.body ? el : null;

/**
 * Protects an editor's unsaved state from everything that would silently
 * throw it away:
 *   - in-app links (sidebar, bottom nav, breadcrumbs, back arrows) — caught
 *     in the capture phase before Next's <Link> handles them;
 *   - browser Back (see createBackGuard);
 *   - reload / close / external links — the native beforeunload prompt;
 *   - editor actions that discard the draft — via `guard(run, description)`.
 *
 * Render <UnsavedChangesDialog {...dialog} /> once in the editor.
 */
export function useUnsavedChangesGuard({
  dirty,
  save,
}: {
  dirty: boolean;
  /** Saves the editor; resolve true on success. Omit when saving isn't possible. */
  save?: (() => Promise<boolean>) | null;
}) {
  const router = useRouter();
  const [controller] = useState(createUnsavedChangesController);
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const backRef = useRef<BackGuard | null>(null);
  // Once the merchant chose to leave, stop re-arming Back for this editor.
  const leavingRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    controller.setDirty(dirty);
  }, [controller, dirty]);

  const leave = useCallback((go: () => void) => {
    leavingRef.current = true;
    const back = backRef.current;
    if (back) back.disarm(go);
    else go();
  }, []);

  // Browser Back.
  useEffect(() => {
    const back = createBackGuard({
      history: window.history,
      currentUrl: () => window.location.href,
      onBack: () => {
        if (!controller.getSnapshot().pending) returnFocusRef.current = focusableOrNull(document.activeElement);
        const r = controller.attempt({ kind: "navigate", run: () => (leavingRef.current = true, back.leaveBack()) });
        if (r === "ignored") back.arm(); // a prompt is already open — stay put
      },
    });
    backRef.current = back;
    const onPop = () => back.handlePopState();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      backRef.current = null;
    };
  }, [controller]);

  // Keep the Back guard armed exactly while dirty and no prompt is open.
  useEffect(() => {
    const back = backRef.current;
    if (!back || leavingRef.current) return;
    if (dirty && !snap.pending) back.arm();
    else if (!dirty) back.disarm();
  }, [dirty, snap.pending]);

  // In-app links.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!controller.getSnapshot().dirty) return;
      const el = e.target instanceof Element ? e.target.closest("a[href]") : null;
      const a = el instanceof HTMLAnchorElement ? el : null;
      const href = guardedNavigationTarget(
        e,
        a && {
          href: a.href,
          target: a.getAttribute("target"),
          download: a.hasAttribute("download"),
          ignore: a.hasAttribute("data-unsaved-ignore"),
        },
        window.location.href,
      );
      if (!href) return;
      // Before Next's <Link> (React listens on the root, below document).
      e.preventDefault();
      e.stopPropagation();
      if (!controller.getSnapshot().pending) returnFocusRef.current = a;
      controller.attempt({ kind: "navigate", run: () => leave(() => router.push(href)) });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [controller, leave, router]);

  // Reload / close tab / leave the site.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const guard = useCallback(
    (run: () => void, description?: string) => {
      if (!controller.getSnapshot().pending) returnFocusRef.current = focusableOrNull(document.activeElement);
      return controller.attempt({ kind: "action", run, description });
    },
    [controller],
  );

  const restoreFocus = useCallback(() => {
    const el = returnFocusRef.current;
    returnFocusRef.current = null;
    if (el && el.isConnected) el.focus();
  }, []);

  const dialog: UnsavedChangesDialogState = {
    open: snap.pending !== null,
    kind: snap.pending?.kind ?? "navigate",
    description: snap.pending?.description,
    saving: snap.saving,
    onKeepEditing: controller.keepEditing,
    onDiscard: controller.discardAndContinue,
    onSave: save ? () => void controller.saveAndContinue(save) : undefined,
    restoreFocus,
  };

  return { guard, dialog };
}
