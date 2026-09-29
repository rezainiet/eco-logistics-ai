/**
 * Whether this deployment can send transactional email (verification,
 * password reset, receipts). The API reports it as `emailDelivery` on
 * `merchants.getProfile` and as `delivery` on the /auth/resend-verification
 * and /auth/request-reset responses — a deployment-wide fact, never
 * account-specific.
 *
 * When it's "unavailable" (production without an email provider key) the UI
 * must not say "we sent you an email" / "check your inbox".
 */
export type EmailDelivery = "available" | "unavailable";

/**
 * Read the signal from an API value. Anything but an explicit "unavailable"
 * is treated as available, so an older API that doesn't send the field keeps
 * today's behaviour.
 */
export function parseEmailDelivery(value: unknown): EmailDelivery {
  return value === "unavailable" ? "unavailable" : "available";
}

/** Read `delivery` from a JSON body returned by the auth email endpoints. */
export function emailDeliveryFromBody(body: unknown): EmailDelivery {
  if (body && typeof body === "object" && "delivery" in body) {
    return parseEmailDelivery((body as { delivery?: unknown }).delivery);
  }
  return "available";
}

export type VerifyPromptState = "hidden" | "prompt" | "sent" | "unavailable";

/**
 * What the dashboard's "verify your email" prompt should show.
 *   hidden      — verified, dismissed, or profile not loaded
 *   unavailable — no email provider: explain, offer no resend button
 *   sent        — resend accepted AND delivery is available
 *   prompt      — ask to verify, with a resend button
 */
export function verifyPromptState(input: {
  loaded: boolean;
  emailVerified: boolean;
  dismissed: boolean;
  delivery: EmailDelivery;
  resent: boolean;
}): VerifyPromptState {
  if (!input.loaded || input.emailVerified || input.dismissed) return "hidden";
  if (input.delivery === "unavailable") return "unavailable";
  return input.resent ? "sent" : "prompt";
}

export const EMAIL_UNAVAILABLE_COPY = {
  verifyShort: "Email verification isn't available yet",
  verifyLong:
    "Email verification isn't available yet — our email service is still being set up, so we can't send the link. Your account works normally in the meantime.",
  resetTitle: "Password reset email is unavailable",
  resetBody:
    "Our email service is still being set up, so we can't send a reset link right now. Contact support and we'll help you get back into your account.",
  resendFailed: "We can't send emails right now — our email service is still being set up. Please try again later or contact support.",
} as const;
