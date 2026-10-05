import { describe, expect, it } from "vitest";
import { healthTone, shipmentsLine, updatesLine, type CourierHealthLike } from "./health-view";

const ok: CourierHealthLike = {
  enabled: true,
  connection: { lastValidatedAt: "2026-10-01T00:00:00Z", validationError: null },
  webhook: { secretConfigured: true, lastReceivedAt: "2026-10-02T00:00:00Z", failedLast7d: 0 },
  shipments: { active: 4, syncErrors: 0, deliveryIssues: 0, stale: 0 },
  bookings: { failedLast7d: 0, orphaned: 0 },
};

describe("courier health wording", () => {
  it("rates the courier: credentials or orphaned AWBs are bad, anything needing a look is a warning", () => {
    expect(healthTone(ok)).toBe("ok");
    expect(healthTone({ ...ok, connection: { ...ok.connection, validationError: "invalid key" } })).toBe("bad");
    expect(healthTone({ ...ok, bookings: { failedLast7d: 0, orphaned: 1 } })).toBe("bad");
    expect(healthTone({ ...ok, shipments: { ...ok.shipments, deliveryIssues: 1 } })).toBe("warn");
    expect(healthTone({ ...ok, bookings: { failedLast7d: 2, orphaned: 0 } })).toBe("warn");
    expect(healthTone({ ...ok, webhook: { ...ok.webhook, secretConfigured: false } })).toBe("warn");
  });

  it("summarizes shipments", () => {
    expect(shipmentsLine(ok.shipments)).toBe("4 active shipments");
    expect(shipmentsLine({ active: 1, syncErrors: 1, deliveryIssues: 0, stale: 0 })).toBe("1 active shipment · 1 needs attention");
    expect(shipmentsLine({ active: 5, syncErrors: 1, deliveryIssues: 1, stale: 1 })).toBe("5 active shipments · 3 need attention");
  });

  it("says how updates arrive, from what was received", () => {
    const rel = () => "2 hours ago";
    expect(updatesLine(ok, rel)).toBe("Last courier update received 2 hours ago");
    expect(updatesLine({ ...ok, webhook: { ...ok.webhook, lastReceivedAt: null } }, rel)).toMatch(/polling/);
    expect(updatesLine({ ...ok, webhook: { ...ok.webhook, secretConfigured: false } }, rel)).toMatch(/secret not set/);
  });
});
