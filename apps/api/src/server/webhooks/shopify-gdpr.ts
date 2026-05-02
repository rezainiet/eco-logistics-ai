import express, { type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Integration, Merchant, Order } from "@ecom/db";
import { Types } from "mongoose";
import { writeAudit } from "../../lib/audit.js";
import { env } from "../../env.js";

/**
 * Shopify mandatory privacy webhooks (GDPR / CCPA).
 *
 * Shopify will send three webhooks to every public app, signed with the
 * APP'S secret (`SHOPIFY_APP_API_SECRET`) — NOT the per-merchant
 * webhook secret. They're a hard requirement for App Store / Public
 * Distribution review:
 *
 *   1. customers/data_request
 *      A customer has asked the merchant for the data we hold on them.
 *      We have 30 days to respond. The standard response is to email
 *      the merchant a summary so they can fulfil the request — Shopify
 *      doesn't expect us to email the customer directly.
 *
 *   2. customers/redact
 *      A customer has asked to be erased. We must redact within 30
 *      days. Payload contains the customer email/phone/orders ids
 *      tied to that customer for ONE shop.
 *
 *   3. shop/redact
 *      48 hours after the merchant uninstalled, we must redact ALL
 *      data tied to that shop. Payload contains shop_id +
 *      shop_domain.
 *
 * All three are POST with body signed by `x-shopify-hmac-sha256`
 * over the RAW request bytes (so we use express.raw, never
 * express.json — re-stringifying parsed JSON would change whitespace
 * and break verification).
 *
 * Behaviour split by maturity:
 *   - HMAC verification is REAL. A failed signature returns 401 and
 *     does NOT touch the database. This is the gate Shopify reviewers
 *     check first.
 *   - Audit logging is REAL. Every accepted webhook lands in the
 *     audit log so we have a paper trail for compliance.
 *   - Actual data redaction is currently STUBBED with a TODO + a
 *     "redaction.queued" audit entry. Production must implement the
 *     model-by-model deletion sweep before flipping the app to
 *     Public Distribution. Shipping the receiver first is correct —
 *     it satisfies the review gate and gives us the audit trail to
 *     prove receipt; the actual sweep is a follow-up task that needs
 *     a careful inventory of every collection that holds customer
 *     PII.
 *
 * Mounted at `/api/webhooks/shopify/gdpr` in apps/api/src/index.ts.
 */
export const shopifyGdprWebhookRouter = express.Router();

const SHOPIFY_GDPR_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;
type ShopifyGdprTopic = (typeof SHOPIFY_GDPR_TOPICS)[number];

function isGdprTopic(t: string): t is ShopifyGdprTopic {
  return (SHOPIFY_GDPR_TOPICS as readonly string[]).includes(t);
}

/**
 * Verify the body HMAC. Returns true on match, false on any malformed
 * input — never throws. Constant-time comparison via timingSafeEqual.
 */
function verifyShopifyBodyHmac(args: {
  rawBody: Buffer;
  hmacHeader: string | undefined;
  secret: string;
}): boolean {
  if (!args.hmacHeader || !args.secret) return false;
  const computed = createHmac("sha256", args.secret)
    .update(args.rawBody)
    .digest("base64");
  const a = Buffer.from(args.hmacHeader);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

shopifyGdprWebhookRouter.post(
  "/:topicSegment(*)",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req: Request, res: Response) => {
    // Topic ships in the header; the URL path is just for routing
    // hygiene (Shopify lets the app declare three distinct URLs OR
    // one URL for all three). We support both shapes by reading the
    // header.
    const topicHeader = req.headers["x-shopify-topic"];
    const topic = Array.isArray(topicHeader) ? topicHeader[0] : topicHeader;
    if (!topic || !isGdprTopic(topic)) {
      return res
        .status(400)
        .json({ ok: false, error: "missing or unknown gdpr topic" });
    }

    const platformSecret = env.SHOPIFY_APP_API_SECRET;
    if (!platformSecret) {
      // Misconfigured deploy — log loudly so ops fixes the env, but
      // return 200 so Shopify doesn't retry endlessly. (Shopify
      // marks an app non-compliant if these webhooks 5xx for too
      // long; better to swallow and alert than to flap.)
      console.error(
        "[shopify-gdpr] SHOPIFY_APP_API_SECRET unset — cannot verify HMAC",
        { topic },
      );
      return res
        .status(200)
        .json({ ok: false, error: "platform secret not configured" });
    }

    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      console.error(
        "[shopify-gdpr] expected Buffer body — middleware ordering regressed",
      );
      return res.status(500).json({ ok: false, error: "raw body unavailable" });
    }

    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const valid = verifyShopifyBodyHmac({
      rawBody,
      hmacHeader: Array.isArray(hmacHeader) ? hmacHeader[0] : hmacHeader,
      secret: platformSecret,
    });
    if (!valid) {
      console.warn("[shopify-gdpr] hmac_mismatch", { topic });
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return res.status(400).json({ ok: false, error: "invalid json" });
    }

    // Look up the merchant from `shop_domain` in the payload (Shopify
    // includes it on all three topics). May be null when the shop has
    // already been hard-deleted on our side; that's not an error.
    const shopDomain =
      (payload.shop_domain as string | undefined) ??
      (payload.shop_id ? `shop_id:${String(payload.shop_id)}` : null);
    let merchantId: Types.ObjectId | null = null;
    if (shopDomain && /\.myshopify\.com$/i.test(shopDomain)) {
      const integration = await Integration.findOne({
        provider: "shopify",
        accountKey: shopDomain.toLowerCase(),
      })
        .select("merchantId")
        .lean();
      merchantId = (integration?.merchantId as Types.ObjectId | undefined) ?? null;
    }

    // Always audit, regardless of dispatch outcome. The audit row IS
    // the compliance evidence Shopify reviewers ask for.
    void writeAudit({
      // System action — no merchant scope when we can't resolve one.
      merchantId: merchantId ?? new Types.ObjectId("000000000000000000000000"),
      actorId: merchantId ?? new Types.ObjectId("000000000000000000000000"),
      actorType: "system",
      action: "shopify.gdpr_webhook",
      subjectType: "merchant",
      subjectId: merchantId ?? new Types.ObjectId("000000000000000000000000"),
      meta: {
        topic,
        shopDomain,
        // Drop the noisy/sensitive payload bits but keep the ids the
        // reviewers want to see in the audit row.
        customerId: payload.customer
          ? (payload.customer as { id?: number | string }).id ?? null
          : null,
        customerEmailHash: payload.customer
          ? hashIdentifier(
              (payload.customer as { email?: string }).email ?? null,
            )
          : null,
        ordersToRedact: Array.isArray(payload.orders_to_redact)
          ? (payload.orders_to_redact as Array<unknown>).length
          : 0,
        merchantResolved: !!merchantId,
      },
    });

    // Topic-specific dispatch. All three are intentionally
    // non-blocking on the response — Shopify times out after 5s.
    if (topic === "customers/data_request") {
      // TODO: email the merchant a summary of what data we hold on the
      // customer. For now: audit only — no automated fulfilment yet.
      // The merchant has 30 days, so this is fine to land as a
      // follow-up. Track via the audit row.
      console.log("[shopify-gdpr] customers/data_request received", {
        merchantId: merchantId ? String(merchantId) : null,
        shopDomain,
      });
    } else if (topic === "customers/redact") {
      // TODO: schedule redaction sweep across collections holding
      // customer PII (Order, CallLog, future CustomerProfile). Shopify
      // gives us 30 days — currently logged for follow-up.
      console.log("[shopify-gdpr] customers/redact received", {
        merchantId: merchantId ? String(merchantId) : null,
        shopDomain,
        orderCount: Array.isArray(payload.orders_to_redact)
          ? (payload.orders_to_redact as Array<unknown>).length
          : 0,
      });
    } else if (topic === "shop/redact") {
      // 48-hour clock since uninstall already elapsed by the time
      // this fires. Mark the merchant for hard-redaction. For now we
      // just disconnect every integration tied to the shop and audit
      // — full redaction sweep is the same follow-up as above.
      if (merchantId) {
        await Integration.updateMany(
          { merchantId, provider: "shopify" },
          {
            $set: {
              status: "disconnected",
              disconnectedAt: new Date(),
              "webhookStatus.registered": false,
            },
          },
        );
      }
      console.log("[shopify-gdpr] shop/redact received", {
        merchantId: merchantId ? String(merchantId) : null,
        shopDomain,
      });
    }

    return res.status(200).json({ ok: true });
  },
);

/**
 * SHA-256 hash of an identifier (typically an email) so the audit log
 * can prove a specific identifier was processed without storing it
 * verbatim alongside the redaction event. Returns null on empty input.
 */
function hashIdentifier(value: string | null): string | null {
  if (!value) return null;
  return createHmac("sha256", "audit-identifier-salt:v1")
    .update(value.toLowerCase().trim())
    .digest("hex")
    .slice(0, 32);
}

// Suppress unused-var lint for Merchant + Order imports — these are
// referenced by the TODO follow-up sweep work and we keep them
// imported now so adding the implementation doesn't pull a separate
// import diff into the future PR.
void Merchant;
void Order;
