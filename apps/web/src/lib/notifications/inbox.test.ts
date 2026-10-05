import { describe, expect, it } from "vitest";
import { inboxRows, inboxUnread } from "./inbox";

const at = "2026-10-05T10:00:00Z";

describe("inbox rows", () => {
  it("maps severity to tone, keeps category and read state, follows in-app links only", () => {
    const rows = inboxRows([
      { id: "a", category: "stock", severity: "critical", title: "Out of stock: Achar", body: "No units", href: "/dashboard/products?stock=abc", read: false, createdAt: at },
      { id: "b", category: "courier", severity: "warning", title: "Order X returned", body: null, href: "/dashboard/orders?focus=x", read: true, createdAt: at },
      { id: "c", category: "order", severity: "info", title: "New order X", body: "৳500", href: "https://evil.example/x", read: false, createdAt: at },
      { id: "d", category: "something-new", severity: "info", title: "?", body: null, href: null, read: false, createdAt: at },
    ]);
    expect(rows.map((r) => [r.noticeId, r.category, r.tone, r.read, r.href ?? null])).toEqual([
      ["a", "stock", "danger", false, "/dashboard/products?stock=abc"],
      ["b", "courier", "warning", true, "/dashboard/orders?focus=x"],
      ["c", "order", "info", false, null],
      ["d", "account", "info", false, null],
    ]);
    expect(rows[1]).not.toHaveProperty("body");
  });

  it("unread comes from the inbox query's first page", () => {
    expect(inboxUnread(undefined)).toBe(0);
    expect(inboxUnread({ pages: [{ unread: 7 }, { unread: 7 }] })).toBe(7);
  });
});
