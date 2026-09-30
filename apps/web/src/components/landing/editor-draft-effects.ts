/**
 * What each landing-editor action does to the draft — the rule that decides
 * whether unsaved edits survive it (audit F-03).
 *
 * "keeps-draft"    — the server changes page metadata only (name, status,
 *                    subdomain). Local edits stay; the editor just re-reads
 *                    the metadata. No prompt: nothing is lost.
 * "replaces-draft" — the server draft changes (or the merchant asked to
 *                    reload it). Local edits would be overwritten, so a dirty
 *                    editor asks first (unsaved-changes guard) and the editor
 *                    then adopts the server draft.
 *
 * Verified against apps/api/src/lib/landing/pages.ts: renamePage,
 * unpublishPage and claimSlug never touch `draftContent` / `draftRevision`.
 */
export const EDITOR_ACTION_DRAFT_EFFECT = {
  rename: "keeps-draft",
  unpublish: "keeps-draft",
  setSlug: "keeps-draft",
  restoreRevision: "replaces-draft",
  upgradeTemplate: "replaces-draft",
  setLocales: "replaces-draft",
  conflictReload: "replaces-draft",
  // Publishing saves the draft first, so there is nothing unsaved left.
  publish: "replaces-draft",
} as const;

export type EditorAction = keyof typeof EDITOR_ACTION_DRAFT_EFFECT;

/** Must a dirty editor confirm before this action runs? */
export function actionNeedsDiscardConfirmation(action: EditorAction, dirty: boolean): boolean {
  return dirty && EDITOR_ACTION_DRAFT_EFFECT[action] === "replaces-draft";
}

/** After the action succeeded: throw local edits away and adopt the server draft? */
export function actionDiscardsLocalEdits(action: EditorAction): boolean {
  return EDITOR_ACTION_DRAFT_EFFECT[action] === "replaces-draft";
}

/**
 * Should a fresh server copy replace the editor's local content? Only when
 * there is nothing unsaved — this is what keeps edits alive across
 * metadata-only reloads.
 */
export function shouldAdoptServerDraft(input: { hasServerData: boolean; dirty: boolean }): boolean {
  return input.hasServerData && !input.dirty;
}
