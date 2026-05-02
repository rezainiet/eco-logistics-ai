import { captureException, captureMessage } from "../telemetry.js";

/**
 * Observability helper for inbound courier webhooks.
 *
 * Two purposes:
 *  1. Counters — every outcome bumps an in-memory tally so /health can
 *     surface success/duplicate/error rates without a metrics backend.
 *     Replace with Prometheus/Datadog when one is wired up.
 *  2. Structured logs + Sentry — one log line per webhook, plus a Sentry
 *     hit on `apply_failed` and `internal_error` so on-call sees real
 *     failures (not the noise of "courier sent us a status for an order
 *     we don't have").
 *
 * What we never log:
 *  - PII (customer name, phone, address, COD amount). The tracking code is
 *    not PII (it's a courier-public id) so it's safe to include.
 *  - The merchant's apiSecret or any decrypted credential.
 *  - The full payload — we already store it in WebhookInbox; logs stay slim.
 */

export type CourierProvider = "steadfast" | "pathao" | "redx";

export type CourierWebhookOutcome =
  | "applied"           // event written, possibly with status transition
  | "duplicate"         // courier replay; idempotent success
  | "ignored"           // no tracking code in payload (test ping)
  | "order_not_found"   // tracking code didn't match any order for this merchant
  | "invalid_signature" // HMAC mismatch
  | "tenant_mismatch"   // defence-in-depth: order's merchantId doesn't match URL
  | "not_found"         // merchant or courier config missing
  | "bad_request"       // malformed body / missing params
  | "apply_failed"      // applyTrackingEvents threw — will retry
  | "internal_error";   // catch-all, captured to Sentry

export interface RecordOutcomeInput {
  provider: CourierProvider;
  outcome: CourierWebhookOutcome;
  merchantId?: string;
  trackingCode?: string;
  newEvents?: number;
  statusTransition?: string;
  error?: string;
  durationMs?: number;
}

const counters: Record<CourierProvider, Record<CourierWebhookOutcome, number>> = {
  steadfast: emptyOutcomeMap(),
  pathao: emptyOutcomeMap(),
  redx: emptyOutcomeMap(),
};

function emptyOutcomeMap(): Record<CourierWebhookOutcome, number> {
  return {
    applied: 0,
    duplicate: 0,
    ignored: 0,
    order_not_found: 0,
    invalid_signature: 0,
    tenant_mismatch: 0,
    not_found: 0,
    bad_request: 0,
    apply_failed: 0,
    internal_error: 0,
  };
}

const SENTRY_OUTCOMES: ReadonlySet<CourierWebhookOutcome> = new Set([
  "apply_failed",
  "internal_error",
]);

const WARN_OUTCOMES: ReadonlySet<CourierWebhookOutcome> = new Set([
  "invalid_signature",
  "tenant_mismatch",
]);

export function recordWebhookOutcome(input: RecordOutcomeInput): void {
  counters[input.provider][input.outcome] += 1;

  // One structured log line per webhook. Console JSON is the lowest common
  // denominator — log forwarders (Loki/Datadog/CloudWatch) all index it.
  const line = {
    msg: "courier_webhook",
    provider: input.provider,
    outcome: input.outcome,
    merchantId: input.merchantId,
    trackingCode: input.trackingCode,
    newEvents: input.newEvents,
    statusTransition: input.statusTransition,
    durationMs: input.durationMs,
    error: input.error?.slice(0, 200),
  };

  if (SENTRY_OUTCOMES.has(input.outcome)) {
    console.error(JSON.stringify(line));
    if (input.error) {
      captureException(new Error(input.error), {
        tags: {
          provider: input.provider,
          outcome: input.outcome,
          merchantId: input.merchantId ?? "unknown",
        },
        contexts: { courierWebhook: { trackingCode: input.trackingCode ?? "" } },
      });
    } else {
      captureMessage(`courier_webhook ${input.provider} ${input.outcome}`, {
        tags: { provider: input.provider, outcome: input.outcome },
        level: "error",
      });
    }
  } else if (WARN_OUTCOMES.has(input.outcome)) {
    console.warn(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

export interface CourierWebhookCounters {
  provider: CourierProvider;
  total: number;
  applied: number;
  duplicate: number;
  invalidSignature: number;
  orderNotFound: number;
  applyFailed: number;
  internalError: number;
  successRate: number; // applied / total
}

export function snapshotCounters(): CourierWebhookCounters[] {
  return (Object.keys(counters) as CourierProvider[]).map((provider) => {
    const c = counters[provider];
    const total = Object.values(c).reduce((sum, n) => sum + n, 0);
    const applied = c.applied + c.duplicate + c.ignored;
    return {
      provider,
      total,
      applied: c.applied,
      duplicate: c.duplicate,
      invalidSignature: c.invalid_signature,
      orderNotFound: c.order_not_found,
      applyFailed: c.apply_failed,
      internalError: c.internal_error,
      successRate: total === 0 ? 0 : applied / total,
    };
  });
}

/** For tests — wipe the in-memory counters between runs. */
export function __resetCourierWebhookCounters(): void {
  for (const p of Object.keys(counters) as CourierProvider[]) {
    counters[p] = emptyOutcomeMap();
  }
}
