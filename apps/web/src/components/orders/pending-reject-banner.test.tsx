import { type ReactElement, isValidElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findElements } from "@/test-utils/element-tree";
import { PendingRejectBannerView, rejectOutcomeMessage } from "./pending-reject-banner";

const text = (n: unknown): string =>
  Array.isArray(n) ? n.map(text).join("") : typeof n === "string" || typeof n === "number" ? String(n) : isValidElement(n) ? text((n.props as { children?: unknown }).children) : "";

describe("PendingRejectBannerView (audit F-06)", () => {
  it("renders nothing when idle", () => {
    expect(PendingRejectBannerView({ state: { phase: "idle", ids: [], deadline: null }, secondsLeft: 0, onUndo: vi.fn() })).toBeNull();
  });

  it("pending: countdown, says it survives navigation, and offers Undo", () => {
    const onUndo = vi.fn();
    const tree = PendingRejectBannerView({ state: { phase: "pending", ids: ["a", "b", "c"], deadline: 1 }, secondsLeft: 4, onUndo }) as ReactElement;
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Rejecting 3 orders");
    expect(html).toContain("in 4s");
    expect(html).toContain("continues if you leave the page");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    const undo = findElements(tree, (el) => typeof el.props.onClick === "function" && text(el.props.children).includes("Undo"));
    expect(undo).toHaveLength(1);
    (undo[0]!.props.onClick as () => void)();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("committing: no Undo is offered once it's too late", () => {
    const tree = PendingRejectBannerView({ state: { phase: "committing", ids: ["a"], deadline: null }, secondsLeft: 0, onUndo: vi.fn() }) as ReactElement;
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Rejecting 1 order…");
    expect(html).toContain("Too late to undo");
    expect(findElements(tree, (el) => typeof el.props.onClick === "function")).toHaveLength(0);
  });

  it("is docked, not self-positioned: the view is only the card; the banner renders into the bottom dock", () => {
    const html = renderToStaticMarkup(
      PendingRejectBannerView({ state: { phase: "pending", ids: ["a"], deadline: 1 }, secondsLeft: 6, onUndo: vi.fn() }) as ReactElement,
    );
    // Position comes from the dock (fixed above the nav, reserved by pb-page-end),
    // so the card can never overlap another bottom bar or the nav.
    expect(html).not.toMatch(/\b(fixed|sticky)\b/);
    expect(html).not.toMatch(/\bbottom-/);
    const src = readFileSync(fileURLToPath(new URL("./pending-reject-banner.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/<BottomDockPortal>\s*<PendingRejectBannerView/);
  });
});

describe("rejectOutcomeMessage", () => {
  it("summarises a finished reject", () => {
    expect(
      rejectOutcomeMessage({ kind: "done", ids: ["a", "b"], result: { rejected: ["a"], alreadyRejected: ["b"], tooLate: [], notFound: [] } }),
    ).toEqual({ tone: "success", title: "1 rejected · 1 already rejected" });
  });
  it("confirms an undo", () => {
    expect(rejectOutcomeMessage({ kind: "undone", ids: ["a"] }).title).toMatch(/cancelled/);
  });
  it("reports a failure as an error", () => {
    expect(rejectOutcomeMessage({ kind: "failed", ids: ["a"], error: new Error("x") }).tone).toBe("error");
  });
});
