import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

const outcomeSchema = new Schema(
  {
    successful: { type: Boolean },
    reason: { type: String, trim: true },
    deliverySuccessDate: { type: Date },
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
    callSid: { type: String, trim: true, index: { unique: true, sparse: true } },
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

export type CallLog = InferSchemaType<typeof callLogSchema> & { _id: Types.ObjectId };

export const CallLog: Model<CallLog> =
  (models.CallLog as Model<CallLog>) || model<CallLog>("CallLog", callLogSchema);
