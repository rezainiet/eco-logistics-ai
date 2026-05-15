/**
 * Provider-agnostic SMS transport types.
 *
 * Shared by every adapter under `lib/sms/<vendor>.ts`. Each adapter implements
 * `SmsTransport.send` and is plugged into the resolver in `lib/sms/index.ts`
 * via the `SMS_PROVIDER` env flag.
 *
 * Why this lives in its own file:
 *   - Keeps adapter modules from importing each other for shared types
 *     (avoids a hidden coupling where renaming a field in SSL Wireless
 *     accidentally drags BulkSMSBD along).
 *   - Lets test code import the canonical `SmsTransport` shape without
 *     dragging in a concrete adapter's vendor SDK.
 */

export interface SmsSendInput {
  /** Recipient phone in international or BD-local format. Adapter normalizes. */
  to: string;
  /** UTF-8 message body. Providers may auto-split into segments. */
  body: string;
  /**
   * Optional sender mask override. Each adapter decides how to map this onto
   * its provider's sender/mask/sid concept; passing `undefined` defaults to
   * the adapter's configured default sender.
   */
  sender?: string;
  /** Optional client-supplied id for delivery-report correlation. */
  csmsId?: string;
}

export interface SmsSendResult {
  ok: boolean;
  /** Provider message id for DLR lookups. */
  providerMessageId?: string;
  /** Raw status string returned by the provider, useful for diagnostics. */
  providerStatus?: string;
  /** Human-readable error message when `ok === false`. */
  error?: string;
  /**
   * Adapter identifier ("sslwireless", "bulksmsbd", "stub"). Set by the
   * resolver / templated-helper layer so observability has a consistent
   * provenance field regardless of which transport ran.
   */
  provider?: string;
}

export interface SmsTransport {
  /** Adapter name — written to structured logs + result.provider. */
  readonly name: string;
  send(input: SmsSendInput): Promise<SmsSendResult>;
}

/**
 * Normalize a raw phone string to the format BD SMS providers prefer:
 * 13-digit `8801XXXXXXXXX` with no leading "+". Both SSL Wireless and
 * BulkSMSBD route this shape most reliably.
 *
 * Storage-canonical (`Order.customer.phone`, audit logs) is E.164 with the
 * leading "+" — see `lib/phone.ts`. This function strips the plus at the
 * provider boundary; callers MUST pass E.164 or BD-local in, and trust the
 * adapter to do the conversion.
 *
 * Returns `null` when the input clearly isn't a phone so the caller can
 * fail fast rather than burn an HTTP call.
 */
export function normalizeBdPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // 11-digit local BD (01XXXXXXXXX) → prepend country code.
  if (digits.length === 11 && digits.startsWith("01")) {
    return `88${digits}`;
  }
  // Already in 13-digit form (8801XXXXXXXXX) — pass through.
  if (digits.length === 13 && digits.startsWith("880")) {
    return digits;
  }
  // Other lengths: assume already E.164-ish without the plus. Both providers
  // tolerate non-BD numbers for international fallback.
  return digits;
}
