import { describe, expect, it, vi } from "vitest";
import {
  type ClickLike,
  type HistoryLike,
  createBackGuard,
  createUnsavedChangesController,
  guardedNavigationTarget,
} from "./guard";

const CURRENT = "https://app.confirmx.ai/dashboard/landing-pages/abc";
const click = (over: Partial<ClickLike> = {}): ClickLike => ({
  button: 0,
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});
const link = (href: string, over: Partial<{ target: string | null; download: boolean; ignore: boolean }> = {}) => ({
  href,
  target: null,
  download: false,
  ignore: false,
  ...over,
});

describe("unsaved-changes controller (audit F-04)", () => {
  it("1. clean editor: navigation proceeds, no prompt", () => {
    const g = createUnsavedChangesController();
    const run = vi.fn();
    expect(g.attempt({ kind: "navigate", run })).toBe("proceeded");
    expect(run).toHaveBeenCalledTimes(1);
    expect(g.getSnapshot().pending).toBeNull();
  });

  it("2. dirty editor: navigation is held and the prompt opens", () => {
    const g = createUnsavedChangesController();
    g.setDirty(true);
    const run = vi.fn();
    expect(g.attempt({ kind: "navigate", run })).toBe("prompted");
    expect(run).not.toHaveBeenCalled();
    expect(g.getSnapshot().pending?.kind).toBe("navigate");
  });

  it("3. Keep editing: stays on the editor with the edits", () => {
    const g = createUnsavedChangesController();
    g.setDirty(true);
    const run = vi.fn();
    g.attempt({ kind: "navigate", run });
    g.keepEditing();
    expect(run).not.toHaveBeenCalled();
    expect(g.getSnapshot()).toMatchObject({ pending: null, dirty: true });
  });

  it("4. Leave without saving: the navigation proceeds exactly once", () => {
    const g = createUnsavedChangesController();
    g.setDirty(true);
    const run = vi.fn();
    g.attempt({ kind: "navigate", run });
    g.discardAndContinue();
    g.discardAndContinue(); // double click on the button
    expect(run).toHaveBeenCalledTimes(1);
    expect(g.getSnapshot().pending).toBeNull();
  });

  it("5. Save and continue: runs only after a successful save; a failed save keeps the prompt and edits", async () => {
    const g = createUnsavedChangesController();
    g.setDirty(true);
    const run = vi.fn();
    g.attempt({ kind: "navigate", run });

    const failing = vi.fn(async () => false);
    expect(await g.saveAndContinue(failing)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(g.getSnapshot().pending).not.toBeNull();

    const saving = vi.fn(async () => {
      // The editor clears its dirty flag when the draft is saved.
      g.setDirty(false);
      return true;
    });
    expect(await g.saveAndContinue(saving)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(g.getSnapshot()).toMatchObject({ pending: null, saving: false, dirty: false });
    // Clean again: the next navigation goes straight through.
    const next = vi.fn();
    expect(g.attempt({ kind: "navigate", run: next })).toBe("proceeded");
    expect(next).toHaveBeenCalled();
  });

  it("5b. a save that throws is treated as failed", async () => {
    const g = createUnsavedChangesController();
    g.setDirty(true);
    const run = vi.fn();
    g.attempt({ kind: "action", run });
    expect(await g.saveAndContinue(async () => Promise.reject(new Error("CONFLICT")))).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(g.getSnapshot().saving).toBe(false);
  });

  it("10. duplicate navigation events while the prompt is open do not stack prompts", () => {
    const g = createUnsavedChangesController();
    g.setDirty(true);
    const first = vi.fn();
    const second = vi.fn();
    expect(g.attempt({ kind: "navigate", run: first })).toBe("prompted");
    expect(g.attempt({ kind: "navigate", run: second })).toBe("ignored");
    g.discardAndContinue();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("ignores Keep/Leave while a save is in flight", async () => {
    const g = createUnsavedChangesController();
    g.setDirty(true);
    const run = vi.fn();
    g.attempt({ kind: "navigate", run });
    let finish: (v: boolean) => void = () => {};
    const p = g.saveAndContinue(() => new Promise<boolean>((r) => (finish = r)));
    g.keepEditing();
    g.discardAndContinue();
    expect(run).not.toHaveBeenCalled();
    expect(g.attempt({ kind: "navigate", run: vi.fn() })).toBe("ignored");
    finish(true);
    await p;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers only on real changes", () => {
    const g = createUnsavedChangesController();
    const l = vi.fn();
    g.subscribe(l);
    g.setDirty(false); // unchanged
    g.setDirty(true);
    g.setDirty(true); // unchanged
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe("which clicks are guarded navigations", () => {
  it("in-app links (sidebar, bottom nav, back arrow) are guarded", () => {
    expect(guardedNavigationTarget(click(), link("/dashboard/orders"), CURRENT)).toBe("/dashboard/orders");
    expect(guardedNavigationTarget(click(), link("https://app.confirmx.ai/dashboard/landing-pages"), CURRENT)).toBe(
      "/dashboard/landing-pages",
    );
    expect(guardedNavigationTarget(click(), link("/dashboard/orders?focus=1#x"), CURRENT)).toBe("/dashboard/orders?focus=1#x");
  });

  it("8. non-link UI (language tabs, section toggles, buttons) and in-page anchors are never guarded", () => {
    // Buttons / <summary> / tabs are not anchors.
    expect(guardedNavigationTarget(click(), null, CURRENT)).toBeNull();
    // Same page, only the hash changes (e.g. #tracking).
    expect(guardedNavigationTarget(click(), link("#tracking"), CURRENT)).toBeNull();
    expect(guardedNavigationTarget(click(), link(CURRENT), CURRENT)).toBeNull();
    // Opt-out marker.
    expect(guardedNavigationTarget(click(), link("/dashboard", { ignore: true }), CURRENT)).toBeNull();
  });

  it("9. keyboard activation (Enter on a focused link = a plain primary click) is guarded; new-tab gestures are not", () => {
    expect(guardedNavigationTarget(click(), link("/dashboard"), CURRENT)).toBe("/dashboard");
    for (const mod of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(guardedNavigationTarget(click({ [mod]: true }), link("/dashboard"), CURRENT)).toBeNull();
    }
    expect(guardedNavigationTarget(click({ button: 1 }), link("/dashboard"), CURRENT)).toBeNull();
  });

  it("new tabs, downloads, external sites, non-http and already-handled clicks are left to the browser", () => {
    expect(guardedNavigationTarget(click(), link("/preview/landing/abc", { target: "_blank" }), CURRENT)).toBeNull();
    expect(guardedNavigationTarget(click(), link("/export.csv", { download: true }), CURRENT)).toBeNull();
    expect(guardedNavigationTarget(click(), link("https://mytest.confirmx.ai/"), CURRENT)).toBeNull();
    expect(guardedNavigationTarget(click(), link("mailto:support@confirmx.ai"), CURRENT)).toBeNull();
    expect(guardedNavigationTarget(click({ defaultPrevented: true }), link("/dashboard"), CURRENT)).toBeNull();
    expect(guardedNavigationTarget(click(), link("/dashboard", { target: "_self" }), CURRENT)).toBe("/dashboard");
  });
});

/** Minimal browser history: a stack + index, popstate delivered via a callback. */
function fakeHistory(previous: string, current: string) {
  const entries: Array<{ url: string; state: unknown }> = [
    { url: previous, state: { __NA: true } },
    { url: current, state: { __NA: true, tree: 1 } },
  ];
  let index = 1;
  let onPop: () => void = () => {};
  const history: HistoryLike & { entries: typeof entries; index: () => number; setOnPop: (f: () => void) => void } = {
    get state() {
      return entries[index]!.state;
    },
    pushState(state, _u, url) {
      entries.splice(index + 1);
      entries.push({ url: url ?? entries[index]!.url, state });
      index = entries.length - 1;
    },
    back() {
      if (index > 0) {
        index -= 1;
        onPop();
      }
    },
    entries,
    index: () => index,
    setOnPop: (f) => (onPop = f),
  };
  return history;
}

describe("browser Back while dirty", () => {
  function setup() {
    // Came to the editor from the landing-pages list.
    const h = fakeHistory("/dashboard/landing-pages", "/dashboard/landing-pages/abc");
    const onBack = vi.fn();
    const g = createBackGuard({ history: h, currentUrl: () => "/dashboard/landing-pages/abc", onBack });
    h.setOnPop(() => g.handlePopState());
    return { h, g, onBack };
  }

  it("arming adds one duplicate entry with the same router state (idempotent)", () => {
    const { h, g } = setup();
    const before = h.entries.length;
    g.arm();
    g.arm();
    expect(h.entries.length).toBe(before + 1);
    expect(h.entries.at(-1)).toMatchObject({ url: "/dashboard/landing-pages/abc", state: { __NA: true, tree: 1 } });
  });

  it("Back pops only the duplicate (page stays) and asks; Keep editing re-arms", () => {
    const { h, g, onBack } = setup();
    g.arm();
    h.back();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(g.isArmed()).toBe(false);
    expect(h.entries[h.index()]!.url).toBe("/dashboard/landing-pages/abc");
    g.arm(); // Keep editing
    expect(g.isArmed()).toBe(true);
  });

  it("Leave continues the Back to the previous page without asking again", () => {
    const { h, g, onBack } = setup();
    g.arm();
    h.back(); // asks
    g.leaveBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(h.entries[h.index()]!.url).toBe("/dashboard/landing-pages");
  });

  it("disarm removes the duplicate before continuing (clean again, or leaving via a link)", () => {
    const { h, g, onBack } = setup();
    const start = h.index();
    g.arm();
    const then = vi.fn();
    g.disarm(then);
    expect(h.index()).toBe(start);
    expect(then).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    // Not armed → runs straight away, no history change.
    const again = vi.fn();
    g.disarm(again);
    expect(again).toHaveBeenCalledTimes(1);
    expect(h.index()).toBe(start);
  });

  it("popstate while not armed is ignored", () => {
    const { g, onBack } = setup();
    g.handlePopState();
    expect(onBack).not.toHaveBeenCalled();
  });
});
