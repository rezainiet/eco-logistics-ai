import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Channels the confirmation outcome engine accepts. Mirrors
 * `Order.automation.confirmationChannel` so cross-references (CallLog →
 * Order.calls[] / Order.automation) stay consistent. Adding a new channel
 * means adding it here AND in `Order.automation.confirmationChannel`
 * AND in `lib/confirmation-outcome.ts`.
 */
export const CONFIRMATION_CHANNELS = [
  "sms",
  "ivr",
  "whatsapp",
  "manual",
  "agent",
  "ai_voice",
] as const;

/**
 * Why the call was placed. `order_confirmation` is the bulk-IVR flow that
 * runs after SMS no-reply; `otp` is the high-risk verification ladder
 * (future); `agent_outreach` is the merchant-initiated dial from the
 * dashboard. `unknown` covers legacy rows minted before this field existed.
 */
export const CALL_PURPOSES = [
  "order_confirmation",
  "otp",
  "agent_outreach",
  "unknown",
] as const;

const outcomeSchema = new Schema(
  {
    successful: { type: Boolean },
    reason: { type: String, trim: true },
    deliverySuccessDate: { type: Date },
    /**
     * When the confirmation outcome engine applied a decision off the back of
     * this call (e.g. DTMF 1 → confirm), it stamps the channel + decision
     * here. Provides a single read surface for "did this call actually flip
     * the order?" without joining back to the Order document.
     */
    confirmedVia: { type: String, enum: CONFIRMATION_CHANNELS },
    confirmedDecision: { type: String, enum: ["confirm", "reject"] },
  },
  { _id: false }
);

const CALL_STATUSES = [
  "queued",
  "initiated",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
] as const;

const callLogSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    agentId: { type: Schema.Types.ObjectId },
    timestamp: { type: Date, required: true },
    hour: { type: Number, required: true, min: 0, max: 23 },
    dayOfWeek: { type: Number, min: 0, max: 6 },
    duration: { type: Number, required: true, min: 0 },
    answered: { type: Boolean, required: true },
    outcome: { type: outcomeSchema, default: () => ({}) },
    notes: { type: String, trim: true },
    callType: { type: String, enum: ["incoming", "outgoing"] },
    customerPhone: { type: String, trim: true },
    tags: { type: [String], default: undefined },
    deliveryStatus: { type: String, enum: ["delivered", "pending", "rto"] },
    customerName: { type: String, trim: true },
    /**
     * Provider identifier — historically populated by Twilio as `callSid`.
     * Kept under this name so the existing index + Twilio webhook handler
     * keep working; new voice adapters write their own provider-side id
     * here (it's an opaque string from our perspective).
     */
    callSid: { type: String, trim: true, index: { unique: true, sparse: true } },
    /**
     * Which voice adapter placed this call. Lets us cleanly co-exist with
     * the legacy Twilio rows while we roll a BD provider in. Absent on
     * pre-abstraction rows; treat undefined as "twilio (legacy)".
     */
    providerName: { type: String, trim: true, maxlength: 40 },
    /**
     * Why this call exists. See `CALL_PURPOSES`. Absent on legacy rows
     * (treat as `"agent_outreach"` — the only flow that pre-existed).
     */
    purpose: { type: String, enum: CALL_PURPOSES, index: true },
    /**
     * Monotonic attempt counter for repeat dial-outs within a single
     * confirmation cycle (1st call no-answer → 2nd call → escalate to
     * auto-reject). 1 for first attempt. Absent on legacy rows.
     */
    attemptNumber: { type: Number, min: 1 },
    /**
     * DTMF digits captured during the IVR. Multi-digit reserved for the
     * OTP / confirmation-code-readback flow; single digit for menu input.
     * Empty string means "answered but pressed nothing"; absent means
     * "no DTMF callback fired".
     */
    dtmfDigits: { type: String, trim: true, maxlength: 16 },
    status: { type: String, enum: CALL_STATUSES },
    recordingUrl: { type: String, trim: true },
    recordingSid: { type: String, trim: true },
    price: { type: Number },
    priceUnit: { type: String, trim: true },
    errorCode: { type: String, trim: true },
    errorMessage: { type: String, trim: true },
    from: { type: String, trim: true },
    to: { type: String, trim: true },
    startedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

callLogSchema.pre("validate", function (next) {
  if (this.timestamp) {
    const ts = new Date(this.timestamp);
    if (this.hour === undefined || this.hour === null) {
      this.hour = ts.getHours();
    }
    if (this.dayOfWeek === undefined || this.dayOfWeek === null) {
      this.dayOfWeek = ts.getDay();
    }
  }
  next();
});

callLogSchema.index({ merchantId: 1, timestamp: -1 });
callLogSchema.index({ orderId: 1, timestamp: -1 });
callLogSchema.index({ merchantId: 1, hour: 1, answered: 1 });
callLogSchema.index({ merchantId: 1, timestamp: -1, hour: 1 });
callLogSchema.index({ merchantId: 1, callType: 1, timestamp: -1 });
// IVR-confirmation lookups: how many attempts has this order had, latest first.
// Partial-filter keeps the index narrow until purpose-stamping is universal.
callLogSchema.index(
  { orderId: 1, purpose: 1, attemptNumber: -1 },
  { partialFilterExpression: { purpose: { $type: "string" } } },
);

export type CallLog = InferSchemaType<typeof callLogSchema> & { _id: Types.ObjectId };

export const CallLog: Model<CallLog> =
  (models.CallLog as Model<CallLog>) || model<CallLog>("CallLog", callLogSchema);
