import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyMeter, isMeterAlert, type UsageMeterLike } from "@/lib/billing/meters";
import { buildAccountAlerts } from "./account-alerts";

// Exactly what billing.getUsage returns for a Starter trial with no order
// verifications in the plan: limit 0, nothing used, flagged blocked.
const NOT_INCLUDED: UsageMeterLike = { metric: "fraudReviewsUsed", used: 0, limit: 0, ratio: 0, warning: false, blocked: true };
const FRESH: UsageMeterLike = { metric: "ordersCreated", used: 2, limit: 300, ratio: 2 / 300, warning: false, blocked: false };
const NEAR: UsageMeterLike = { metric: "ordersCreated", used: 250, limit: 300, ratio: 250 / 300, warning: true, blocked: false };
const HIT: UsageMeterLike = { metric: "callMinutesUsed", used: 60, limit: 60, ratio: 1, warning: true, blocked: true };
const UNLIMITED: UsageMeterLike = { metric: "callsInitiated", used: 9, limit: null, ratio: 0, warning: false, blocked: false };

describe("classifyMeter", () => {
  it("a zero-limit meter with nothing used is 'not_included', not blocked", () => {
    expect(classifyMeter(NOT_INCLUDED)).toBe("not_included");
    expect(isMeterAlert(NOT_INCLUDED)).toBe(false);
  });
  it("a zero-limit meter that has usage (e.g. after a downgrade) is genuinely blocked", () => {
    expect(classifyMeter({ ...NOT_INCLUDED, used: 3 })).toBe("blocked");
  });
  it("keeps real warnings and blocks", () => {
    expect(classifyMeter(NEAR)).toBe("warning");
    expect(classifyMeter(HIT)).toBe("blocked");
    expect(classifyMeter(FRESH)).toBe("ok");
    expect(classifyMeter(UNLIMITED)).toBe("ok");
  });
  it("ignores stale blocked/warning flags at zero usage on a non-zero limit", () => {
    expect(classifyMeter({ ...FRESH, used: 0, blocked: true, warning: true })).toBe("ok");
  });
});

describe("buildAccountAlerts", () => {
  it("regression: the live Starter-trial state yields no alerts (badge 0, drawer 'all caught up')", () => {
    const alerts = buildAccountAlerts({
      subscription: { status: "trial", trialExpired: false, trialDaysLeft: 14 },
      meters: [
        { metric: "ordersCreated", used: 2, limit: 300, ratio: 0.0067, warning: false, blocked: false },
        { metric: "shipmentsBooked", used: 0, limit: 300, ratio: 0, warning: false, blocked: false },
        NOT_INCLUDED,
        { metric: "callsInitiated", used: 0, limit: null, ratio: 0, warning: false, blocked: false },
        { metric: "callMinutesUsed", used: 0, limit: 60, ratio: 0, warning: false, blocked: false },
      ],
      reviewQueue: { pending: 0, noAnswer: 0 },
    });
    expect(alerts).toEqual([]);
  });

  it("keeps legitimate quota alerts — one per affected meter", () => {
    const alerts = buildAccountAlerts({ meters: [NOT_INCLUDED, NEAR, HIT, FRESH] });
    expect(alerts.map((a) => a.id)).toEqual(["usage:warn:ordersCreated", "usage:blocked:callMinutesUsed"]);
    expect(alerts[0]!.title).toBe("83% of orders this month quota used");
    expect(alerts[1]!.title).toBe("Quota exceeded: call minutes this month");
  });

  it("keeps billing and review-queue alerts", () => {
    const alerts = buildAccountAlerts({
      subscription: { status: "trial", trialDaysLeft: 1 },
      reviewQueue: { pending: 2, noAnswer: 1 },
    });
    expect(alerts.map((a) => a.kind)).toEqual(["trial_ending", "review_pending", "review_no_answer"]);
    expect(alerts[0]!.title).toBe("Trial ends in 1 day");
    expect(alerts[1]!.title).toBe("2 orders pending call review");

    const due = buildAccountAlerts({ subscription: { status: "past_due", trialExpired: true } });
    expect(due.map((a) => a.kind)).toEqual(["billing_past_due", "trial_expired"]);
  });

  it("an ended trial says 'Trial has ended' only — not also 'Trial ends in 0 days'", () => {
    const alerts = buildAccountAlerts({ subscription: { status: "trial", trialExpired: true, trialDaysLeft: 0 } });
    expect(alerts.map((a) => a.kind)).toEqual(["trial_expired"]);
  });

  it("is safe while data is still loading", () => {
    expect(buildAccountAlerts({})).toEqual([]);
    expect(buildAccountAlerts({ subscription: null, meters: null, reviewQueue: null })).toEqual([]);
  });

  it("gives every alert a unique id", () => {
    const alerts = buildAccountAlerts({
      subscription: { status: "past_due", trialExpired: true },
      meters: [NEAR, HIT, { ...HIT, metric: "shipmentsBooked" }],
      reviewQueue: { pending: 1, noAnswer: 1 },
    });
    expect(new Set(alerts.map((a) => a.id)).size).toBe(alerts.length);
  });
});

describe("bell count and drawer share one rule", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../components/shell/notifications-drawer.tsx", import.meta.url)),
    "utf8",
  );

  it("both the drawer rows and useNotificationCount come from buildAccountAlerts", () => {
    expect(src.match(/buildAccountAlerts\(/g)?.length).toBe(2);
    const hook = src.slice(src.indexOf("export function useNotificationCount"));
    expect(hook).toMatch(/buildAccountAlerts\([\s\S]*?\)\.length \+ inboxUnread\(inboxUnreadQuery\.data\)/);
  });

  it("unread inbox notifications are counted and listed from the same query", () => {
    // One hook (the inbox's "unread" view) feeds both sides: the bell counts
    // its server-side unread total, the drawer's Unread view lists its rows.
    expect(src.match(/= useInboxUnread\(\)/g)?.length).toBe(2);
    expect(src).toMatch(/filter: "unread", limit: PAGE/);
    expect(src).toMatch(/const inbox = view === "unread" \? inboxUnreadQuery : inboxAll;/);
    expect(src).toMatch(/inboxRows\(inbox\.data\?\.pages\.flatMap\(\(p\) => p\.items\) \?\? \[\]\)/);
  });

  it("neither side re-implements meter eligibility with raw blocked/warning flags", () => {
    expect(src).not.toMatch(/\.blocked\b/);
    expect(src).not.toMatch(/\.warning\b/);
  });
});
