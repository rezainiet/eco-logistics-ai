import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { byAriaLabel, findElements } from "@/test-utils/element-tree";
import { type ProductListItem, ProductsMobileList, productSubtitle } from "./products-mobile-list";

const LONG_NAME = "TEST Tee with variants (acceptance test) — an intentionally long product name";

const items: ProductListItem[] = [
  {
    id: "p_tee",
    name: LONG_NAME,
    hasVariants: true,
    variants: [{}, {}, {}, {}],
    options: [{ name: "Color" }, { name: "Size" }],
    price: 450,
    compareAtPrice: null,
    currency: "BDT",
    status: "active",
    stockStatus: "in_stock",
    available: 6,
    reserved: 0,
    onHand: 6,
  },
  {
    id: "p_mug",
    name: "TEST Simple Mug",
    sku: "TEST-MUG-01",
    hasVariants: false,
    variants: [],
    options: [],
    price: 300,
    compareAtPrice: 350,
    currency: "BDT",
    status: "draft",
    stockStatus: "low_stock",
    available: 4,
    reserved: 1,
    onHand: 5,
  },
];

function render(handlers = { onStock: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn() }) {
  return { html: renderToStaticMarkup(<ProductsMobileList items={items} {...handlers} />), handlers };
}

describe("ProductsMobileList (phones)", () => {
  it("shows price, compare-at price, stock, status and reservations for every product", () => {
    const { html } = render();
    expect(html).toContain("450");
    expect(html).toContain("300");
    expect(html).toContain("350"); // compare-at
    expect(html).toContain("In stock · 6");
    expect(html).toContain("Low stock · 4");
    expect(html).toContain("Active");
    expect(html).toContain("Draft");
    expect(html).toContain("1 of 5");
    for (const label of ["Price", "Stock", "Status", "Reserved"]) expect(html).toContain(`<dt class="text-fg-faint">${label}</dt>`);
  });

  it("shows the full product name (wraps, never truncated) and the variant/SKU line", () => {
    const { html } = render();
    expect(html).toContain(LONG_NAME);
    expect(html).not.toMatch(/class="[^"]*\btruncate\b/);
    expect(html).toContain("4 variants · Color × Size");
    expect(html).toContain("TEST-MUG-01");
  });

  it("renders labelled Stock / Edit / Archive buttons with visible text for each product", () => {
    const { html } = render();
    for (const name of [LONG_NAME, "TEST Simple Mug"]) {
      expect(html).toContain(`aria-label="Adjust stock of ${name}"`);
      expect(html).toContain(`aria-label="Edit ${name}"`);
      expect(html).toContain(`aria-label="Archive ${name}"`);
    }
    expect(html.match(/> Stock</g)?.length).toBe(2);
    expect(html.match(/> Edit</g)?.length).toBe(2);
  });

  it("wires each action to the right product", () => {
    const handlers = { onStock: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn() };
    const tree = ProductsMobileList({ items, ...handlers });
    (findElements(tree, byAriaLabel("Edit TEST Simple Mug"))[0]!.props.onClick as () => void)();
    (findElements(tree, byAriaLabel(`Adjust stock of ${LONG_NAME}`))[0]!.props.onClick as () => void)();
    (findElements(tree, byAriaLabel("Archive TEST Simple Mug"))[0]!.props.onClick as () => void)();
    expect(handlers.onEdit).toHaveBeenCalledWith("p_mug");
    expect(handlers.onStock).toHaveBeenCalledWith("p_tee");
    expect(handlers.onArchive).toHaveBeenCalledWith("p_mug");
  });

  it("is used below xl (phones, tablets, small laptops), hidden where the table shows", () => {
    const html = render().html;
    expect(html).toMatch(/^<ul class="[^"]*\bxl:hidden\b/);
    expect(html).toMatch(/^<ul class="[^"]*\bmd:grid-cols-2\b/);
  });

  it("productSubtitle keeps the table and the cards in sync", () => {
    expect(productSubtitle(items[0]!)).toBe("4 variants · Color × Size");
    expect(productSubtitle({ hasVariants: true, variants: [{}], options: [{ name: "Size" }], sku: null })).toBe("1 variant · Size");
    expect(productSubtitle({ hasVariants: false, variants: [], options: [], sku: null })).toBe("No SKU");
  });
});

describe("products list layout (source)", () => {
  const src = readFileSync(fileURLToPath(new URL("./products-list.tsx", import.meta.url)), "utf8");

  it("renders the card list and hides the table below xl (the table leaves no room for names beside the sidebar)", () => {
    expect(src).toContain("<ProductsMobileList");
    expect(src).toMatch(/className="hidden overflow-x-auto[^"]*xl:block"/);
  });

  it("never clips the table: no overflow-hidden wrapper, name column truncates instead", () => {
    expect(src).not.toMatch(/overflow-hidden rounded-xl border border-stroke\/10 bg-surface">\s*<table/);
    expect(src).toContain('className="w-full max-w-0 px-4 py-3"');
  });
});
