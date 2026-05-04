/**
 * Pure alert-rule helpers for the integration observability layer.
 *
 * Kept stateless and dependency-free so the same logic can run inside
 * a tRPC query (per-merchant), an admin dashboard aggregation, or a
 * scheduled alert worker without each call site re-implementing the
 * thresholds. Adjust thresholds here, not at call sites.
 */

/**
 * Window after which a connected integration with no inbound webhook
 * activity is flagged as `webhookSilent`. Tuned to "long enough that
 * a healthy quiet store doesn't false-alert, short enough that a real
 * subscription failure is caught the same business day". Per spec:
 * 10 minutes.
 */
export const WEBHOOK_SILENT_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Consecutive failure count above which an integration is flagged as
 * `unhealthy`. Counter resets to 0 on the next successful ingest, so
 * this catches sustained failure (5+ consecutive) without firing on a
 * single transient blip.
 */
export const ERROR_COUNT_UNHEALTHY_THRESHOLD = 5;

export interface IntegrationHealthSnapshot {
  status: "ok" | "error" | "idle";
  lastWebhookAt: Date | null;
  lastImportAt: Date | null;
  errorCount: number;
  lastError?: string | null;
}

export interface IntegrationHealthFlags {
  /** `errorCount` has crossed the unhealthy threshold. */
  unhealthy: boolean;
  /**
   * A connected integration has gone quiet on the webhook channel.
   * Possible causes: subscription disabled by the upstream after
   * repeated 4xx/5xx, secret rotation that broke HMAC, our DNS or
   * proxy dropping deliveries. Always false when `lastWebhookAt` is
   * null — a freshly-connected integration legitimately hasn't
   * received anything yet.
   */
  webhookSilent: boolean;
}

/**
 * Apply the alert thresholds to a health snapshot. Pure — `now` is
 * injectable so tests can pin time without mocking globals.
 */
export function evaluateIntegrationHealth(
  snapshot: IntegrationHealthSnapshot,
  now: Date = new Date(),
): IntegrationHealthFlags {
  const unhealthy =
    (snapshot.errorCount ?? 0) > ERROR_COUNT_UNHEALTHY_THRESHOLD;
  const webhookSilent =
    snapshot.lastWebhookAt !== null &&
    snapshot.lastWebhookAt !== undefined &&
    now.getTime() - snapshot.lastWebhookAt.getTime() >
      WEBHOOK_SILENT_THRESHOLD_MS;
  return { unhealthy, webhookSilent };
}
