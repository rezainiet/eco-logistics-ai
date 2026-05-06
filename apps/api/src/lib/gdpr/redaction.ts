import { Types } from "mongoose";
import {
  AuditLog,
  CallLog,
  FraudPrediction,
  FraudSignal,
  Integration,
  MerchantStats,
  Notification,
  Order,
  Payment,
  RecoveryTask,
  TrackingEvent,
  TrackingSession,
  WebhookInbox,
} from "@ecom/db";

/**
 * GDPR / CCPA data redaction sweep — implements the actual deletion +
 * pseudonymisation work behind the Shopify mandatory privacy webhooks.
 *
 * Two entry points:
 *
 *   redactCustomer({ merchantId, identifiers })
 *      Triggered by `customers/redact`. Removes or pseudonymises rows
 *      tied to ONE customer within ONE merchant's scope.
 *
 *   redactShop({ merchantId })
 *      Triggered by `shop/redact` (48h after merchant uninstalls).
 *      Removes ALL rows tied to that merchant — orders, calls,
 *      tracking, fraud history, audit log, the integration row
 *      itself. Hard delete; no soft-delete window because Shopify's
 *      retention requirement is "no PII after redaction".
 *
 * Design choices worth knowing:
 *
 *   - We DELETE for shop/redact rather than nullifying. Shopify's
 *     contract is "if it can identify a person, it must be gone".
 *     Pseudonymising every PII field across every collection is
 *     error-prone (one missed field = a violation) and we don't need
 *     to retain shape-only data after a shop uninstalls.
 *
 *   - For customers/redact we PSEUDONYMISE rather than delete because
 *     the merchant still owns the order record (revenue, fulfilment
 *     status, fraud signals). Replacing PII with `[redacted]` /
 *     deterministic hashes keeps the merchant's analytics intact
 *     while removing identifiable content.
 *
 *   - FraudSignal stores phoneHash + addressHash already, so a
 *     customers/redact doesn't need to touch them — the hashes are
 *     not reversible. We do still delete them for shop/redact.
 *
 *   - Every sweep returns a per-collection `deleted` / `redacted`
 *     count for the audit log, so reviewers can see the work
 *     happened.
 *
 *   - All matches are scoped by merchantId so a customer
 *     identifier shared across merchants (rare but possible — same
 *     phone number shopping at two stores) only gets touched in the
 *     requesting merchant's scope.
 */

export type RedactionResult = {
  collection: string;
  deleted?: number;
  redacted?: number;
  matched?: number;
};

export interface CustomerIdentifiers {
  /** Lowercased + trimmed. */
  email?: string;
  /** Digits only after normalisation, e.g. "8801712345678". */
  phone?: string;
  /** Shopify's customer.id — used to locate matching orders even when
   *  email/phone changed between sessions. */
  shopifyCustomerId?: string;
  /** Order IDs Shopify named in `orders_to_redact`. */
  orderIds?: string[];
}

const REDACTED = "[redacted]";

/**
 * Pseudonymise a single customer's PII across all merchant collections
 * without breaking analytics rows that the merchant legitimately owns
 * (the order itself, the call log entry, etc.).
 *
 * Returns one row per touched collection so the caller can audit the
 * sweep precisely.
 */
export async function redactCustomer(args: {
  merchantId: Types.ObjectId;
  identifiers: CustomerIdentifiers;
}): Promise<RedactionResult[]> {
  const { merchantId, identifiers } = args;
  const results: RedactionResult[] = [];

  // Build identifier match clauses up front. Phone + email are the
  // primary pivots; orderIds give a precise fallback when Shopify
  // ships them.
  const orMatches: Record<string, unknown>[] = [];
  if (identifiers.email) {
    orMatches.push({ "customer.email": identifiers.email });
    orMatches.push({ email: identifiers.email });
  }
  if (identifiers.phone) {
    orMatches.push({ "customer.phone": identifiers.phone });
    orMatches.push({ customerPhone: identifiers.phone });
    orMatches.push({ phone: identifiers.phone });
  }
  if (identifiers.shopifyCustomerId) {
    orMatches.push({ "externalIds.shopifyCustomerId": identifiers.shopifyCustomerId });
  }
  if (orMatches.length === 0 && (!identifiers.orderIds || identifiers.orderIds.length === 0)) {
    // Nothing to match on — no-op rather than wildcarding the merchant's data.
    return [{ collection: "(none)", matched: 0 }];
  }

  const baseFilter = { merchantId, ...(orMatches.length > 0 ? { $or: orMatches } : {}) };

  // --- Order ---
  // Pseudonymise customer + delivery details. Keep merchant-owned
  // metadata (totals, status, courier history). If Shopify named
  // explicit orderIds, fold them into the match.
  const orderFilter = identifiers.orderIds && identifiers.orderIds.length > 0
    ? {
        merchantId,
        $or: [
          ...orMatches,
          { _id: { $in: identifiers.orderIds.filter(Types.ObjectId.isValid).map((id) => new Types.ObjectId(id)) } },
          { externalOrderId: { $in: identifiers.orderIds } },
        ],
      }
    : baseFilter;
  const orderUpdate = await Order.updateMany(orderFilter, {
    $set: {
      "customer.name": REDACTED,
      "customer.phone": REDACTED,
      "customer.address": REDACTED,
      "customer.email": REDACTED,
      // The shipping snapshot mirrors customer fields when present.
      "shipping.name": REDACTED,
      "shipping.phone": REDACTED,
      "shipping.address": REDACTED,
    },
  });
  results.push({ collection: "Order", redacted: orderUpdate.modifiedCount });

  // --- CallLog ---
  // Customer-facing field set. Drop name + phone, keep call duration
  // / outcome / agent for merchant operational analytics.
  const callUpdate = await CallLog.updateMany(baseFilter, {
    $set: {
      customerName: REDACTED,
      customerPhone: REDACTED,
    },
  });
  results.push({ collection: "CallLog", redacted: callUpdate.modifiedCount });

  // --- RecoveryTask ---
  // Phone + email are the whole point of the row (outreach target).
  // Once redacted the row is operationally useless; safest to
  // hard-delete instead of leaving a husk.
  const recoveryDelete = await RecoveryTask.deleteMany(baseFilter);
  results.push({ collection: "RecoveryTask", deleted: recoveryDelete.deletedCount });

  // --- TrackingSession ---
  // Same logic as RecoveryTask — identity-pivoted row.
  const trackingDelete = await TrackingSession.deleteMany(baseFilter);
  results.push({ collection: "TrackingSession", deleted: trackingDelete.deletedCount });

  // --- WebhookInbox ---
  // Raw webhook bodies often embed customer PII as JSON. Easier (and
  // safer) to delete the inbox rows that touch this customer than to
  // surgically rewrite the payloads. We match by externalId or by
  // scanning the resolvedOrderId — webhook payload itself isn't
  // indexed by customer fields.
  const inboxOrMatches: Record<string, unknown>[] = [];
  if (identifiers.orderIds && identifiers.orderIds.length > 0) {
    const oids = identifiers.orderIds
      .filter(Types.ObjectId.isValid)
      .map((id) => new Types.ObjectId(id));
    if (oids.length > 0) {
      inboxOrMatches.push({ resolvedOrderId: { $in: oids } });
    }
  }
  if (inboxOrMatches.length > 0) {
    const inboxDelete = await WebhookInbox.deleteMany({
      merchantId,
      $or: inboxOrMatches,
    });
    results.push({ collection: "WebhookInbox", deleted: inboxDelete.deletedCount });
  } else {
    results.push({ collection: "WebhookInbox", deleted: 0 });
  }

  // --- AuditLog ---
  // Audit rows record historical actions ("operator called +880..."),
  // some of which embed PII in the meta blob. Strip the meta from
  // any row whose subjectType is order AND subjectId is in our
  // matched-orders set. We DON'T delete the audit row itself — the
  // row's existence (action + timestamp + actor) is itself a
  // compliance record; the PII inside meta is what we redact.
  if (orderFilter !== baseFilter) {
    const matchedOrderIds = await Order.find(orderFilter).distinct("_id");
    if (matchedOrderIds.length > 0) {
      const auditUpdate = await AuditLog.updateMany(
        {
          merchantId,
          subjectType: "order",
          subjectId: { $in: matchedOrderIds },
        },
        { $set: { meta: { redacted: true, reason: "customers/redact" } } },
      );
      results.push({ collection: "AuditLog", redacted: auditUpdate.modifiedCount });
    } else {
      results.push({ collection: "AuditLog", redacted: 0 });
    }
  }

  return results;
}

/**
 * Hard-delete every row tied to a merchant. Triggered by `shop/redact`
 * (48h after the merchant uninstalled). Returns one row per touched
 * collection. ORDER MATTERS: child rows (audit, fraud signal, webhook
 * inbox) before parent rows (order, integration), so cascading
 * lookups don't dangle.
 */
export async function redactShop(args: {
  merchantId: Types.ObjectId;
}): Promise<RedactionResult[]> {
  const { merchantId } = args;
  const results: RedactionResult[] = [];
  const filter = { merchantId };

  // Each Model has a slightly different InferSchema-derived generic, so
  // the array literal narrows `model` into a giant Model<T1>|Model<T2>|…
  // union whose `deleteMany` overloads no longer share a callable
  // signature. Widen to `Model<unknown>` for the loop — every Mongoose
  // model exposes the same `deleteMany(filter)` shape we rely on here.
  type AnyModel = { deleteMany: (filter: unknown) => Promise<{ deletedCount?: number }> };
  const targets: ReadonlyArray<readonly [string, AnyModel]> = [
    ["AuditLog", AuditLog as unknown as AnyModel],
    ["CallLog", CallLog as unknown as AnyModel],
    ["Notification", Notification as unknown as AnyModel],
    ["Payment", Payment as unknown as AnyModel],
    ["RecoveryTask", RecoveryTask as unknown as AnyModel],
    ["TrackingEvent", TrackingEvent as unknown as AnyModel],
    ["TrackingSession", TrackingSession as unknown as AnyModel],
    ["WebhookInbox", WebhookInbox as unknown as AnyModel],
    ["FraudSignal", FraudSignal as unknown as AnyModel],
    ["FraudPrediction", FraudPrediction as unknown as AnyModel],
    ["MerchantStats", MerchantStats as unknown as AnyModel],
    ["Order", Order as unknown as AnyModel],
    ["Integration", Integration as unknown as AnyModel],
  ];
  for (const [name, model] of targets) {
    const r = await model.deleteMany(filter);
    results.push({ collection: name, deleted: r.deletedCount });
  }

  // NOTE: Merchant doc itself is intentionally NOT deleted by this
  // sweep. Shopify's contract is to remove customer + shop data; the
  // merchant's billing history, plan, and account email may be
  // legitimately retained for our own tax / audit obligations.
  // Escalate to a separate "delete account" flow if the merchant
  // explicitly asks.

  return results;
}
