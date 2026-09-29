import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ManualRailOption,
  type PaymentFormMethod,
  isPaymentMethodAvailable,
  paymentMethodHelp,
} from "./payment-method-help";

// Shape of billing.getPaymentInstructions → options when production env
// has no PAY_* rails configured (the live state that showed 01XXXXXXXXX).
const UNCONFIGURED: ManualRailOption[] = [
  { method: "bkash", label: "bKash", enabled: false },
  { method: "nagad", label: "Nagad", enabled: false },
  { method: "bank_transfer", label: "Bank Transfer", enabled: false },
];

// Clearly-fake test fixtures (never real destinations).
const CONFIGURED: ManualRailOption[] = [
  { method: "bkash", label: "bKash", enabled: true, destination: "01700000000", hint: "Merchant" },
  { method: "nagad", label: "Nagad", enabled: true, destination: "01800000000" },
  { method: "bank_transfer", label: "Bank Transfer", enabled: true, destination: "Test Bank — A/C 000 — Test Ltd" },
];

const RAILS: PaymentFormMethod[] = ["bkash", "nagad", "bank_transfer"];
const PLACEHOLDER = /X{4,}|1234567890|01XXXXXXXXX/;

describe("paymentMethodHelp — unconfigured production", () => {
  it.each(RAILS)("%s shows an explicit not-set-up state and no destination", (method) => {
    const help = paymentMethodHelp(method, UNCONFIGURED);
    expect(help.configured).toBe(false);
    expect(help.text).toMatch(/not set up/);
    expect(help.text).toMatch(/Don't send money/);
    expect(help.text).not.toMatch(PLACEHOLDER);
    expect(help.text).not.toMatch(/Send to/);
    expect(isPaymentMethodAvailable(method, UNCONFIGURED)).toBe(false);
  });

  it("an enabled rail with a blank destination is still treated as not configured", () => {
    const help = paymentMethodHelp("bkash", [{ method: "bkash", label: "bKash", enabled: true, destination: "  " }]);
    expect(help.configured).toBe(false);
  });

  it("a rail missing from the server list is not configured", () => {
    expect(paymentMethodHelp("nagad", []).configured).toBe(false);
  });
});

describe("paymentMethodHelp — configured", () => {
  it("shows the server-provided bKash number and type", () => {
    const help = paymentMethodHelp("bkash", CONFIGURED);
    expect(help).toEqual({ configured: true, text: "Send to 01700000000 (Merchant). Use the provided reference." });
  });
  it("shows Nagad without a type suffix when none is configured", () => {
    expect(paymentMethodHelp("nagad", CONFIGURED).text).toBe("Send to 01800000000. Use the provided reference.");
  });
  it("shows the configured bank details", () => {
    expect(paymentMethodHelp("bank_transfer", CONFIGURED).text).toContain("Test Bank — A/C 000 — Test Ltd");
  });
  it("mixes correctly when only some rails are configured", () => {
    const mixed = [CONFIGURED[0]!, UNCONFIGURED[1]!, UNCONFIGURED[2]!];
    expect(paymentMethodHelp("bkash", mixed).configured).toBe(true);
    expect(paymentMethodHelp("nagad", mixed).configured).toBe(false);
  });
});

describe("paymentMethodHelp — non-rail methods and loading", () => {
  it("card and other never claim a destination and are always selectable", () => {
    for (const m of ["card", "other"] as const) {
      expect(paymentMethodHelp(m, UNCONFIGURED).configured).toBeNull();
      expect(isPaymentMethodAvailable(m, UNCONFIGURED)).toBe(true);
    }
  });
  it("while loading, shows neither a destination nor a false 'not set up'", () => {
    const help = paymentMethodHelp("bkash", undefined);
    expect(help.configured).toBeNull();
    expect(help.text).not.toMatch(PLACEHOLDER);
  });
});

describe("billing page source", () => {
  it("contains no hardcoded payment destinations", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../app/dashboard/settings/billing/page.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/Send to 01X/);
    expect(src).not.toMatch(/1234567890/);
    expect(src).toContain("getPaymentInstructions");
  });
});
