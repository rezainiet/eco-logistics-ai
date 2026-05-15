import { Types } from "mongoose";
import { Order, Merchant } from "@ecom/db";
import { canTransitionAutomation } from "./automation.js";
import { writeAudit } from "./audit.js";
import { enqueueAutoBook } from "../workers/automationBook.js";

/**
 * Confirmation outcome engine — the single state-machine transition every
 * confirmation channel (SMS, IVR, WhatsApp, agent, AI voice) routes through.
 *
 * Why this is its own module:
 *   - Every channel needs to do the SAME thing once a YES/NO is captured:
 *     scoped lookup (code + phone), late-reply detection, state-machine
 *     gate, status-too-late gate, write, auto-book cascade, audit.
 *   - Letting each channel re-implement this drifted us into bugs before
 *     (the SMS path's auto-book cascade lived inside the webhook handler
 *     for months while the agent-confirm path silently skipped it). Pull
 *     it into one function and every channel benefits from the same fixes.
 *   - The COD-fraud product story leans hard on "confirmation is the same
 *     decision regardless of channel" — auto-book, fraud signal write,
 *     late-reply UX, audit shape are all channel-independent. The variant
 *     is *only* how we captured the customer's input.
 *
 * What this module does NOT do:
 *   - Notify the customer that their late reply was acknowledged. Each
 *     channel handles its own courtesy notification (SMS sends an
 *     `order_expired` SMS, IVR plays a recorded "this order has expired"
 *     prompt, etc.) Returning `{ kind: "late_reply" }` is the signal that
 *     the channel should fire whatever notification fits.
 *   - Mint the confirmation code or dispatch outbound prompts. The
 *     automation engine + per-channel workers own that side of the loop.
 */

export const CONFIRMATION_CHANNELS = [
  "sms",
  "ivr",
  "whatsapp",
  "manual",
  "agent",
  "ai_voice",
] as const;
export type ConfirmationChannel = (typeof CONFIRMATION_CHANNELS)[number];

export type ConfirmationDecision = "confirm" | "reject";

export interface ApplyConfirmationInput {
  /** 6 or 8 digit confirmation code minted by the automation engine. */
  code: string;
  /**
   * Customer phone — normalized to the same shape we store on
   * `Order.customer.phone` (E.164 / +8801…). Callers are responsible for
   * normalization because the channel's adapter knows the raw shape best
   * (SMS gateways sometimes send `88017…`, providers sometimes `+88017…`).
   */
  phone: string;
  decision: ConfirmationDecision;
  channel: ConfirmationChannel;
  /**
   * Channel-specific evidence for the audit log. Kept opaque on purpose —
   * channels record what's useful for them (DTMF digit, SMS body tail,
   * agent id, AI confidence score). Bounded; do NOT pass PII secrets.
   */
  meta?: Record<string, unknown>;
}

export type ApplyConfirmationResult =
  | {
      kind: "applied";
      orderId: string;
      merchantId: string;
      orderNumber: string;
      decision: ConfirmationDecision;
      modified: boolean; // false on idempotent re-application
    }
  | {
      kind: "late_reply";
      orderId: string;
      merchantId: string;
      orderNumber: string;
      customerPhone: string;
      brandName: string | null;
      /**
       * True when this engine call was the one that flipped the
       * `lateReplyAcknowledgedAt` stamp from undefined to a timestamp.
       * Channels use this to suppress duplicate courtesy notifications
       * on retried webhook deliveries — fire iff `acknowledgedJustNow`.
       */
      acknowledgedJustNow: boolean;
    }
  | {
      kind: "no_match";
      reason: "no_pending_order" | "phone_mismatch";
    }
  | {
      kind: "ignored";
      reason: "cannot_transition" | "status_too_late";
      currentState?: string;
      currentStatus?: string;
    };

/**
 * Reuse window for "late reply" detection. Mirrors the SMS-inbound
 * webhook's previous hardcoded constant — kept here so every channel
 * applies the same generosity.
 */
const LATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function applyConfirmationOutcome(
  input: ApplyConfirmationInput,
): Promise<ApplyConfirmationResult> {
  const order = await Order.findOne({
    "automation.confirmationCode": input.code,
    "automation.state": "pending_confirmation",
    "customer.phone": input.phone,
  })
    .select("_id merchantId orderNumber order.status automation customer.phone")
    .lean<{
      _id: Types.ObjectId;
      merchantId: Types.ObjectId;
      orderNumber: string;
      order?: { status?: string };
      automation?: { state?: string };
      customer?: { phone?: string };
    }>();

  if (!order) {
    const late = await detectLateReply(input);
    if (late) return late;
    return { kind: "no_match", reason: "no_pending_order" };
  }

  const fromState = order.automation?.state ?? "not_evaluated";
  const target = input.decision === "confirm" ? "confirmed" : "rejected";
  if (
    !canTransitionAutomation(
      fromState as Parameters<typeof canTransitionAutomation>[0],
      target,
    )
  ) {
    return { kind: "ignored", reason: "cannot_transition", currentState: fromState };
  }

  const status = order.order?.status;
  if (
    input.decision === "reject" &&
    status &&
    !["pending", "confirmed"].includes(status)
  ) {
    return {
      kind: "ignored",
      reason: "status_too_late",
      currentState: fromState,
      currentStatus: status,
    };
  }

  const now = new Date();
  const merchantOid = order.merchantId;
  const orderOid = order._id;
  const decidedBy = decidedByForChannel(input.channel);

  let modified = false;
  if (input.decision === "confirm") {
    const set: Record<string, unknown> = {
      "automation.state": "confirmed",
      "automation.decidedBy": decidedBy,
      "automation.decidedAt": now,
      "automation.confirmedAt": now,
      "automation.confirmationChannel": input.channel,
      "automation.reason": `customer ${input.channel.toUpperCase()} YES`,
      // Customer-driven confirmation across ANY channel is the strongest
      // "this is a real customer" signal we get. Stamp the fraud subdoc so
      // queue surfaces relax without an agent call. We reuse the
      // `smsFeedback` field for backward compatibility — renaming it to
      // `customerFeedback` is a downstream cleanup not gated by PR 1.
      "fraud.smsFeedback": "confirmed",
      "fraud.smsFeedbackAt": now,
    };
    if (status === "pending") set["order.status"] = "confirmed";

    const writeRes = await Order.updateOne(
      {
        _id: orderOid,
        merchantId: merchantOid,
        "automation.state": "pending_confirmation",
      },
      { $set: set },
    );
    modified = writeRes.modifiedCount > 0;

    if (modified) {
      await cascadeAutoBook(merchantOid, orderOid).catch((err) =>
        console.error(
          "[confirmation-outcome] auto-book cascade failed:",
          (err as Error).message,
        ),
      );
    }
  } else {
    const writeRes = await Order.updateOne(
      {
        _id: orderOid,
        merchantId: merchantOid,
        "automation.state": "pending_confirmation",
      },
      {
        $set: {
          "automation.state": "rejected",
          "automation.decidedBy": decidedBy,
          "automation.decidedAt": now,
          "automation.rejectedAt": now,
          "automation.rejectionReason": `customer ${input.channel.toUpperCase()} NO`,
          "automation.confirmationChannel": input.channel,
          "order.status": "cancelled",
          "fraud.smsFeedback": "rejected",
          "fraud.smsFeedbackAt": now,
          "fraud.reviewStatus": "rejected",
        },
      },
    );
    modified = writeRes.modifiedCount > 0;
  }

  void writeAudit({
    merchantId: merchantOid,
    actorId: merchantOid,
    actorType: "system",
    action: `automation.${input.channel}_${input.decision}`,
    subjectType: "order",
    subjectId: orderOid,
    meta: { ...(input.meta ?? {}), codeTail: input.code.slice(-4) },
  }).catch(() => {});

  return {
    kind: "applied",
    orderId: String(orderOid),
    merchantId: String(merchantOid),
    orderNumber: order.orderNumber,
    decision: input.decision,
    modified,
  };
}

/**
 * The customer's reply landed *after* the auto-reject window. Look the
 * order up without the pending-state guard, scoped to recently-rejected
 * system-decided orders. The channel is responsible for the courtesy
 * notification (SMS, IVR prompt, WhatsApp template).
 */
async function detectLateReply(
  input: ApplyConfirmationInput,
): Promise<Extract<ApplyConfirmationResult, { kind: "late_reply" }> | null> {
  const cutoff = new Date(Date.now() - LATE_REPLY_WINDOW_MS);
  const expired = await Order.findOne({
    "automation.confirmationCode": input.code,
    "customer.phone": input.phone,
    "automation.state": "rejected",
    "automation.decidedBy": "system",
    "automation.rejectedAt": { $gte: cutoff },
  })
    .select(
      "_id merchantId orderNumber customer.phone automation.lateReplyAcknowledgedAt",
    )
    .lean<{
      _id: Types.ObjectId;
      merchantId: Types.ObjectId;
      orderNumber: string;
      customer: { phone: string };
      automation?: { lateReplyAcknowledgedAt?: Date };
    }>();
  if (!expired) return null;

  const alreadyAcknowledged = !!expired.automation?.lateReplyAcknowledgedAt;
  let acknowledgedJustNow = false;
  if (!alreadyAcknowledged) {
    // Stamp BEFORE the channel sends so a duplicate webhook delivery
    // can't trigger a second courtesy notification mid-race.
    const stamped = await Order.updateOne(
      {
        _id: expired._id,
        merchantId: expired.merchantId,
        "automation.lateReplyAcknowledgedAt": { $exists: false },
      },
      { $set: { "automation.lateReplyAcknowledgedAt": new Date() } },
    );
    acknowledgedJustNow = stamped.modifiedCount > 0;
    if (acknowledgedJustNow) {
      void writeAudit({
        merchantId: expired.merchantId,
        actorId: expired.merchantId,
        actorType: "system",
        action: "automation.auto_expired",
        subjectType: "order",
        subjectId: expired._id,
        meta: {
          channel: input.channel,
          outcome: "late_reply_acknowledged",
          codeTail: input.code.slice(-4),
        },
      }).catch(() => {});
    }
  }

  let brandName: string | null = null;
  if (acknowledgedJustNow) {
    const merchant = await Merchant.findById(expired.merchantId)
      .select("businessName")
      .lean<{ businessName?: string } | null>();
    brandName = merchant?.businessName ?? null;
  }

  return {
    kind: "late_reply",
    orderId: String(expired._id),
    merchantId: String(expired.merchantId),
    orderNumber: expired.orderNumber,
    customerPhone: expired.customer.phone,
    brandName,
    acknowledgedJustNow,
  };
}

async function cascadeAutoBook(
  merchantId: Types.ObjectId,
  orderId: Types.ObjectId,
): Promise<void> {
  const merchant = await Merchant.findById(merchantId)
    .select("automationConfig couriers")
    .lean<{
      automationConfig?: { autoBookEnabled?: boolean; autoBookCourier?: string };
      couriers?: Array<{ name: string; enabled?: boolean }>;
    } | null>();
  const cfg = merchant?.automationConfig ?? {};
  if (cfg.autoBookEnabled !== true) return;
  const courierName =
    cfg.autoBookCourier ??
    (merchant?.couriers ?? []).find((c) => c.enabled !== false)?.name;
  if (!courierName) return;
  await enqueueAutoBook({
    orderId: String(orderId),
    merchantId: String(merchantId),
    userId: String(merchantId),
    courier: courierName,
  });
}

/**
 * Map confirmation channel → `automation.decidedBy` attribution. SMS / IVR /
 * WhatsApp are customer-driven so they record as `agent` (which historically
 * means "human, not system"). `manual` + `agent` channels record as
 * `merchant` because a real Cordon user is the actor. `ai_voice` records as
 * `system` because the AI is acting on the merchant's behalf without a
 * human in the loop.
 */
function decidedByForChannel(
  channel: ConfirmationChannel,
): "system" | "merchant" | "agent" {
  switch (channel) {
    case "manual":
    case "agent":
      return "merchant";
    case "ai_voice":
      return "system";
    case "sms":
    case "ivr":
    case "whatsapp":
    default:
      return "agent";
  }
}
