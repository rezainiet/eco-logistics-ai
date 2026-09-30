import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogTitle } from "@/components/ui/dialog";
import { findElements } from "@/test-utils/element-tree";
import { PublishBlockersBody } from "./publish-blockers-dialog";
import type { PublishBlocker } from "./publish-blockers";

const b = (over: Partial<PublishBlocker>): PublishBlocker => ({
  key: "en.hero.headline",
  locale: "en",
  fieldPath: "hero.headline",
  sectionId: "hero",
  sectionLabel: "Promotional hero",
  fieldLabel: "Headline",
  message: "Headline is required",
  missing: true,
  ...over,
});
const ONE = [b({ key: "bn.order.cta", locale: "bn", fieldPath: "order.cta", sectionId: "order", sectionLabel: "Order call to action", fieldLabel: "Button", message: "Button needs somewhere to go (WhatsApp, phone, email or a link)" })];
const THREE = [
  b({}),
  b({ key: "en.offer.heading", fieldPath: "offer.heading", sectionId: "offer", sectionLabel: "Offer / flash sale", fieldLabel: "Heading", message: "Heading is required" }),
  ...ONE,
];

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}
const tree = (blockers: PublishBlocker[], handlers = { onJump: vi.fn(), onCancel: vi.fn() }) =>
  ({ tree: PublishBlockersBody({ blockers, multiLocale: true, ...handlers }), ...handlers });
const buttons = (t: ReactNode) => findElements(t, (el) => el.type === "button" || (typeof el.type !== "string" && "onClick" in el.props));

describe("PublishBlockersBody", () => {
  it("one missing field: the title states it and the exact field name is listed", () => {
    const { tree: t } = tree(ONE);
    const [title] = findElements(t, (el) => el.type === DialogTitle);
    expect(textOf(title)).toBe("1 required field is missing");
    expect(textOf(t)).toContain("Button");
    expect(textOf(t)).toContain("Order call to action · বাংলা — Button needs somewhere to go");
    expect(textOf(t)).not.toMatch(/order\.cta|required field is empty|Show what's missing/);
  });

  it("multiple missing fields: all names appear, in order", () => {
    const { tree: t } = tree(THREE);
    const [title] = findElements(t, (el) => el.type === DialogTitle);
    expect(textOf(title)).toBe("3 required fields are missing");
    const labels = findElements(t, (el) => typeof el.props["aria-label"] === "string" && String(el.props["aria-label"]).startsWith("Go to "));
    expect(labels.map((l) => l.props["aria-label"])).toEqual([
      "Go to Headline (Promotional hero · English)",
      "Go to Heading (Offer / flash sale · English)",
      "Go to Button (Order call to action · বাংলা)",
    ]);
  });

  it("each field name is a real button that jumps to that field", () => {
    const { tree: t, onJump } = tree(THREE);
    const entry = findElements(t, (el) => el.props["aria-label"] === "Go to Heading (Offer / flash sale · English)")[0]!;
    expect(entry.type).toBe("button");
    expect(entry.props.type).toBe("button");
    (entry.props.onClick as () => void)();
    expect(onJump).toHaveBeenCalledWith(THREE[1]);
  });

  it("'Fix missing fields' jumps to the first missing field", () => {
    const { tree: t, onJump } = tree(THREE);
    const fix = buttons(t).find((el) => textOf(el) === "Fix missing fields")!;
    expect(fix).toBeDefined();
    (fix.props.onClick as () => void)();
    expect(onJump).toHaveBeenCalledWith(THREE[0]);
  });

  it("Cancel just closes (validation marks stay in the editor)", () => {
    const { tree: t, onCancel, onJump } = tree(ONE);
    (buttons(t).find((el) => textOf(el) === "Cancel")!.props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalled();
    expect(onJump).not.toHaveBeenCalled();
  });

  it("an issue with no field is listed but not clickable; the primary action skips it", () => {
    const general = b({ key: "fr", locale: null, fieldPath: null, sectionId: null, sectionLabel: null, fieldLabel: 'Language "fr" is not enabled', message: 'Language "fr" is not enabled', missing: false });
    const { tree: t, onJump } = tree([general, ...ONE]);
    expect(findElements(t, (el) => el.props["aria-label"] === 'Go to Language "fr" is not enabled')).toHaveLength(0);
    (buttons(t).find((el) => /Fix/.test(textOf(el)))!.props.onClick as () => void)();
    expect(onJump).toHaveBeenCalledWith(ONE[0]);
  });

  it("renders as a list with an accessible name (markup)", () => {
    const html = renderToStaticMarkup(<ul>{(PublishBlockersBody({ blockers: THREE, multiLocale: false, onJump() {}, onCancel() {} }).props as { children: ReactNode[] }).children[1]}</ul>);
    expect(html).toContain('aria-label="Fields to fix"');
    expect(html.match(/<button type="button"/g)?.length).toBe(3);
  });
});
