import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { EmailEvent, EmailSuppression } from "@ecom/db";
import { env } from "../../env.js";

/**
 * Resend webhook receiver.
 *
 * Mounted at `/api/webhooks/resend`. Resend signs events using the Svix
 * webhook spec; the secret is base64 after the `whsec_` prefix. We verify
 * the signature, parse the event, persist it to `EmailEvent` (idempotent
 * via `svix-id`), and on suppression-worthy events upsert a row in
 * `EmailSuppression` so future `sendEmail()` calls short-circuit before
 * hitting the provider.
 *
 * Hard-disable when `RESEND_WEBHOOK_SECRET` is unset — we'd rather Resend
 * see 503 + retry than silently accept unsigned traffic. Matches the
 * Stripe webhook posture in `stripe.ts`.
 *
 * Idempotency boundary: the unique index on `EmailEvent.eventId` (the
 * Svix event id). A retry produces a duplicate-key error which we map
 * to 200 + `{ duplicate: true }`. Resend sees success; we don't
 * re-process. The handler is therefore safe under Svix's retry budget
 * (~24h with exponential backoff per their docs).
 *
 * Logging shape: every code path emits one structured JSON line. Filter
 * downstream by the `evt` field. Recipient addresses are masked in
 * log lines — full addresses live only in Mongo behind the
 * `EmailEvent`/`EmailSuppression` collections.
 */
export const resendWebhookRouter = express.Router();

interface ResendEventEnvelope {
  /** e.g. "email.delivered", "email.bounced". */
  type?: string;
  /** ISO timestamp from Resend (informational; we trust svix-timestamp). */
  created_at?: string;
  data?: ResendEventData;
}

interface ResendEventData {
  /** Resend's message id (also exposed via the `id` field returned from POST /emails). */
  email_id?: string;
  from?: string;
  /** Always an array in Resend payloads, even for single-recipient sends. */
  to?: string[];
  subject?: string;
  /** Our pass-through tags. We send one with name="type" and value=<flow tag>. */
  tags?: Array<{ name: string; value: string }>;
  /** Present on bounce events. */
  bounce?: {
    type?: string;
    message?: string;
    [k: string]: unknown;
  };
  /** Present on complaint events. */
  complaint?: {
    type?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

interface VerifyOk {
  ok: true;
  timestampMs: number;
}
interface VerifyErr {
  ok: false;
  reason: string;
}

/**
 * Svix HMAC verification. Implements the documented algorithm without
 * pulling the `svix` npm package — the spec is small and the codebase
 * already verifies Stripe HMACs by hand in `lib/stripe.ts`.
 *
 *   signed_payload = `${svix-id}.${svix-timestamp}.${body}`
 *   expected       = base64(HMAC-SHA256(secret_bytes, signed_payload))
 *   header         = "v1,<sig> v1,<sig2>"          (space-separated, supports rotation)
 *
 * The secret arrives as `whsec_<base64>`. We strip the prefix, base64-
 * decode the rest, and use the raw bytes as the HMAC key. Timestamp
 * tolerance is 5 minutes (Svix's documented default).
 */
function verifySvixWebhook(args: {
  headers: SvixHeaders;
  rawBody: string;
  secret: string;
  toleranceSeconds?: number;
}): VerifyOk | VerifyErr {
  if (!args.headers.id) return { ok: false, reason: "missing_svix_id" };
  if (!args.headers.timestamp) return { ok: false, reason: "missing_svix_timestamp" };
  if (!args.headers.signature) return { ok: false, reason: "missing_svix_signature" };

  const t = Number(args.headers.timestamp);
  if (!Number.isFinite(t)) return { ok: false, reason: "invalid_svix_timestamp" };
  const tolerance = args.toleranceSeconds ?? 300;
  const ageSeconds = Math.abs(Date.now() / 1000 - t);
  if (ageSeconds > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const secretBody = args.secret.startsWith("whsec_")
    ? args.secret.slice("whsec_".length)
    : args.secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretBody, "base64");
    if (secretBytes.length === 0) {
      return { ok: false, reason: "invalid_secret_encoding" };
    }
  } catch {
    return { ok: false, reason: "invalid_secret_encoding" };
  }

  const signedPayload = `${args.headers.id}.${args.headers.timestamp}.${args.rawBody}`;
  const expected = createHmac("sha256", secretBytes)
    .update(signedPayload)
    .digest("base64");

  // Header may carry multiple `v1,<sig>` pairs (space-separated) for
  // secret-rotation windows. Match any of them in constant time.
  const sigs = args.headers.signature
    .split(" ")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const s of sigs) {
    const commaAt = s.indexOf(",");
    if (commaAt < 0) continue;
    const version = s.slice(0, commaAt);
    const sig = s.slice(commaAt + 1);
    if (version !== "v1" || !sig) continue;
    if (sig.length !== expected.length) continue;
    try {
      if (timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return { ok: true, timestampMs: t * 1000 };
      }
    } catch {
      // Different-length buffers reach here on Node's strict variant —
      // already guarded by the length check above, but be defensive.
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

/** First 2 chars of local-part + `***@domain`. Keeps logs auditable
 *  without leaking inboxes into log aggregation. */
function maskEmail(addr: string | undefined): string {
  if (!addr) return "***";
  const at = addr.indexOf("@");
  if (at <= 0) return "***";
  return `${addr.slice(0, Math.min(2, at))}***${addr.slice(at)}`;
}

function findTagValue(
  tags: ResendEventData["tags"] | undefined,
  name: string,
): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const t of tags) {
    if (t && t.name === name && typeof t.value === "string") return t.value;
  }
  return undefined;
}

interface DispatchResult {
  ok: true;
  duplicate?: boolean;
  type?: string;
  suppressed?: boolean;
}

async function processResendEvent(
  svixId: string,
  evt: ResendEventEnvelope,
): Promise<DispatchResult> {
  const type = typeof evt.type === "string" ? evt.type : "other";
  const data = evt.data ?? {};
  const to = Array.isArray(data.to) ? data.to[0] : undefined;
  const tagValue = findTagValue(data.tags, "type");
  const correlationId = findTagValue(data.tags, "cid");
  const bounceType =
    typeof data.bounce?.type === "string" ? data.bounce.type : undefined;
  const bounceMessage =
    typeof data.bounce?.message === "string" ? data.bounce.message : undefined;

  // 1. Persist the event row. Unique on eventId → duplicate-key on
  //    Svix retry, which we surface as 200 + duplicate=true.
  try {
    await EmailEvent.create({
      eventId: svixId,
      type,
      to: (to ?? "").toLowerCase().trim(),
      subject: typeof data.subject === "string" ? data.subject.slice(0, 200) : undefined,
      tag: tagValue,
      correlationId,
      providerId: typeof data.email_id === "string" ? data.email_id : undefined,
      bounceType,
      bounceMessage: bounceMessage?.slice(0, 500),
      payload: evt,
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) {
      console.log(
        JSON.stringify({
          evt: "email.webhook.duplicate",
          svixId,
          type,
        }),
      );
      return { ok: true, duplicate: true, type };
    }
    throw err;
  }

  console.log(
    JSON.stringify({
      evt: "email.webhook.received",
      svixId,
      type,
      to: maskEmail(to),
      tag: tagValue,
      cid: correlationId,
      providerId: typeof data.email_id === "string" ? data.email_id : undefined,
      bounceType,
    }),
  );

  // 2. Suppression rules. Hard bounce or complaint → durable suppress.
  //    Soft bounces, delays, opens, clicks, sent, delivered all flow
  //    through to the event row but don't gate future sends.
  let suppressed = false;
  if (to) {
    const lowered = to.toLowerCase().trim();
    if (type === "email.bounced" && bounceType === "hard") {
      await upsertSuppression({
        address: lowered,
        reason: "bounce_hard",
        eventId: svixId,
        bounceType,
        diagnostic: bounceMessage,
        payload: evt,
      });
      suppressed = true;
    } else if (type === "email.complained") {
      await upsertSuppression({
        address: lowered,
        reason: "complaint",
        eventId: svixId,
        bounceType: undefined,
        diagnostic: undefined,
        payload: evt,
      });
      suppressed = true;
    }
  }

  return { ok: true, type, suppressed };
}

async function upsertSuppression(args: {
  address: string;
  reason: "bounce_hard" | "complaint";
  eventId: string;
  bounceType: string | undefined;
  diagnostic: string | undefined;
  payload: unknown;
}): Promise<void> {
  const now = new Date();
  const updated = await EmailSuppression.findOneAndUpdate(
    { address: args.address },
    {
      $setOnInsert: {
        address: args.address,
        reason: args.reason,
        eventId: args.eventId,
        bounceType: args.bounceType,
        diagnostic: args.diagnostic?.slice(0, 500),
        payload: args.payload,
        firstSeenAt: now,
      },
      $set: { lastSeenAt: now },
      $inc: { count: 1 },
    },
    { upsert: true, new: true },
  )
    .select("_id reason firstSeenAt count")
    .lean();

  console.warn(
    JSON.stringify({
      evt: "email.suppression.upserted",
      address: maskEmail(args.address),
      reason: args.reason,
      eventId: args.eventId,
      count: (updated as { count?: number } | null)?.count ?? 1,
    }),
  );
}

resendWebhookRouter.post(
  "/",
  express.raw({ type: "*/*", limit: "256kb" }),
  async (req: Request, res: Response) => {
    if (!env.RESEND_WEBHOOK_SECRET) {
      // Hard refuse — never accept unsigned traffic on this endpoint.
      // Resend will retry; operator will see the 503 and configure the
      // secret in Railway. Same posture as the Stripe webhook.
      return res.status(503).json({ ok: false, error: "resend_webhook_disabled" });
    }

    const rawBuf = req.body as Buffer;
    const rawString = rawBuf.toString("utf8");

    const svixId = req.header("svix-id") ?? undefined;
    const svixTimestamp = req.header("svix-timestamp") ?? undefined;
    const svixSignature = req.header("svix-signature") ?? undefined;

    const verdict = verifySvixWebhook({
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      rawBody: rawString,
      secret: env.RESEND_WEBHOOK_SECRET,
    });
    if (!verdict.ok) {
      console.warn(
        JSON.stringify({
          evt: "email.webhook.rejected",
          reason: verdict.reason,
          svixId,
        }),
      );
      return res.status(401).json({ ok: false, error: verdict.reason });
    }

    let event: ResendEventEnvelope;
    try {
      event = JSON.parse(rawString) as ResendEventEnvelope;
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_json" });
    }
    if (!event || typeof event.type !== "string") {
      return res.status(400).json({ ok: false, error: "missing_event_type" });
    }

    try {
      const result = await processResendEvent(svixId!, event);
      return res.status(200).json(result);
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "email.webhook.handler_threw",
          svixId,
          type: event.type,
          error: (err as Error).message?.slice(0, 500),
        }),
      );
      // 500 → Svix retries with exponential backoff. The event row was
      // either committed (handler threw downstream) or not (Mongo refused),
      // so a retry is safe either way.
      return res.status(500).json({ ok: false, error: "handler_threw" });
    }
  },
);

// Exported for unit testing without going through Express.
export const __TEST = { verifySvixWebhook, processResendEvent, maskEmail };
