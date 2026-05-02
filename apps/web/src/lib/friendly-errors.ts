/**
 * Maps a raw tRPC / fetch / mongo error message to a plain-language
 * string that a non-technical merchant can understand.
 *
 * Keep matchers conservative — we only override messages we recognise
 * with high confidence. Anything we don't recognise falls through
 * unchanged so debugging information is still available.
 */

const PATTERNS: Array<{ test: RegExp; replacement: string }> = [
  // Network / connectivity
  {
    test: /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i,
    replacement:
      "We could not reach the server. Check your internet connection and try again in a moment.",
  },
  // Auth / session
  {
    test: /UNAUTHORIZED|not authenticated|session.*expired|jwt/i,
    replacement:
      "Your session expired. Please sign in again to continue.",
  },
  {
    test: /FORBIDDEN|not allowed|insufficient permission|entitlement/i,
    replacement:
      "Your current plan does not include this action. Upgrade in Settings → Billing to unlock it.",
  },
  // Mongo duplicate key — most common cause: orderNumber collision
  {
    test: /E11000|duplicate key|already exists/i,
    replacement:
      "A matching record already exists. Please refresh the page — it may already be saved.",
  },
  // Rate-limit / 429 from any upstream (Shopify, courier API, our own limiter)
  {
    test: /429|rate.?limit|too many requests/i,
    replacement:
      "We are sending too many requests for the moment. Please wait a minute and try again.",
  },
  // Shopify / OAuth token rejected
  {
    test: /401|unauthori[sz]ed.*shopify|access token|invalid.*token/i,
    replacement:
      "Your store connection needs to be re-authorized. Open Settings → Integrations and click Reconnect.",
  },
  // Courier-side
  {
    test: /courier|steadfast|pathao|redx/i,
    replacement:
      "The courier did not accept this booking. Try a different courier in Settings or retry in a few minutes.",
  },
  // SMS gateway
  {
    test: /sms.*(failed|error|gateway|insufficient|balance)|ssl.?wireless/i,
    replacement:
      "SMS delivery failed — usually due to gateway rate limits or insufficient SMS balance. Top up your SSL Wireless balance and retry.",
  },
  // Validation / Zod / input errors
  {
    test: /zod|validation|invalid input|expected.*received|required/i,
    replacement:
      "Some required information is missing or in the wrong format. Please check the highlighted fields and try again.",
  },
  // Generic timeout / 5xx
  {
    test: /timeout|504|503|502|gateway/i,
    replacement:
      "The system is taking longer than expected. Please retry in a moment.",
  },
];

export function humanizeError(input: unknown): string {
  const raw =
    input instanceof Error
      ? input.message
      : typeof input === "string"
        ? input
        : (() => {
            try {
              return JSON.stringify(input);
            } catch {
              return "Unknown error";
            }
          })();
  if (!raw) return "Something went wrong. Please try again.";
  for (const p of PATTERNS) {
    if (p.test.test(raw)) return p.replacement;
  }
  // Fallback: trim long stack-traces / JSON blobs to one line so the
  // merchant doesn't see a wall of text.
  const oneLine = raw.split(/\r?\n/)[0]?.trim() ?? raw;
  if (oneLine.length > 180) return oneLine.slice(0, 180) + "…";
  return oneLine;
}
