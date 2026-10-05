import { describe, expect, it } from "vitest";
import { TRAFFIC_LABEL, formatRate, warningText } from "./labels";

describe("marketing labels", () => {
  it("names every traffic type the API reports", () => {
    for (const t of ["paid", "organic", "direct", "other", "untracked"]) expect(TRAFFIC_LABEL[t]?.label).toBeTruthy();
  });

  it("explains missing data in one sentence, without inventing numbers", () => {
    expect(warningText({ code: "paid_without_spend", channel: "meta", count: 3 })).toBe(
      "Meta (Facebook / Instagram) brought 3 orders but no Meta (Facebook / Instagram) ad spend is entered for this period — cost per order, ROAS and profit for it can't be shown.",
    );
    expect(warningText({ code: "cost_missing", count: 1 })).toMatch(/^Product cost is not recorded for 1 delivered order —/);
    expect(warningText({ code: "courier_fee_missing", count: 2 })).toMatch(/2 shipped orders/);
    expect(warningText({ code: "spend_without_orders", channel: "tiktok" })).toMatch(/TikTok ad spend is entered but no orders/);
    expect(warningText({ code: "untracked_share", count: 5 })).toMatch(/^5 orders in this period/);
  });

  it("formats rates and shows a dash when there is nothing to divide", () => {
    expect(formatRate(12.5)).toBe("12.5%");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(null)).toBe("—");
  });
});
