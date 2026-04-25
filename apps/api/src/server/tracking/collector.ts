import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { LRUCache } from "lru-cache";
import {
  Merchant,
  TrackingEvent,
  TrackingSession,
  TRACKING_EVENT_TYPES,
  type TrackingEventType,
} from "@ecom/db";
import { resolveIdentityForOrder } from "../ingest.js";
import { Order } from "@ecom/db";

/**
 * Behavior collector. Public endpoint hit by the storefront SDK with a
 * tracking key (resolves to merchantId server-side). Idempotent on
 * `(merchantId, sessionId, clientEventId)` — replays from a flaky network
 * never duplicate-count.
 *
 * Trust boundary: never trusts client-supplied IP/UA — we read them from the
 * request. PII (phone/email) is accepted only on identify/checkout_submit
 * events, and lower-cased + size-capped.
 *
 * Rate-limiting at the SDK is handled by the existing `globalLimiter`
 * mounted at /trpc — we keep this collector under a tighter cap (250
 * requests/min/IP) to absorb storefront bursts without falling over.
 */
export const trackingRouter = express.Router();

const MAX_BATCH = 50;
const MAX_PROPERTY_BYTES = 8 * 1024;

// Tracking-key → merchantId lookup. Keys are stable and hot — cache aggressively.
const keyCache = new LRUCache<string, string>({ max: 5_000, ttl: 5 * 60_000 });

// Coarse per-IP rate limiter (250 reqs/min/IP, sliding 60s buckets). This is
// distinct from the global tRPC limiter — collector traffic is multi-tenant
// and we don't want a noisy storefront to starve the API path.
const ipBuckets = new LRUCache<string, { count: number; resetAt: number }>({
  max: 50_000,
  ttl: 5 * 60_000,
});

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const existing = ipBuckets.get(ip);
  if (!existing || existing.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 250;
}

async function resolveMerchantIdFromKey(key: string): Promise<string | null> {
  if (!key || key.length < 8) return null;
  const cached = keyCache.get(key);
  if (cached) return cached;
  const m = await Merchant.findOne({ trackingKey: key }).select("_id").lean();
  if (!m) return null;
  const id = String(m._id);
  keyCache.set(key, id);
  return id;
}

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, max);
}

function safeProps(props: unknown): Record<string, unknown> {
  if (!props || typeof props !== "object") return {};
  try {
    const json = JSON.stringify(props);
    if (json.length > MAX_PROPERTY_BYTES) return {};
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function emailHash(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32);
}

interface IncomingEvent {
  type: TrackingEventType;
  clientEventId?: string;
  sessionId: string;
  anonId?: string;
  url?: string;
  path?: string;
  referrer?: string;
  campaign?: { source?: string; medium?: string; name?: string; term?: string; content?: string };
  device?: { type?: string; os?: string; browser?: string; viewport?: string; language?: string };
  properties?: Record<string, unknown>;
  phone?: string;
  email?: string;
  occurredAt?: string;
  repeatVisitor?: boolean;
}

trackingRouter.post(
  "/collect",
  express.json({ limit: "256kb" }),
  async (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";
    if (!rateLimitOk(ip)) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    const body = req.body as { trackingKey?: string; events?: IncomingEvent[] };
    if (!body || typeof body !== "object" || !body.trackingKey) {
      return res.status(400).json({ ok: false, error: "missing trackingKey" });
    }
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length === 0) {
      return res.json({ ok: true, accepted: 0 });
    }
    if (events.length > MAX_BATCH) {
      return res.status(413).json({ ok: false, error: "batch too large" });
    }

    const merchantId = await resolveMerchantIdFromKey(body.trackingKey);
    if (!merchantId) {
      return res.status(401).json({ ok: false, error: "unknown tracking key" });
    }
    const merchantOid = new Types.ObjectId(merchantId);
    const ua = clamp(req.headers["user-agent"], 500);
    const docs: Record<string, unknown>[] = [];

    let identityPhone: string | undefined;
    let identityEmail: string | undefined;
    let firstAt: Date | null = null;
    let lastAt: Date | null = null;

    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      if (!TRACKING_EVENT_TYPES.includes(ev.type)) continue;
      if (typeof ev.sessionId !== "string" || ev.sessionId.length < 6) continue;

      const occurredAt = ev.occurredAt ? new Date(ev.occurredAt) : new Date();
      if (Number.isNaN(occurredAt.getTime())) continue;
      // Reject far-future / ancient timestamps to defend against clock manipulation.
      const skew = Math.abs(Date.now() - occurredAt.getTime());
      if (skew > 24 * 60 * 60 * 1000) continue;

      if (firstAt === null || occurredAt < firstAt) firstAt = occurredAt;
      if (lastAt === null || occurredAt > lastAt) lastAt = occurredAt;

      const phone = clamp(ev.phone, 32);
      const email = clamp(ev.email, 200)?.toLowerCase();
      if (phone) identityPhone = phone;
      if (email) identityEmail = email;

      docs.push({
        merchantId: merchantOid,
        sessionId: ev.sessionId.slice(0, 64),
        anonId: clamp(ev.anonId, 64),
        type: ev.type,
        clientEventId: clamp(ev.clientEventId, 64),
        url: clamp(ev.url, 1000),
        path: clamp(ev.path, 500),
        referrer: clamp(ev.referrer, 1000),
        campaign: ev.campaign
          ? {
              source: clamp(ev.campaign.source, 80),
              medium: clamp(ev.campaign.medium, 80),
              name: clamp(ev.campaign.name, 200),
              term: clamp(ev.campaign.term, 120),
              content: clamp(ev.campaign.content, 200),
            }
          : undefined,
        device: ev.device
          ? {
              type: clamp(ev.device.type, 30),
              os: clamp(ev.device.os, 60),
              browser: clamp(ev.device.browser, 60),
              viewport: clamp(ev.device.viewport, 40),
              language: clamp(ev.device.language, 20),
            }
          : undefined,
        properties: safeProps(ev.properties),
        phone,
        email,
        ip,
        userAgent: ua,
        occurredAt,
        receivedAt: new Date(),
      });
    }

    if (docs.length === 0) {
      return res.json({ ok: true, accepted: 0 });
    }

    try {
      await TrackingEvent.insertMany(docs, { ordered: false });
    } catch (err: unknown) {
      const e = err as { code?: number };
      // Duplicate clientEventIds (retries) hit our unique index — that's the
      // happy path for idempotency. Anything else we log and continue.
      if (e?.code !== 11000) {
        console.error("[tracker] insert failed", (err as Error).message);
      }
    }

    // Update the session aggregate. One upsert per session — keeps the
    // collector path roughly O(events / sessions-per-batch).
    const session = events[0]!;
    if (session && firstAt && lastAt) {
      const repeatVisitor = events.some((e) => e?.repeatVisitor) || false;
      const landingPath = clamp(session.path, 500);
      const referrer = clamp(session.referrer, 1000);
      const campaign = session.campaign
        ? {
            source: clamp(session.campaign.source, 80),
            medium: clamp(session.campaign.medium, 80),
            name: clamp(session.campaign.name, 200),
          }
        : undefined;
      const device = session.device
        ? {
            type: clamp(session.device.type, 30),
            os: clamp(session.device.os, 60),
            browser: clamp(session.device.browser, 60),
          }
        : undefined;

      const counts = countEvents(events);
      const update: Record<string, unknown> = {
        $setOnInsert: {
          merchantId: merchantOid,
          sessionId: session.sessionId.slice(0, 64),
          firstSeenAt: firstAt,
          landingPath,
          referrer,
          campaign,
          device,
          anonId: clamp(session.anonId, 64),
        },
        $inc: {
          pageViews: counts.page_view,
          productViews: counts.product_view,
          addToCartCount: counts.add_to_cart,
          checkoutStartCount: counts.checkout_start,
          checkoutSubmitCount: counts.checkout_submit,
          clickCount: counts.click,
        },
        $max: {
          lastSeenAt: lastAt,
          maxScrollDepth: counts.maxScroll,
        },
        $set: {
          repeatVisitor,
          ...(identityPhone ? { phone: identityPhone } : {}),
          ...(identityEmail ? { email: identityEmail, customerHash: emailHash(identityEmail) } : {}),
          ...(counts.checkout_submit > 0 ? { converted: true } : {}),
          ...(counts.add_to_cart >= 2 && counts.checkout_submit === 0
            ? { abandonedCart: true }
            : {}),
        },
      };

      await TrackingSession.updateOne(
        { merchantId: merchantOid, sessionId: session.sessionId.slice(0, 64) },
        update,
        { upsert: true },
      );

      // Refresh durationMs as a separate pass — needs the firstSeenAt that
      // may have just been upserted.
      await TrackingSession.updateOne(
        { merchantId: merchantOid, sessionId: session.sessionId.slice(0, 64) },
        [
          {
            $set: {
              durationMs: {
                $max: [
                  0,
                  { $subtract: ["$lastSeenAt", "$firstSeenAt"] },
                ],
              },
            },
          },
        ],
      );
    }

    // If the merchant has an open order with this phone/email created in the
    // last 30 days that doesn't yet point to this session, stitch backwards.
    if ((identityPhone || identityEmail) && session?.sessionId) {
      stitchExistingOrder({
        merchantId: merchantOid,
        sessionId: session.sessionId,
        phone: identityPhone,
        email: identityEmail,
      }).catch((err) => console.error("[tracker] back-stitch failed", err));
    }

    return res.json({ ok: true, accepted: docs.length });
  },
);

interface EventCounts {
  page_view: number;
  product_view: number;
  add_to_cart: number;
  checkout_start: number;
  checkout_submit: number;
  click: number;
  maxScroll: number;
}

function countEvents(events: IncomingEvent[]): EventCounts {
  const counts: EventCounts = {
    page_view: 0,
    product_view: 0,
    add_to_cart: 0,
    checkout_start: 0,
    checkout_submit: 0,
    click: 0,
    maxScroll: 0,
  };
  for (const ev of events) {
    if (!ev?.type) continue;
    switch (ev.type) {
      case "page_view":
        counts.page_view += 1;
        break;
      case "product_view":
        counts.product_view += 1;
        break;
      case "add_to_cart":
        counts.add_to_cart += 1;
        break;
      case "checkout_start":
        counts.checkout_start += 1;
        break;
      case "checkout_submit":
        counts.checkout_submit += 1;
        break;
      case "click":
        counts.click += 1;
        break;
      case "scroll": {
        const depth = Number((ev.properties as { depth?: number } | undefined)?.depth ?? 0);
        if (depth > counts.maxScroll) counts.maxScroll = Math.min(100, depth);
        break;
      }
    }
  }
  return counts;
}

async function stitchExistingOrder(args: {
  merchantId: Types.ObjectId;
  sessionId: string;
  phone?: string;
  email?: string;
}): Promise<void> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filter: Record<string, unknown> = {
    merchantId: args.merchantId,
    createdAt: { $gte: since },
  };
  if (args.phone) {
    filter["customer.phone"] = args.phone;
  } else if (args.email) {
    filter["source.customerEmail"] = args.email;
  } else {
    return;
  }
  const order = await Order.findOne(filter)
    .sort({ createdAt: -1 })
    .select("_id customer.phone source.customerEmail")
    .lean();
  if (!order) return;
  await resolveIdentityForOrder({
    merchantId: args.merchantId,
    orderId: order._id,
    phone: args.phone,
    email: args.email,
  });
}

/**
 * Generate-on-read tracking key for the merchant. Idempotent — once minted,
 * the same key is reused. Returns the public-safe identifier embedded in the
 * SDK script tag.
 */
export async function ensureTrackingKey(merchantId: Types.ObjectId): Promise<string> {
  const existing = await Merchant.findById(merchantId).select("trackingKey").lean();
  if (existing?.trackingKey) return existing.trackingKey;
  const key = `pub_${randomBytes(20).toString("base64url")}`;
  await Merchant.updateOne(
    { _id: merchantId, trackingKey: { $exists: false } },
    { $set: { trackingKey: key } },
  );
  // Re-read in case another request raced.
  const fresh = await Merchant.findById(merchantId).select("trackingKey").lean();
  return fresh?.trackingKey ?? key;
}
