import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuotaHoldBanner } from "@/components/integrations/quota-hold-banner";
import { explainError } from "@/components/integrations/smart-error";
import { canReplayIssue, isQuotaHeld, ORDER_QUOTA_REASON, quotaHoldBanner, UPGRADE_HREF } from "./quota-hold";

/**
 * Orders held because the monthly order quota is used up read as "received
 * and held", never as a failed webhook; the next step is upgrade (no room
 * yet) or replay (room again).
 */

const full = { used: 300, limit: 300, available: false, planName: "Starter" };
const room = { used: 12, limit: 1500, available: true, planName: "Growth" };
const held = { skipReason: ORDER_QUOTA_REASON };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const banner = (n: number, quota: typeof full | typeof room | null) =>
  renderToStaticMarkup(<QuotaHoldBanner heldCount={n} quota={quota} onReplay={() => {}} replaying={false} />);

describe("quota-held order explanation", () => {
  it("says the order was received and held because of the quota — not a webhook / provider failure", () => {
    const e = explainError({ skipReason: ORDER_QUOTA_REASON, lastError: "order_quota_exceeded: monthly order quota reached (300/300)" });
    expect(e.code).toBe("order_quota_exceeded");
    expect(e.what).toBe("Order received and held — your monthly order quota is used up.");
    expect(e.why).toContain("Nothing is lost");
    expect(e.how).toContain("Upgrade your plan or wait for the monthly reset, then click Replay");
    expect(`${e.what} ${e.why} ${e.how}`).not.toMatch(/webhook|failed|couldn't reach|rejected/i);
    // Also recognised from the stored error alone.
    expect(explainError({ lastError: "order_quota_exceeded: monthly order quota reached (300/300)" }).code).toBe("order_quota_exceeded");
    // Other reasons are unaffected.
    expect(explainError({ skipReason: "missing_phone" }).code).toBe("missing_phone");
    expect(explainError({ lastError: "connection error ECONNREFUSED" }).code).toBe("connection_error");
  });
});

describe("replay only when it can work", () => {
  it("a quota-held order is replayable once there is room; other issues always are", () => {
    expect(isQuotaHeld(held)).toBe(true);
    expect(canReplayIssue(held, full)).toBe(false);
    expect(canReplayIssue(held, null)).toBe(false);
    expect(canReplayIssue(held, room)).toBe(true);
    expect(canReplayIssue({ skipReason: "missing_phone" }, full)).toBe(true);
    expect(canReplayIssue({ skipReason: null }, full)).toBe(true);
  });
});

describe("held-orders banner", () => {
  it("nothing held → no banner", () => {
    expect(quotaHoldBanner(0, full)).toBeNull();
    expect(banner(0, full)).toBe("");
  });

  it("quota still used up → what happened, nothing lost, Upgrade CTA, no replay button", () => {
    const t = text(banner(3, full));
    expect(t).toContain("3 orders are held — monthly order quota reached");
    expect(t).toContain("Your Starter plan has used 300 / 300 orders this month");
    expect(t).toContain("nothing is lost");
    expect(t).toContain("Upgrade plan");
    expect(banner(3, full)).toContain(`href="${UPGRADE_HREF}"`);
    expect(t).not.toContain("Replay held orders");
    expect(t).not.toMatch(/webhook failed/i);
  });

  it("room again → replay CTA, no upgrade push", () => {
    const t = text(banner(1, room));
    expect(t).toContain("1 order is held — you have order capacity again");
    expect(t).toContain("Replay held orders");
    expect(t).not.toContain("Upgrade plan");
  });
});
