import { describe, expect, it } from "vitest";
import { flattenQueuePages, nextQueueCursor, type QueuePage } from "./review-queue";

const page = (ids: string[], total: number, nextCursor: string | null): QueuePage<{ id: string }> => ({
  items: ids.map((id) => ({ id })),
  total,
  nextCursor,
  hasMore: nextCursor !== null,
});

describe("verification queue paging (audit OV-2)", () => {
  it("no pages yet → empty", () => {
    expect(flattenQueuePages(undefined)).toEqual({ items: [], total: 0 });
  });

  it("concatenates pages in order", () => {
    const r = flattenQueuePages([page(["a", "b"], 5, "c1"), page(["c", "d"], 5, "c2"), page(["e"], 5, null)]);
    expect(r.items.map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.total).toBe(5);
  });

  it("drops a row that shows up in two pages (keeps the first), so React keys stay unique", () => {
    const r = flattenQueuePages([page(["a", "b"], 4, "c1"), page(["b", "c"], 4, null)]);
    expect(r.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("uses the newest page's total", () => {
    expect(flattenQueuePages([page(["a"], 10, "x"), page(["b"], 9, null)]).total).toBe(9);
  });

  it("next cursor only while the server says there's more", () => {
    expect(nextQueueCursor(page(["a"], 3, "cur"))).toBe("cur");
    expect(nextQueueCursor(page(["a"], 1, null))).toBeUndefined();
    expect(nextQueueCursor({ items: [], total: 0, nextCursor: "stale", hasMore: false })).toBeUndefined();
  });
});
