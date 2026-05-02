import { describe, expect, it } from "vitest";
import {
  formatBdt,
  formatRelativeTime,
  safeHexColor,
  safeHttpsUrl,
  statusPresentation,
} from "./status";

describe("statusPresentation", () => {
  it("maps canonical order statuses to the right step + tone", () => {
    expect(statusPresentation("pending").step).toBe(0);
    expect(statusPresentation("packed").step).toBe(1);
    expect(statusPresentation("shipped").step).toBe(2);
    expect(statusPresentation("in_transit").step).toBe(2);
    expect(statusPresentation("out_for_delivery").step).toBe(3);
    expect(statusPresentation("delivered").step).toBe(4);
  });

  it("normalizes courier-side variants (case/dashes/spaces)", () => {
    expect(statusPresentation("Out for Delivery").label).toBe("Out for delivery");
    expect(statusPresentation("OUT-FOR-DELIVERY").step).toBe(3);
    expect(statusPresentation("Returned").label).toBe("Returned");
  });

  it("falls back to Unknown for unfamiliar inputs", () => {
    expect(statusPresentation("some-courier-quirk").label).toBe("Unknown");
    expect(statusPresentation(undefined).label).toBe("Unknown");
  });

  it("buckets status into a tone band", () => {
    expect(statusPresentation("delivered").tone).toBe("good");
    expect(statusPresentation("out_for_delivery").tone).toBe("progress");
    expect(statusPresentation("shipped").tone).toBe("progress");
    expect(statusPresentation("rto").tone).toBe("warn");
  });
});

describe("safeHexColor", () => {
  it("accepts only 7-char hex", () => {
    expect(safeHexColor("#0F766E")).toBe("#0f766e");
    expect(safeHexColor("#000000")).toBe("#000000");
    expect(safeHexColor("#0F76")).toBeNull();
    expect(safeHexColor("javascript:alert(1)")).toBeNull();
    expect(safeHexColor("rgb(0,0,0)")).toBeNull();
    expect(safeHexColor("")).toBeNull();
    expect(safeHexColor(undefined)).toBeNull();
  });
});

describe("safeHttpsUrl", () => {
  it("accepts http and https only", () => {
    expect(safeHttpsUrl("https://cdn.example.com/x.png")).toBe("https://cdn.example.com/x.png");
    expect(safeHttpsUrl("http://example.com")).toBe("http://example.com");
  });
  it("rejects non-http schemes", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("data:image/png;base64,xyz")).toBeNull();
    expect(safeHttpsUrl("//example.com")).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
  });
  it("rejects URLs with embedded whitespace or angle brackets", () => {
    expect(safeHttpsUrl("https://example.com/a b")).toBeNull();
    expect(safeHttpsUrl("https://example.com/<x>")).toBeNull();
  });
});

describe("formatBdt", () => {
  it("renders BDT with no decimals", () => {
    const out = formatBdt(1500);
    expect(out).toContain("1,500");
    expect(out.length).toBeGreaterThan(0);
  });
  it("handles non-finite gracefully", () => {
    expect(formatBdt(Number.NaN)).toBe("—");
    expect(formatBdt(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  it("returns just now / minutes / hours / days", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 30_000).toISOString())).toBe("just now");
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(formatRelativeTime(new Date(now - 2 * 60 * 60_000).toISOString())).toBe("2h ago");
    expect(formatRelativeTime(new Date(now - 3 * 24 * 60 * 60_000).toISOString())).toBe("3d ago");
  });
  it("returns empty for invalid inputs", () => {
    expect(formatRelativeTime("garbage")).toBe("");
  });
});
