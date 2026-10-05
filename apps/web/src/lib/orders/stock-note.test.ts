import { describe, expect, it } from "vitest";
import { stockNoteCopy } from "./stock-note";

describe("stockNoteCopy", () => {
  it("no note, no copy", () => {
    expect(stockNoteCopy(null, "pending")).toBeNull();
    expect(stockNoteCopy("", "pending")).toBeNull();
  });

  it("an open order short of stock is waiting for a restock", () => {
    const c = stockNoteCopy("insufficient_stock:6ac308cf62600f6b9ad16255", "confirmed")!;
    expect(c.label).toBe("Waiting for stock");
    expect(c.detail).toMatch(/restock/i);
  });

  it("a delivered order whose units could not be deducted says so", () => {
    expect(stockNoteCopy("below_reserved:6ac308cf62600f6b9ad16255", "delivered")!.label).toBe("Stock not deducted");
  });

  it("a removed product is named as such, whatever the status", () => {
    expect(stockNoteCopy("product_not_found:6ac308cf62600f6b9ad16255", "pending")!.label).toBe("Stock not moved");
  });
});
