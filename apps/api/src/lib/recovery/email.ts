import { Types } from "mongoose";
import { Merchant, Order, RecoveryTask, TrackingSession } from "@ecom/db";
import {
  EMAIL_NOT_CONFIGURED,
  buildCartRecoveryEmail,
  emailSuppressionFor,
  sendEmail,
  type EmailDeliveryResult,
  type EmailMessage,
} from "../email.js";
import { resolvePublishedForOrder } from "../landing/resolve.js";
import { publicUrlFor } from "../landing/pages.js";
import { phoneLookupVariants } from "../phone.js";
import { writeAudit } from "../audit.js";
import { availableRecoveryLines, landingCartSnapshot } from "./landing.js";
import { deriveRecoveryToken, hashRecoveryToken, newTokenNonce } from "./token.js";

/**
 * Automatic cart-recovery email — one per abandoned landing-page cart.
 *
 * Runs inside the existing cart-recovery sweep, for merchants the sweep has
 * already found entitled (plan + billable subscription). A task is emailed
 * once, after a delay, and only while it is still pending (an agent who
 * already acted, a dismissed or expired task, or a recovered one is never
 * emailed).
 *
 * Exactly-once, as far as a mail provider allows:
 *   1. claim  — one atomic update moves the task to `sending` (with a lock
 *               deadline); a concurrent sweep's claim matches nothing.
 *   2. send   — with a provider idempotency key derived from the task, so a
 *               retry after a crash between "sent" and "recorded" is answered
 *               from the provider's record, not delivered again. The link
 *               token is derived from a stored nonce, so a retry rebuilds the
 *               identical message.
 *   3. record — sent / suppressed / failed. Retryable failures back off and
 *               try again (bounded); permanent ones stop.
 */

/** Wait after the session's last activity before emailing (task creation itself waits 30 min). */
export const RECOVERY_EMAIL_DELAY_MS = 60 * 60_000;
/** A claim older than this is considered abandoned by a crashed worker. */
const SEND_LOCK_MS = 10 * 60_000;
export const RECOVERY_EMAIL_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 15 * 60_000;
const MAX_SENDS_PER_MERCHANT = 100;

export type RecoveryEmailSender = (msg: EmailMessage) => Promise<EmailDeliveryResult>;

export interface RecoveryEmailPassResult {
  sent: number;
  failed: number;
  suppressed: number;
  cancelled: number;
}

const UTM = "utm_source=confirmx&utm_medium=email&utm_campaign=cart_recovery";

/** Errors worth another attempt: network faults, provider 5xx and rate limiting. */
function isRetryable(error: string | undefined): boolean {
  if (!error || error === EMAIL_NOT_CONFIGURED) return false;
  const m = /^resend_(\d{3})$/.exec(error);
  if (!m) return true; // thrown fetch error (network)
  const status = Number(m[1]);
  return status === 429 || status >= 500;
}

/** The page's public URL (with its language path when the buyer used a non-default one). */
async function recoveryBaseUrl(label: string, locale: string, host: string): Promise<string | null> {
  const base = publicUrlFor(label);
  if (!base) return null;
  const defaults = await resolvePublishedForOrder(host, null);
  const path = defaults && locale && defaults.locale !== locale ? `/${locale}` : "/";
  return `${base.replace(/\/+$/, "")}${path}`;
}

export async function sendDueRecoveryEmails(args: {
  merchantId: Types.ObjectId;
  now?: number;
  send?: RecoveryEmailSender;
  maxSends?: number;
}): Promise<RecoveryEmailPassResult> {
  const now = args.now ?? Date.now();
  const send = args.send ?? ((msg) => sendEmail(msg));
  const result: RecoveryEmailPassResult = { sent: 0, failed: 0, suppressed: 0, cancelled: 0 };
  const nowDate = new Date(now);

  // Index {merchantId, status, abandonedAt}: pending tasks old enough to email.
  const candidates = await RecoveryTask.find({
    merchantId: args.merchantId,
    status: "pending",
    abandonedAt: { $lte: new Date(now - RECOVERY_EMAIL_DELAY_MS) },
    expiresAt: { $gt: nowDate },
    "emailRecovery.state": { $in: ["queued", "sending", "failed"] },
  })
    .sort({ abandonedAt: 1 })
    .limit(args.maxSends ?? MAX_SENDS_PER_MERCHANT)
    .select("_id emailRecovery.state emailRecovery.lockedUntil emailRecovery.nextAttemptAt emailRecovery.tokenNonce")
    .lean();

  let merchantName: string | null = null;
  for (const c of candidates) {
    const er = c.emailRecovery!;
    const due =
      er.state === "queued" ||
      (er.state === "sending" && (!er.lockedUntil || er.lockedUntil <= nowDate)) ||
      (er.state === "failed" && !!er.nextAttemptAt && er.nextAttemptAt <= nowDate);
    if (!due) continue;

    // ---- 1. Claim -----------------------------------------------------------
    const nonce = er.tokenNonce ?? newTokenNonce();
    const token = deriveRecoveryToken(String(c._id), nonce);
    const claimed = await RecoveryTask.findOneAndUpdate(
      {
        _id: c._id,
        merchantId: args.merchantId,
        status: "pending",
        "emailRecovery.state": er.state,
        ...(er.state === "sending" ? { "emailRecovery.lockedUntil": er.lockedUntil ?? null } : {}),
        ...(er.state === "failed" ? { "emailRecovery.nextAttemptAt": er.nextAttemptAt } : {}),
        ...(er.tokenNonce ? { "emailRecovery.tokenNonce": er.tokenNonce } : { "emailRecovery.tokenNonce": { $exists: false } }),
      },
      {
        $set: {
          "emailRecovery.state": "sending",
          "emailRecovery.lockedUntil": new Date(now + SEND_LOCK_MS),
          "emailRecovery.tokenNonce": nonce,
          "emailRecovery.tokenHash": hashRecoveryToken(token),
        },
        $unset: { "emailRecovery.nextAttemptAt": "" },
        $inc: { "emailRecovery.attempts": 1 },
      },
      { new: true },
    ).lean();
    if (!claimed) continue; // another sweep has it

    const finish = async (set: Record<string, unknown>) => {
      await RecoveryTask.updateOne(
        { _id: claimed._id, merchantId: args.merchantId, "emailRecovery.state": "sending" },
        { $set: set, $unset: { "emailRecovery.lockedUntil": "" } },
      );
    };
    const cancel = async (reason: string) => {
      result.cancelled += 1;
      await finish({ "emailRecovery.state": "cancelled", "emailRecovery.cancelReason": reason });
    };

    // ---- 2. Re-check everything that could make the email wrong ---------
    const to = claimed.email;
    if (!to || claimed.source !== "landing_page" || !claimed.landingPageId || !claimed.landingHost) {
      await cancel("not_recoverable");
      continue;
    }
    const session = await TrackingSession.findOne({ merchantId: args.merchantId, sessionId: claimed.sessionId })
      .select("converted resolvedOrderId firstSeenAt")
      .lean();
    if (session?.converted || session?.resolvedOrderId) {
      await cancel("order_exists");
      continue;
    }
    // The buyer may have ordered another way (another tab, phone order).
    const since = session?.firstSeenAt ?? claimed.abandonedAt;
    const or: Record<string, unknown>[] = [{ "source.customerEmail": to }];
    if (claimed.phone) {
      const variants = phoneLookupVariants(claimed.phone);
      or.push({ "customer.phone": variants.length > 1 ? { $in: variants } : claimed.phone });
    }
    if (await Order.exists({ merchantId: args.merchantId, createdAt: { $gte: since }, $or: or })) {
      await cancel("order_exists");
      continue;
    }
    if (await emailSuppressionFor(to)) {
      result.suppressed += 1;
      await finish({ "emailRecovery.state": "suppressed" });
      continue;
    }
    const page = await resolvePublishedForOrder(claimed.landingHost, claimed.landingLocale ?? null);
    if (!page || page.pageId !== String(claimed.landingPageId) || page.merchantId !== String(args.merchantId)) {
      await cancel("page_unavailable");
      continue;
    }
    const snap = await landingCartSnapshot(args.merchantId, claimed.sessionId);
    const live = snap ? await availableRecoveryLines(args.merchantId, page, snap.lines) : { lines: [], currency: "BDT" };
    if (live.lines.length === 0) {
      await cancel("cart_unavailable");
      continue;
    }
    const base = await recoveryBaseUrl(page.label, page.locale, claimed.landingHost);
    if (!base) {
      await cancel("page_unavailable");
      continue;
    }
    if (merchantName === null) {
      const m = await Merchant.findById(args.merchantId).select("businessName").lean();
      merchantName = m?.businessName ?? "";
    }

    // ---- 3. Send once --------------------------------------------------------
    // Token in the fragment: never sent to a server in a Referer or request line.
    const recoveryUrl = `${base}?${UTM}#cx_recover=${token}`;
    const built = buildCartRecoveryEmail({ storeName: merchantName, items: live.lines, currency: live.currency, recoveryUrl });
    let res: EmailDeliveryResult;
    try {
      res = await send({
        to,
        subject: built.subject,
        html: built.html,
        text: built.text,
        tag: "cart_recovery",
        idempotencyKey: `cart-recovery-${String(claimed._id)}`,
      });
    } catch (err) {
      res = { ok: false, error: (err as Error).message ?? "send_threw" };
    }

    // ---- 4. Record ------------------------------------------------------------
    if (res.ok && res.skipped && res.skipReason !== "no_api_key") {
      // suppressed_bounce_hard / suppressed_complaint: the provider was never called.
      result.suppressed += 1;
      await finish({ "emailRecovery.state": "suppressed", "emailRecovery.lastError": res.skipReason });
      continue;
    }
    if (res.ok) {
      // A provider id, or development's stdout delivery (no_api_key).
      result.sent += 1;
      const sentAt = new Date(now);
      await finish({
        "emailRecovery.state": "sent",
        "emailRecovery.sentAt": sentAt,
        ...(res.id ? { "emailRecovery.providerMessageId": res.id } : {}),
      });
      // Existing state machine: the buyer has now been contacted, by email.
      await RecoveryTask.updateOne(
        { _id: claimed._id, merchantId: args.merchantId, status: "pending" },
        { $set: { status: "contacted", lastChannel: "email", contactedAt: sentAt } },
      );
      void writeAudit({
        merchantId: args.merchantId,
        actorId: args.merchantId,
        actorType: "system",
        action: "recovery.email_sent",
        subjectType: "session",
        subjectId: claimed._id,
        meta: { kind: "cart_recovery_email", attempts: claimed.emailRecovery?.attempts ?? 1 },
      });
      continue;
    }
    result.failed += 1;
    const attempts = claimed.emailRecovery?.attempts ?? 1;
    const retry = isRetryable(res.error) && attempts < RECOVERY_EMAIL_MAX_ATTEMPTS;
    await finish({
      "emailRecovery.state": "failed",
      "emailRecovery.lastError": String(res.error ?? "send_failed").slice(0, 300),
      ...(retry ? { "emailRecovery.nextAttemptAt": new Date(now + RETRY_BACKOFF_MS * attempts) } : {}),
    });
    console.warn(
      JSON.stringify({ evt: "recovery.email_failed", taskId: String(claimed._id), attempts, retry, error: String(res.error ?? "").slice(0, 120) }),
    );
  }
  return result;
}
