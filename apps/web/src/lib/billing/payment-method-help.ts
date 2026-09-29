/**
 * Help text under the manual-payment form's "Payment method" select.
 *
 * Payment destinations come ONLY from the server (`billing.getPaymentInstructions`,
 * backed by PAY_BKASH_NUMBER / PAY_NAGAD_NUMBER / PAY_BANK_INFO). Nothing here
 * may invent a number or account: when a rail isn't configured the merchant
 * sees an explicit "not set up" state and is told not to send money.
 */

export type PaymentFormMethod = "bkash" | "nagad" | "bank_transfer" | "card" | "other";

export interface ManualRailOption {
  method: "bkash" | "nagad" | "bank_transfer";
  label: string;
  enabled: boolean;
  destination?: string | null;
  hint?: string | null;
}

export interface PaymentMethodHelp {
  /**
   * true  — a real destination is configured and shown;
   * false — this rail is NOT configured (show as a warning);
   * null  — not applicable (card / other) or still loading.
   */
  configured: boolean | null;
  text: string;
}

export const PAYMENT_METHOD_LABEL: Record<PaymentFormMethod, string> = {
  bkash: "bKash",
  nagad: "Nagad",
  bank_transfer: "Bank transfer",
  card: "Card",
  other: "Other",
};

export function paymentMethodHelp(
  method: PaymentFormMethod,
  options: ReadonlyArray<ManualRailOption> | null | undefined,
): PaymentMethodHelp {
  if (method === "card") return { configured: null, text: "Upload your card payment receipt for manual review." };
  if (method === "other") return { configured: null, text: "Add details in the notes field." };
  if (!options) return { configured: null, text: "Loading payment details…" };

  const opt = options.find((o) => o.method === method);
  const destination = opt?.destination?.trim();
  if (!opt?.enabled || !destination) {
    return {
      configured: false,
      text: `${PAYMENT_METHOD_LABEL[method]} payment details are not set up yet. Don't send money this way — contact support for payment instructions.`,
    };
  }
  if (method === "bank_transfer") {
    return { configured: true, text: `Transfer to: ${destination}. Use your business name as the reference.` };
  }
  const hint = opt.hint?.trim();
  return {
    configured: true,
    text: `Send to ${destination}${hint ? ` (${hint})` : ""}. Use the provided reference.`,
  };
}

/** Whether a rail can currently be paid to (card/other are always selectable). */
export function isPaymentMethodAvailable(
  method: PaymentFormMethod,
  options: ReadonlyArray<ManualRailOption> | null | undefined,
): boolean {
  return paymentMethodHelp(method, options).configured !== false;
}
