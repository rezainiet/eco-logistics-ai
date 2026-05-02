import { Types } from "mongoose";
import { Order, WebhookInbox } from "@ecom/db";
import { applyTrackingEvents } from "./tracking.js";
import { COURIER_CONFIGS } from "./webhooks/courier.js";
import {
  nextRetryDelayMs,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
  type ReplayWebhookResult,
} from "./ingest.js";
import { recordWebhookOutcome } from "../lib/observability/courier-webhook.js";

/**
 * Re-run a previously-failed courier `WebhookInbox` row through
 * `applyTrackingEvents`. Used by the webhook-retry worker.
 *
 * Mirrors `replayWebhookInbox` (commerce platforms) in shape and state
 * machine — same ReplayWebhookResult, same backoff/dead-letter rules — so
 * the worker can route to either path interchangeably.
 *
 * Tenant isolation: the inbox row carries `merchantId` set at write time;
 * we re-validate the resolved order belongs to that merchant before
 * applying. Defence-in-depth against a bug in the inbox shape.
 */
export async function replayCourierInbox(args: {
  inboxId: Types.ObjectId;
  manual?: boolean;
}): Promise<ReplayWebhookResult> {
  const inbox = await WebhookInbox.findById(args.inboxId);
  if (!inbox) {
    return { ok: false, error: "inbox row not found", status: "skipped", attempts: 0 };
  }
  if (inbox.status === "succeeded") {
    return {
      ok: true,
      duplicate: true,
      orderId: inbox.resolvedOrderId ? String(inbox.resolvedOrderId) : undefined,
      status: "skipped",
      attempts: inbox.attempts ?? 0,
    };
  }

  const cfg = COURIER_CONFIGS[inbox.provider];
  if (!cfg) {
    inbox.status = "failed";
    inbox.lastError = `unknown courier: ${inbox.provider}`;
    inbox.processedAt = new Date();
    inbox.nextRetryAt = undefined;
    await inbox.save();
    return {
      ok: false,
      error: inbox.lastError,
      status: "failed",
      attempts: inbox.attempts ?? 0,
    };
  }

  const parsed = cfg.parse(inbox.payload);
  if (!parsed) {
    // Original intake decided this was a non-actionable shape — succeed
    // permanently so the row stops bouncing through the queue.
    inbox.status = "succeeded";
    inbox.lastError = "ignored on replay";
    inbox.processedAt = new Date();
    inbox.nextRetryAt = undefined;
    await inbox.save();
    return { ok: true, status: "succeeded", attempts: inbox.attempts ?? 0 };
  }

  // Re-resolve the order — between the failed attempt and now the order
  // could have been deleted, or its tracking number could have rotated.
  const order = await Order.findOne({
    merchantId: inbox.merchantId,
    "logistics.trackingNumber": parsed.trackingCode,
  })
    .select("_id merchantId order logistics")
    .lean();

  if (!order) {
    inbox.status = "succeeded";
    inbox.lastError = "order not found on replay";
    inbox.processedAt = new Date();
    inbox.nextRetryAt = undefined;
    await inbox.save();
    return { ok: true, status: "succeeded", attempts: inbox.attempts ?? 0 };
  }

  // Defence-in-depth: verify the order really belongs to the merchant the
  // inbox row names. Refuse to replay otherwise — a corrupt inbox row must
  // never become a vector for cross-tenant writes.
  if (String(order.merchantId) !== String(inbox.merchantId)) {
    inbox.status = "failed";
    inbox.lastError = "tenant mismatch on replay";
    inbox.processedAt = new Date();
    await inbox.save();
    recordWebhookOutcome({
      provider: inbox.provider as "steadfast" | "pathao" | "redx",
      outcome: "tenant_mismatch",
      merchantId: String(inbox.merchantId),
      trackingCode: parsed.trackingCode,
    });
    return {
      ok: false,
      error: "tenant mismatch",
      status: "failed",
      attempts: inbox.attempts ?? 0,
    };
  }

  try {
    const result = await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      parsed.normalizedStatus,
      [
        {
          at: parsed.at,
          providerStatus: parsed.providerStatus,
          description: parsed.description,
          location: parsed.location,
        },
      ],
      { source: "webhook", deliveredAt: parsed.deliveredAt },
    );

    inbox.status = "succeeded";
    inbox.lastError = result.newEvents === 0 ? "no new events on replay" : undefined;
    inbox.processedAt = new Date();
    inbox.nextRetryAt = undefined;
    inbox.resolvedOrderId = order._id as Types.ObjectId;
    await inbox.save();

    recordWebhookOutcome({
      provider: inbox.provider as "steadfast" | "pathao" | "redx",
      outcome: result.newEvents > 0 ? "applied" : "duplicate",
      merchantId: String(inbox.merchantId),
      trackingCode: parsed.trackingCode,
      newEvents: result.newEvents,
      statusTransition: result.statusTransition
        ? `${result.statusTransition.from}->${result.statusTransition.to}`
        : undefined,
    });

    return {
      ok: true,
      orderId: String(order._id),
      status: "succeeded",
      attempts: inbox.attempts ?? 0,
    };
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? "unknown";
    const attempts = (inbox.attempts ?? 0) + 1;
    inbox.attempts = attempts;
    inbox.lastError = message;
    inbox.processedAt = new Date();

    if (attempts >= WEBHOOK_RETRY_MAX_ATTEMPTS) {
      inbox.status = "failed";
      inbox.deadLetteredAt = new Date();
      inbox.nextRetryAt = undefined;
      await inbox.save();
      recordWebhookOutcome({
        provider: inbox.provider as "steadfast" | "pathao" | "redx",
        outcome: "apply_failed",
        merchantId: String(inbox.merchantId),
        trackingCode: parsed.trackingCode,
        error: message,
      });
      return {
        ok: false,
        error: message,
        status: "dead_lettered",
        attempts,
      };
    }

    inbox.status = "failed";
    inbox.nextRetryAt = new Date(Date.now() + nextRetryDelayMs(attempts));
    await inbox.save();
    return {
      ok: false,
      error: message,
      status: "failed",
      attempts,
    };
  }
}

export const COURIER_PROVIDER_NAMES_FOR_INBOX = ["steadfast", "pathao", "redx"] as const;

/** True when the WebhookInbox row was written by a courier handler. */
export function isCourierInboxProvider(provider: string): boolean {
  return (COURIER_PROVIDER_NAMES_FOR_INBOX as readonly string[]).includes(provider);
}
