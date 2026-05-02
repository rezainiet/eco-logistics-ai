import { env } from "../../env.js";
import {
  SslWirelessTransport,
  type SmsSendInput,
  type SmsSendResult,
  type SmsTransport,
  normalizeBdPhone,
} from "./sslwireless.js";

/**
 * SMS pipeline.
 *
 * Backed by SSL Wireless (Bangladesh) by default. Mirrors the email module's
 * dev-fallback pattern: when the SSL Wireless keys are unset, we log to
 * stdout instead of sending. In production, missing keys cause `sendSms` to
 * no-op with a loud warning rather than throwing into the request path —
 * order creation and auth must NEVER fail because the SMS gateway is down.
 *
 * The module exports purpose-built helpers (`sendOtpSms`, `sendOrderConfirmationSms`,
 * `sendCriticalAlertSms`) so call-sites stay readable and the templating
 * stays in one place. The lower-level `sendSms` is exported too for ad-hoc
 * use (e.g. password-reset notifications) but prefer the helpers.
 */

export type { SmsSendInput, SmsSendResult, SmsTransport };
export { normalizeBdPhone };

/** Single concat segment cap (Unicode 70 / GSM-7 160). Pick the safer one. */
const SAFE_LENGTH = 160;

/**
 * Truncate a body to a single-segment-friendly length and warn loudly so the
 * caller can pick a shorter copy. We never silently chop more than 160 chars
 * because SSL Wireless will charge for each split segment otherwise.
 */
function clampBody(body: string, tag: string): string {
  if (body.length <= SAFE_LENGTH) return body;
  console.warn(
    `[sms] body for tag=${tag} is ${body.length} chars; truncating to ${SAFE_LENGTH}`,
  );
  return `${body.slice(0, SAFE_LENGTH - 1)}…`;
}

let cachedTransport: SmsTransport | null | undefined;

function loadTransport(): SmsTransport | null {
  if (cachedTransport !== undefined) return cachedTransport;
  const apiToken = env.SSL_WIRELESS_API_KEY;
  const user = env.SSL_WIRELESS_USER;
  const sid = env.SSL_WIRELESS_SID;
  if (!apiToken || !user || !sid) {
    cachedTransport = null;
    return null;
  }
  cachedTransport = new SslWirelessTransport({
    apiToken,
    user,
    sid,
    baseUrl: env.SSL_WIRELESS_BASE_URL,
    defaultSender: env.SSL_WIRELESS_DEFAULT_SENDER,
  });
  return cachedTransport;
}

/**
 * Test-only escape hatch so the vitest suite can swap in a fake transport.
 * Production code never calls this.
 */
export function __setSmsTransport(t: SmsTransport | null): void {
  cachedTransport = t;
}

/**
 * Reset the cached transport so the next `sendSms` call rebuilds from env.
 * Mostly for tests that mutate process.env.
 */
export function __resetSmsTransport(): void {
  cachedTransport = undefined;
}

export interface SendSmsOptions {
  /** Free-form tag for analytics + the dev-mode log line. */
  tag?: string;
  /** Override the default sender mask. */
  sender?: string;
  /** Custom client correlation id (echoed back in DLR webhooks). */
  csmsId?: string;
}

/**
 * Send a single SMS. Never throws — returns a result object so callers can
 * decide whether to retry, log, or silently absorb the failure.
 */
export async function sendSms(
  to: string,
  body: string,
  opts: SendSmsOptions = {},
): Promise<SmsSendResult> {
  const tag = opts.tag ?? "untagged";
  const phone = normalizeBdPhone(to);
  if (!phone) {
    return { ok: false, error: `invalid phone: ${to}`, providerStatus: "client_invalid_phone" };
  }
  const clamped = clampBody(body, tag);
  const transport = loadTransport();

  if (!transport) {
    if (env.NODE_ENV === "production") {
      console.warn(
        `[sms] PROD with SSL Wireless keys unset — dropping message tag=${tag} to=${phone}`,
      );
      return { ok: false, error: "sms provider not configured", providerStatus: "no_provider" };
    }
    // Dev/test: log instead of send. Keeps signup/reset flows working.
    console.log(`[sms:dev] tag=${tag} to=${phone}: ${clamped}`);
    return { ok: true, providerMessageId: `dev-${Date.now()}`, providerStatus: "dev_stdout" };
  }

  return transport.send({
    to: phone,
    body: clamped,
    sender: opts.sender,
    csmsId: opts.csmsId,
  });
}

/* -------------------------------------------------------------------------- */
/* Templated helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 6-digit OTP with a 5-min validity hint. Used by F3e (auth password-reset
 * SMS path) and any future signup/2FA flow.
 */
export function sendOtpSms(
  phone: string,
  code: string,
  opts: { brand?: string; ttlMinutes?: number } = {},
): Promise<SmsSendResult> {
  const brand = opts.brand ?? "Cowork";
  const ttl = opts.ttlMinutes ?? 5;
  return sendSms(
    phone,
    `${brand}: your verification code is ${code}. Valid for ${ttl} minutes. Do not share with anyone.`,
    { tag: "auth_otp", csmsId: `otp-${Date.now()}` },
  );
}

/**
 * Reset-link companion SMS. The merchant gets the actual reset URL via email;
 * this SMS is a fast, separate-channel alert that an attempt happened so the
 * merchant can panic-press "wasn't me" if it wasn't them.
 */
export function sendPasswordResetAlertSms(
  phone: string,
  opts: { brand?: string; ip?: string | null } = {},
): Promise<SmsSendResult> {
  const brand = opts.brand ?? "Cowork";
  const where = opts.ip ? ` from ${opts.ip}` : "";
  return sendSms(
    phone,
    `${brand}: a password-reset link was just sent to your email${where}. If this wasn't you, log in and rotate your password immediately.`,
    { tag: "auth_reset_alert" },
  );
}

/**
 * Pre-pickup order confirmation. Customer is asked to reply YES/NO. The
 * inbound-reply handler lives in the future F2 webhook — this helper just
 * sends the outbound prompt. Bilingual (EN + Bangla) to maximise answer rate.
 */
export function sendOrderConfirmationSms(
  phone: string,
  opts: {
    brand?: string;
    orderNumber: string;
    codAmount?: number;
    /**
     * 6-digit reply code minted upstream by the automation engine. The
     * inbound-SMS webhook requires this exact code on the customer's reply
     * to map the YES/NO back to a single order. Without it the loop is
     * dead — so this parameter is REQUIRED, not optional.
     */
    confirmationCode: string;
  },
): Promise<SmsSendResult> {
  const brand = opts.brand ?? "Cowork";
  const cod = opts.codAmount && opts.codAmount > 0 ? ` COD ${opts.codAmount} BDT.` : "";
  // Bilingual (EN + Bangla) so the customer can reply in whichever language
  // they read first. The 6-digit code is repeated in both halves so a quick
  // glance is enough.
  return sendSms(
    phone,
    `${brand}: Confirm order #${opts.orderNumber}.${cod} Reply "YES ${opts.confirmationCode}" to confirm or "NO ${opts.confirmationCode}" to cancel. অর্ডার নিশ্চিত করতে "YES ${opts.confirmationCode}" লিখুন।`,
    {
      tag: "order_confirmation",
      // csmsId carries the code so the SMS provider DLR can be cross-referenced
      // with the order without a separate join table.
      csmsId: `confirm-${opts.orderNumber}-${opts.confirmationCode}`,
    },
  );
}

/**
 * Courtesy reply for a customer who confirms an order *after* it has
 * already auto-rejected (no-reply timeout). Prevents the silent-drop UX
 * where the customer thinks their YES landed but the merchant marked
 * the order dead hours earlier. Best-effort, capped to once per
 * (phone, order) by the caller via the `lateReplyAcknowledgedAt` stamp.
 */
export function sendOrderExpiredSms(
  phone: string,
  opts: { brand?: string; orderNumber: string },
): Promise<SmsSendResult> {
  const brand = opts.brand ?? "Cowork";
  return sendSms(
    phone,
    `${brand}: Sorry — order #${opts.orderNumber} has expired and cannot be confirmed. Please place a new order. দুঃখিত — অর্ডারটির মেয়াদ শেষ। অনুগ্রহ করে নতুন অর্ডার দিন।`,
    { tag: "order_expired", csmsId: `expired-${opts.orderNumber}-${Date.now()}` },
  );
}

/**
 * Delivery / status update. Used post-confirmation when the courier emits a
 * status webhook. Body intentionally short — under 160 chars after merging.
 */
export function sendDeliveryUpdateSms(
  phone: string,
  opts: { brand?: string; orderNumber: string; status: string; trackUrl?: string },
): Promise<SmsSendResult> {
  const brand = opts.brand ?? "Cowork";
  const link = opts.trackUrl ? ` Track: ${opts.trackUrl}` : "";
  return sendSms(
    phone,
    `${brand}: order #${opts.orderNumber} is now ${opts.status}.${link}`,
    { tag: "delivery_update", csmsId: `update-${opts.orderNumber}-${Date.now()}` },
  );
}

/**
 * Critical merchant-facing alert (RTO spike, payment failure, fraud alert).
 * Sent in addition to the in-app inbox row, never in place of it.
 */
export function sendCriticalAlertSms(
  phone: string,
  body: string,
  opts: { brand?: string; tag?: string } = {},
): Promise<SmsSendResult> {
  const brand = opts.brand ?? "Cowork";
  return sendSms(phone, `${brand} alert: ${body}`, {
    tag: opts.tag ?? "critical_alert",
  });
}
