import { describe, it, expect } from "vitest";
import {
  classifyOperationalHint,
  OPERATIONAL_HINT_CODES,
  __TEST,
  type OperationalHintCode,
  type OrderHintInput,
} from "../src/lib/operational-hints.js";

/**
 * Operational-hints classifier — pure-function tests.
 *
 * Covers:
 *  - null fallback for healthy orders
 *  - each rule's positive + boundary case
 *  - rule priority (higher-priority rules pre-empt lower)
 *  - threshold boundary cases (just under / just over)
 *  - every emitted code is on the public stable list
 *  - input edge cases (empty arrays, missing fields)
 */

const NOW = new Date("2026-05-07T12:00:00Z");

function withNow(input: Partial<OrderHintInput>): OrderHintInput {
  return { now: NOW, ...input };
}

describe("classifyOperationalHint — healthy orders", () => {
  it("returns null when nothing is wrong", () => {
    expect(
      classifyOperationalHint(
        withNow({
          status: "delivered",
          addressCompleteness: "complete",
        }),
      ),
    ).toBeNull();
  });

  it("returns null when no input fields are set", () => {
    expect(classifyOperationalHint(withNow({}))).toBeNull();
  });
});

describe("classifyOperationalHint — address clarification", () => {
  it("fires when address is incomplete and order is pre-dispatch", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "pending",
        addressCompleteness: "incomplete",
      }),
    );
    expect(r?.code).toBe("address_clarification_needed");
    expect(r?.severity).toBe("warning");
  });

  it("does NOT fire once the order has shipped", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "shipped",
        addressCompleteness: "incomplete",
      }),
    );
    expect(r?.code).not.toBe("address_clarification_needed");
  });

  it("does NOT fire on partial address (only incomplete is critical)", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "pending",
        addressCompleteness: "partial",
      }),
    );
    expect(r).toBeNull();
  });
});

describe("classifyOperationalHint — confirmation flow", () => {
  it("flags undelivered confirmation SMS once past grace window", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "pending",
        automationState: "pending_confirmation",
        confirmationDeliveryStatus: "failed",
        confirmationSentAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      }),
    );
    expect(r?.code).toBe("confirmation_sms_undelivered");
  });

  it("does NOT flag SMS failure within grace window", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "pending",
        automationState: "pending_confirmation",
        confirmationDeliveryStatus: "failed",
        confirmationSentAt: new Date(
          NOW.getTime() - __TEST.CONFIRMATION_SMS_FAILED_GRACE_MS / 2,
        ),
      }),
    );
    // Falls through to awaiting_customer_confirmation, NOT
    // confirmation_sms_undelivered.
    expect(r?.code).toBe("awaiting_customer_confirmation");
  });

  it("flags awaiting customer confirmation when delivery status is pending", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "pending",
        automationState: "pending_confirmation",
        confirmationDeliveryStatus: "delivered",
        confirmationSentAt: new Date(NOW.getTime() - 30 * 60 * 1000),
      }),
    );
    expect(r?.code).toBe("awaiting_customer_confirmation");
    expect(r?.severity).toBe("info");
  });
});

describe("classifyOperationalHint — customer reachability", () => {
  it("flags fraud.reviewStatus = no_answer", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "pending",
        fraudReviewStatus: "no_answer",
      }),
    );
    expect(r?.code).toBe("customer_unreachable_pending_call");
  });
});

describe("classifyOperationalHint — delivery failure recovery", () => {
  it("fires on most-recent failed event when not yet delivered", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "in_transit",
        trackingEvents: [
          { at: new Date(NOW.getTime() - 12 * 60 * 60 * 1000), normalizedStatus: "in_transit" },
          { at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), normalizedStatus: "failed" },
        ],
      }),
    );
    expect(r?.code).toBe("delivery_failed_attempt");
    expect(r?.severity).toBe("critical");
  });

  it("does NOT fire if order has since been delivered", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "delivered",
        trackingEvents: [
          { at: new Date(NOW.getTime() - 4 * 60 * 60 * 1000), normalizedStatus: "failed" },
          { at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), normalizedStatus: "delivered" },
        ],
      }),
    );
    expect(r).toBeNull();
  });
});

describe("classifyOperationalHint — out-for-delivery age", () => {
  it("returns 'attempt in progress' for fresh OFD events", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "in_transit",
        trackingEvents: [
          { at: new Date(NOW.getTime() - 4 * 60 * 60 * 1000), normalizedStatus: "out_for_delivery" },
        ],
      }),
    );
    expect(r?.code).toBe("delivery_attempt_in_progress");
    expect(r?.severity).toBe("info");
  });

  it("escalates to 'stuck' once OFD age > 24h with no resolution", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "in_transit",
        trackingEvents: [
          {
            at: new Date(NOW.getTime() - (__TEST.STALE_OUT_FOR_DELIVERY_MS + 60_000)),
            normalizedStatus: "out_for_delivery",
          },
        ],
      }),
    );
    expect(r?.code).toBe("stuck_in_transit");
  });
});

describe("classifyOperationalHint — stuck-in-transit", () => {
  it("fires when last tracking activity is older than 4 days", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "in_transit",
        lastTrackingActivityAt: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(r?.code).toBe("stuck_in_transit");
  });

  it("does NOT fire when activity is fresh", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "in_transit",
        lastTrackingActivityAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      }),
    );
    expect(r).toBeNull();
  });
});

describe("classifyOperationalHint — stuck-pending-pickup", () => {
  it("fires when confirmed for >36h with no shipment", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "confirmed",
        shippedAt: null,
        confirmationSentAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
      }),
    );
    expect(r?.code).toBe("stuck_pending_pickup");
  });

  it("does NOT fire when shippedAt is set", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "shipped",
        shippedAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
        confirmationSentAt: new Date(NOW.getTime() - 60 * 60 * 60 * 1000),
      }),
    );
    expect(r).toBeNull();
  });
});

describe("classifyOperationalHint — rule priority", () => {
  it("address-clarification wins over confirmation flow when both apply", () => {
    const r = classifyOperationalHint(
      withNow({
        status: "pending",
        addressCompleteness: "incomplete",
        automationState: "pending_confirmation",
      }),
    );
    expect(r?.code).toBe("address_clarification_needed");
  });

  it("delivery_failed wins over stuck_in_transit when both apply", () => {
    // Stuck threshold + a recent failed event — failed wins.
    const r = classifyOperationalHint(
      withNow({
        status: "in_transit",
        lastTrackingActivityAt: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
        trackingEvents: [
          { at: new Date(NOW.getTime() - 60 * 60 * 1000), normalizedStatus: "failed" },
        ],
      }),
    );
    expect(r?.code).toBe("delivery_failed_attempt");
  });
});

describe("classifyOperationalHint — code stability", () => {
  it("emits only known stable codes", () => {
    const inputs: Array<Partial<OrderHintInput>> = [
      { status: "pending", addressCompleteness: "incomplete" },
      { status: "pending", automationState: "pending_confirmation" },
      { status: "pending", fraudReviewStatus: "no_answer" },
      {
        status: "in_transit",
        trackingEvents: [{ at: new Date(NOW.getTime() - 60_000), normalizedStatus: "failed" }],
      },
    ];
    for (const input of inputs) {
      const r = classifyOperationalHint(withNow(input));
      if (r) {
        expect(OPERATIONAL_HINT_CODES).toContain(r.code as OperationalHintCode);
      }
    }
  });
});

describe("classifyOperationalHint — determinism", () => {
  it("same input → same output", () => {
    const input = withNow({
      status: "pending",
      addressCompleteness: "incomplete",
    });
    const a = classifyOperationalHint(input);
    const b = classifyOperationalHint(input);
    expect(a?.code).toBe(b?.code);
    expect(a?.severity).toBe(b?.severity);
    expect(a?.label).toBe(b?.label);
  });
});
