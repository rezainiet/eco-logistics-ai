import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

const callEventSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    callSessionId: { type: Schema.Types.ObjectId, ref: "CallSession", required: true },
    providerKey: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    providerEventId: { type: String, required: true, trim: true, maxlength: 200 },
    eventType: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    occurredAt: { type: Date, required: true, default: () => new Date() },
    processedAt: { type: Date },
    payload: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

callEventSchema.index({ merchantId: 1, providerKey: 1, providerEventId: 1 }, { unique: true });
callEventSchema.index({ merchantId: 1, callSessionId: 1, occurredAt: -1 });
callEventSchema.index({ merchantId: 1, eventType: 1, occurredAt: -1 });

export type CallEvent = InferSchemaType<typeof callEventSchema> & {
  _id: Types.ObjectId;
};

export const CallEvent: Model<CallEvent> =
  (models.CallEvent as Model<CallEvent>) || model<CallEvent>("CallEvent", callEventSchema);
