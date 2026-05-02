import { env } from "../../env.js";
import type { CourierName } from "./types.js";

/**
 * Webhook registration helper.
 *
 * Reality check: of the three BD couriers we integrate (Steadfast, Pathao,
 * RedX), NONE expose a public REST endpoint for programmatic webhook URL
 * registration as of writing. All three require the merchant to paste the
 * URL into their courier portal manually:
 *
 *  - Steadfast: Account Settings → Webhooks
 *  - Pathao:    Merchant Dashboard → Webhooks
 *  - RedX:      Settings → Notifications (opt-in; not all accounts have this)
 *
 * So "auto-registration" is primarily a UI/UX feature: we generate the
 * exact URL the merchant should paste, plus copy-pasteable instructions,
 * and surface them in the addCourier flow. If a courier later ships a
 * registration API, swap the `method: "manual"` branch for `"auto"` here
 * and call their endpoint.
 */

export type WebhookRegistrationMethod = "auto" | "manual" | "unsupported";

export interface WebhookRegistrationResult {
  method: WebhookRegistrationMethod;
  /** The URL the merchant pastes into the courier portal (or that we'd POST to their API). */
  callbackUrl: string | null;
  /** Where in the courier UI the merchant should paste the URL. */
  instructions?: string;
  /** Copy-pasteable secret (= apiSecret) the merchant pastes into the "secret" field on the courier portal. */
  signingSecretHint?: string;
  /** Surfaced when registration was attempted but failed (`auto` mode only). */
  error?: string;
}

function publicApiBaseUrl(): string {
  // The webhook receiver lives on the API. Fall back to PUBLIC_WEB_URL for
  // dev where the API is proxied through the web app, otherwise default to
  // localhost.
  return (
    process.env.PUBLIC_API_URL ??
    env.PUBLIC_WEB_URL ??
    `http://localhost:${env.API_PORT}`
  ).replace(/\/$/, "");
}

function callbackUrlFor(courier: CourierName, merchantId: string): string {
  return `${publicApiBaseUrl()}/api/webhooks/courier/${courier}/${merchantId}`;
}

const STEADFAST_INSTRUCTIONS = `
1. Log into your Steadfast portal (https://portal.packzy.com).
2. Go to Account Settings → Webhooks (or "API & Webhooks").
3. Paste the URL above into the "Webhook URL" field.
4. Make sure your "API Secret" matches the one you entered here — Steadfast
   signs every webhook with HMAC-SHA256 over the request body.
5. Save. Your next status change will arrive via webhook within seconds.
`.trim();

const PATHAO_INSTRUCTIONS = `
1. Log into your Pathao Merchant dashboard.
2. Go to Settings → Webhooks.
3. Paste the URL above into the "Order Status Webhook" field.
4. Use the API Secret shown below as the signing secret.
5. Save and send a test event from the Pathao portal to verify.
`.trim();

const REDX_INSTRUCTIONS = `
RedX webhooks are opt-in — not every RedX merchant account has them
enabled. To request access:

1. Email your RedX KAM (Key Account Manager) and ask for "webhook
   notifications" to be enabled on your account.
2. Once enabled, go to RedX dashboard → Settings → Notifications.
3. Paste the URL above and use your API Secret as the signing secret.
4. Until webhooks are enabled, this courier falls back to polling — no
   action needed on your side, but tracking updates will lag by up to
   60 minutes (vs seconds via webhook).
`.trim();

/**
 * Build a webhook-registration result for a freshly-added/updated courier.
 *
 * Today this never actually calls a courier API — see the file-level note
 * for why. The shape exists so the merchant UI can render uniform "Auto
 * registered" or "Paste this URL" banners; when a courier ships a real
 * registration endpoint, just flip the relevant branch to `method: "auto"`
 * and add the HTTP call.
 */
export async function registerCourierWebhook(args: {
  courier: CourierName;
  merchantId: string;
  /** Decrypted apiSecret — used only to display in the result, never logged. */
  apiSecret?: string;
}): Promise<WebhookRegistrationResult> {
  const callbackUrl = callbackUrlFor(args.courier, args.merchantId);
  const signingSecretHint = args.apiSecret ? `${args.apiSecret.slice(0, 4)}…` : undefined;

  switch (args.courier) {
    case "steadfast":
      return {
        method: "manual",
        callbackUrl,
        instructions: STEADFAST_INSTRUCTIONS,
        signingSecretHint,
      };
    case "pathao":
      return {
        method: "manual",
        callbackUrl,
        instructions: PATHAO_INSTRUCTIONS,
        signingSecretHint,
      };
    case "redx":
      return {
        method: "manual",
        callbackUrl,
        instructions: REDX_INSTRUCTIONS,
        signingSecretHint,
      };
    default:
      return {
        method: "unsupported",
        callbackUrl: null,
      };
  }
}
