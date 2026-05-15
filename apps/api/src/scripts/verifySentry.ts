import { randomUUID } from "node:crypto";
import {
  captureException,
  captureMessage,
  isTelemetryEnabled,
} from "../lib/telemetry.js";
import { env } from "../env.js";

/**
 * Sentry / telemetry verification.
 *
 * telemetry.ts is dependency-free and fire-and-forget by design, which
 * means a misconfigured DSN fails *silently* — exactly the worst case
 * for "production broke at 2am". This script proves, before a real
 * merchant is onboarded, that errors actually leave the box and land in
 * Sentry.
 *
 * Behaviour:
 *   - DSN unset/unparseable  -> loud message, exit 1 (use as a deploy
 *     gate: "do not onboard merchants while blind").
 *   - DSN set                -> sends ONE captureMessage + ONE
 *     captureException carrying a unique nonce, waits for the envelope
 *     POST to flush, then tells the founder exactly what to search for
 *     in Sentry.
 *
 * Deliberately one event each — not a load test. Safe to run in prod.
 *
 * Usage: npm --workspace apps/api run verify:sentry
 */

async function main(): Promise<void> {
  const nonce = randomUUID().slice(0, 8);

  if (!isTelemetryEnabled()) {
    console.error(
      [
        "",
        "  [SENTRY] OFF — SENTRY_DSN is unset or unparseable.",
        "  Production exceptions and worker failures will NOT be captured.",
        "  Set SENTRY_DSN in the API environment before onboarding merchants.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `[SENTRY] enabled (env=${env.NODE_ENV}${
      env.SENTRY_RELEASE ? `, release=${env.SENTRY_RELEASE}` : ""
    }). Sending one test message + one test exception…`,
  );
  console.log(`[SENTRY] verification nonce: ${nonce}`);

  captureMessage(`ConfirmX telemetry verification ${nonce}`, {
    level: "info",
    tags: { source: "verify_sentry", nonce },
  });
  captureException(
    new Error(`ConfirmX telemetry verification exception ${nonce}`),
    { tags: { source: "verify_sentry", nonce }, level: "warning" },
  );

  // telemetry.send() is fire-and-forget (void). Give the envelope POSTs
  // time to leave before the process exits, or the test never arrives.
  await new Promise((r) => setTimeout(r, 4000));

  console.log(
    [
      "",
      "  [SENTRY] sent. In Sentry, search the project for:",
      `    ${nonce}`,
      "  You should see one message and one (warning) exception within ~1 min.",
      "  If nothing arrives: the DSN parses but is wrong/blocked — fix",
      "  before onboarding merchants. (telemetry.ts swallows transport",
      "  errors by design, so this script is the only signal.)",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error("[verify:sentry] failed:", err);
  process.exit(1);
});
