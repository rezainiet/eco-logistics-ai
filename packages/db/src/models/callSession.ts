import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

export const CALL_DIRECTIONS = ["inbound", "outbound"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const CALL_SESSION_STATUSES = [
  "created",
  "queued",
  "ringing",
  "answered",
  "completed",
  "failed",
  "missed",
  "cancelled",
] as const;
export type CallSessionStatus = (typeof CALL_SESSION_STATUSES)[number];

const callSessionSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    agentUserId: { type: Schema.Types.ObjectId, ref: "MerchantUser" },
    customerRefType: { type: String, trim: true, maxlength: 80 },
    customerRefId: { type: String, trim: true, maxlength: 160 },
    customerPhone: { type: String, trim: true, maxlength: 40 },
    customerPhoneNormalized: { type: String, trim: true, maxlength: 40 },
    direction: { type: String, enum: CALL_DIRECTIONS, required: true },
    extensionId: { type: Schema.Types.ObjectId, ref: "CallingExtension" },
    extension: { type: String, trim: true, maxlength: 20 },
    businessNumberId: { type: Schema.Types.ObjectId, ref: "CallingNumber" },
    businessNumber: { type: String, trim: true, maxlength: 40 },
    providerKey: { type: String, trim: true, lowercase: true, maxlength: 80 },
    providerCallId: { type: String, trim: true, maxlength: 200 },
    status: { type: String, enum: CALL_SESSION_STATUSES, default: "created" },
    startedAt: { type: Date, default: () => new Date() },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    durationSeconds: { type: Number, min: 0, default: 0 },
    failureCode: { type: String, trim: true, maxlength: 80 },
    failureReason: { type: String, trim: true, maxlength: 500 },
    reservedCallMinutes: { type: Number, min: 0, default: 0 },
    billedMinutes: { type: Number, min: 0, default: 0 },
    usageFinalizedAt: { type: Date },
    lastEventAt: { type: Date },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

callSessionSchema.index({ merchantId: 1, startedAt: -1 });
callSessionSchema.index({ merchantId: 1, agentUserId: 1, startedAt: -1 });
callSessionSchema.index({ merchantId: 1, status: 1, startedAt: -1 });
callSessionSchema.index(
  { merchantId: 1, providerKey: 1, providerCallId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerKey: { $type: "string" },
      providerCallId: { $type: "string" },
    },
  },
);

export type CallSession = InferSchemaType<typeof callSessionSchema> & {
  _id: Types.ObjectId;
};

export const CallSession: Model<CallSession> =
  (models.CallSession as Model<CallSession>) ||
  model<CallSession>("CallSession", callSessionSchema);
