import { type ReactElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { findElements } from "@/test-utils/element-tree";
import { UnsavedChangesDialog } from "./unsaved-changes-dialog";
import type { UnsavedChangesDialogState } from "@/lib/unsaved-changes/use-unsaved-changes-guard";

function state(over: Partial<UnsavedChangesDialogState> = {}): UnsavedChangesDialogState {
  return {
    open: true,
    kind: "navigate",
    saving: false,
    onKeepEditing: vi.fn(),
    onDiscard: vi.fn(),
    restoreFocus: vi.fn(),
    ...over,
  };
}

const text = (el: ReactElement<Record<string, unknown>>): string => {
  const c = el.props.children;
  const flat = (n: unknown): string =>
    Array.isArray(n) ? n.map(flat).join("") : typeof n === "string" ? n : isValidElement(n) ? flat((n.props as { children?: unknown }).children) : "";
  return flat(c).trim();
};
const buttons = (tree: ReactElement) =>
  findElements(tree, (el) => typeof el.props.onClick === "function" && typeof el.props.type === "string");
const byText = (tree: ReactElement, t: string) => buttons(tree).find((b) => text(b) === t);

describe("UnsavedChangesDialog", () => {
  it("offers Keep editing / Leave without saving for navigation, and Keep editing gets focus first", () => {
    const s = state();
    const tree = UnsavedChangesDialog(s) as ReactElement;
    const labels = buttons(tree).map(text);
    expect(labels).toEqual(["Keep editing", "Leave without saving"]);
    expect(byText(tree, "Keep editing")!.props.autoFocus).toBe(true);
    (byText(tree, "Leave without saving")!.props.onClick as () => void)();
    expect(s.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("offers Save draft and leave only when the editor can save", () => {
    const onSave = vi.fn();
    const tree = UnsavedChangesDialog(state({ onSave })) as ReactElement;
    (byText(tree, "Save draft and leave")!.props.onClick as () => void)();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("uses action wording and the action's own description", () => {
    const tree = UnsavedChangesDialog(
      state({ kind: "action", description: "Restoring a revision replaces your draft.", onSave: vi.fn() }),
    ) as ReactElement;
    expect(buttons(tree).map(text)).toEqual(["Keep editing", "Discard changes", "Save draft and continue"]);
    const desc = findElements(tree, (el) => text(el) === "Restoring a revision replaces your draft.");
    expect(desc.length).toBeGreaterThan(0);
  });

  it("Escape / close / outside click all mean Keep editing (keyboard-safe default)", () => {
    const s = state();
    const tree = UnsavedChangesDialog(s) as ReactElement<{ onOpenChange: (o: boolean) => void }>;
    tree.props.onOpenChange(false);
    expect(s.onKeepEditing).toHaveBeenCalledTimes(1);
    expect(s.onDiscard).not.toHaveBeenCalled();
  });

  it("returns focus to the control that opened the prompt instead of <body>", () => {
    const s = state();
    const tree = UnsavedChangesDialog(s) as ReactElement;
    const content = findElements(tree, (el) => typeof el.props.onCloseAutoFocus === "function")[0]!;
    const event = { preventDefault: vi.fn() };
    (content.props.onCloseAutoFocus as (e: typeof event) => void)(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(s.restoreFocus).toHaveBeenCalledTimes(1);
  });

  it("disables every choice while saving", () => {
    const tree = UnsavedChangesDialog(state({ saving: true, onSave: vi.fn() })) as ReactElement;
    expect(buttons(tree).every((b) => b.props.disabled === true)).toBe(true);
  });
});
