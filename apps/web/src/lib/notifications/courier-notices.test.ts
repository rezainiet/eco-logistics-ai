import { describe, expect, it } from "vitest";
import { courierNoticeRows } from "./courier-notices";

describe("courier notices", () => {
  it("maps inbox rows to drawer rows, critical as danger, in-app links only", () => {
    const rows = courierNoticeRows([
      { id: "a", severity: "warning", title: "Delivery problem on order CXE-1", body: 'Pathao reports "Delivery_Failed".', link: "/dashboard/orders?focus=abc", createdAt: "2026-10-02T04:00:00Z" },
      { id: "b", severity: "critical", title: "Cancel at courier", body: null, link: "https://evil.example/x", createdAt: "2026-10-02T05:00:00Z" },
    ]);
    expect(rows[0]).toEqual({
      id: "notice:a",
      noticeId: "a",
      tone: "warning",
      title: "Delivery problem on order CXE-1",
      body: 'Pathao reports "Delivery_Failed".',
      href: "/dashboard/orders?focus=abc",
      timestamp: "2026-10-02T04:00:00Z",
    });
    expect(rows[1]).toMatchObject({ tone: "danger" });
    expect(rows[1]).not.toHaveProperty("href");
    expect(rows[1]).not.toHaveProperty("body");
  });
});
