/**
 * Unsaved-changes guard — the framework-free core.
 *
 * One controller per editor. Anything that would throw the editor's local
 * state away (in-app navigation, browser Back, a discarding action such as
 * restoring a revision) goes through `attempt()`:
 *
 *   clean            → the intent runs immediately ("proceeded")
 *   dirty            → the intent is held and the prompt opens ("prompted")
 *   dirty + prompt   → ignored; a second click never stacks a second prompt
 *
 * From the prompt the merchant can Keep editing (drop the intent), Leave /
 * Discard (run it without saving) or — where the editor supports it — Save
 * and continue (run it only if the save succeeds).
 *
 * The React hook (use-unsaved-changes-guard.ts) feeds this from link clicks,
 * popstate and beforeunload; the pure helpers below decide which clicks are
 * navigations worth guarding. Everything here is unit tested without a DOM.
 */

export type GuardIntentKind = "navigate" | "action";

export interface GuardIntent {
  kind: GuardIntentKind;
  run: () => void;
  /** Optional copy for the prompt (actions explain what they discard). */
  description?: string;
}

export type AttemptResult = "proceeded" | "prompted" | "ignored";

export interface GuardSnapshot {
  dirty: boolean;
  pending: GuardIntent | null;
  saving: boolean;
}

export function createUnsavedChangesController() {
  let snapshot: GuardSnapshot = { dirty: false, pending: null, saving: false };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<GuardSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const l of listeners) l();
  };

  return {
    getSnapshot: (): GuardSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    setDirty(dirty: boolean) {
      if (dirty !== snapshot.dirty) set({ dirty });
    },

    attempt(intent: GuardIntent): AttemptResult {
      if (snapshot.pending || snapshot.saving) return "ignored";
      if (!snapshot.dirty) {
        intent.run();
        return "proceeded";
      }
      set({ pending: intent });
      return "prompted";
    },

    /** "Keep editing" — nothing happens, the edits stay. */
    keepEditing() {
      if (snapshot.pending && !snapshot.saving) set({ pending: null });
    },

    /** "Leave without saving" / "Discard and continue". */
    discardAndContinue() {
      const intent = snapshot.pending;
      if (!intent || snapshot.saving) return;
      set({ pending: null });
      intent.run();
    },

    /**
     * "Save and continue": runs the held intent only after `save` resolves
     * true. On failure the prompt stays open with the edits intact (the save
     * itself reports why).
     */
    async saveAndContinue(save: () => Promise<boolean>): Promise<boolean> {
      const intent = snapshot.pending;
      if (!intent || snapshot.saving) return false;
      set({ saving: true });
      let ok = false;
      try {
        ok = await save();
      } catch {
        ok = false;
      }
      if (!ok) {
        set({ saving: false });
        return false;
      }
      set({ saving: false, pending: null });
      intent.run();
      return true;
    },
  };
}

export type UnsavedChangesController = ReturnType<typeof createUnsavedChangesController>;

// ── Which clicks are navigations? ───────────────────────────────────────────

export interface ClickLike {
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface AnchorLike {
  href: string;
  target: string | null;
  download: boolean;
  /** `data-unsaved-ignore` — the link is known not to leave the editor. */
  ignore: boolean;
}

/**
 * The in-app path a click would navigate to, or null when the click is not
 * a same-tab, same-origin navigation away from the current URL (new tabs,
 * downloads, external sites — covered by beforeunload — modified clicks and
 * in-page #anchors are left alone).
 */
export function guardedNavigationTarget(click: ClickLike, anchor: AnchorLike | null, currentHref: string): string | null {
  if (!anchor || click.defaultPrevented || anchor.ignore) return null;
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (anchor.download) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  let to: URL;
  let from: URL;
  try {
    from = new URL(currentHref);
    to = new URL(anchor.href, from);
  } catch {
    return null;
  }
  if (to.protocol !== "http:" && to.protocol !== "https:") return null;
  if (to.origin !== from.origin) return null;
  if (to.pathname === from.pathname && to.search === from.search) return null; // same page / hash only
  return `${to.pathname}${to.search}${to.hash}`;
}

// ── Browser Back ────────────────────────────────────────────────────────────

export interface HistoryLike {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url?: string | null): void;
  back(): void;
}

/**
 * Browser Back while dirty. Next.js' App Router cannot cancel a popstate, so
 * while the editor is dirty we keep one duplicate history entry (same URL,
 * same router state) on top. Back then only pops that duplicate — the page
 * does not change — and we ask. "Keep editing" re-arms; "Leave" goes back
 * for real. The duplicate is removed again when the editor becomes clean or
 * before a guarded link navigation, so history stays tidy.
 */
export function createBackGuard(deps: {
  history: HistoryLike;
  currentUrl: () => string;
  /** Called when Back was pressed while armed; the guard is now disarmed. */
  onBack: () => void;
}) {
  let armed = false;
  let ignoreNextPop = false;
  let afterUnwind: (() => void) | null = null;

  return {
    isArmed: () => armed,

    arm() {
      if (armed) return;
      deps.history.pushState(deps.history.state, "", deps.currentUrl());
      armed = true;
    },

    /** Remove the duplicate entry (if any), then run `then` on the real entry. */
    disarm(then?: () => void) {
      if (!armed) {
        then?.();
        return;
      }
      armed = false;
      ignoreNextPop = true;
      afterUnwind = then ?? null;
      deps.history.back();
    },

    /** Wire to window "popstate". */
    handlePopState() {
      if (ignoreNextPop) {
        ignoreNextPop = false;
        const next = afterUnwind;
        afterUnwind = null;
        next?.();
        return;
      }
      if (!armed) return;
      armed = false; // the duplicate was just popped
      deps.onBack();
    },

    /** "Leave" after a Back prompt: continue the Back the user asked for. */
    leaveBack() {
      ignoreNextPop = true;
      afterUnwind = null;
      deps.history.back();
    },
  };
}

export type BackGuard = ReturnType<typeof createBackGuard>;
