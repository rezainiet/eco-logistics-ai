import { describe, expect, it } from "vitest";
import {
  EDITOR_ACTION_DRAFT_EFFECT,
  actionDiscardsLocalEdits,
  actionNeedsDiscardConfirmation,
  shouldAdoptServerDraft,
} from "./editor-draft-effects";

/**
 * Audit F-03: Rename / Unpublish used to run the editor's refresh(), which
 * cleared the dirty flag and re-adopted the server draft — silently wiping
 * unsaved content edits. Neither action touches the draft on the server
 * (renamePage / unpublishPage only set name / status), so they must keep the
 * edits instead of asking the merchant to throw them away.
 */
describe("landing editor: which actions keep unsaved edits", () => {
  it("6. rename with unsaved edits keeps them — no prompt, no discard, no re-adopt", () => {
    expect(actionNeedsDiscardConfirmation("rename", true)).toBe(false);
    expect(actionDiscardsLocalEdits("rename")).toBe(false);
    // After the reload the editor is still dirty, so the server copy is not adopted.
    expect(shouldAdoptServerDraft({ hasServerData: true, dirty: true })).toBe(false);
  });

  it("7. unpublish with unsaved edits keeps them", () => {
    expect(actionNeedsDiscardConfirmation("unpublish", true)).toBe(false);
    expect(actionDiscardsLocalEdits("unpublish")).toBe(false);
  });

  it("changing the subdomain keeps edits too", () => {
    expect(actionDiscardsLocalEdits("setSlug")).toBe(false);
  });

  it("actions that replace the draft ask first when dirty and adopt the server draft afterwards", () => {
    for (const action of ["restoreRevision", "upgradeTemplate", "setLocales", "conflictReload"] as const) {
      expect(actionNeedsDiscardConfirmation(action, true)).toBe(true);
      expect(actionNeedsDiscardConfirmation(action, false)).toBe(false);
      expect(actionDiscardsLocalEdits(action)).toBe(true);
    }
  });

  it("a clean editor adopts fresh server data; with no data there is nothing to adopt", () => {
    expect(shouldAdoptServerDraft({ hasServerData: true, dirty: false })).toBe(true);
    expect(shouldAdoptServerDraft({ hasServerData: false, dirty: false })).toBe(false);
  });

  it("every editor action is classified", () => {
    for (const effect of Object.values(EDITOR_ACTION_DRAFT_EFFECT)) {
      expect(["keeps-draft", "replaces-draft"]).toContain(effect);
    }
  });
});
