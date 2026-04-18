import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

const outcomeSchema = new Schema(
  {
    successful: { type: Boolean },
    deliverySuccessDate: { type: Date },
  },
  { _id: false }
);

const callLogSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    agentId: { type: Schema.Types.ObjectId },
    timestamp: { type: Date, required: true },
    hour: { type: Number, required: true, min: 0, max: 23 },
    duration: { type: Number, required: true, min: 0 },
    answered: { type: Boolean, required: true },
    outcome: { type: outcomeSchema, default: () => ({}) },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

callLogSchema.pre("validate", function (next) {
  if (this.timestamp && (this.hour === undefined || this.hour === null)) {
    this.hour = new Date(this.timestamp).getHours();
  }
  next();
});

callLogSchema.index({ merchantId: 1, timestamp: -1 });
callLogSchema.index({ orderId: 1, timestamp: -1 });
callLogSchema.index({ merchantId: 1, hour: 1, answered: 1 });
callLogSchema.index({ merchantId: 1, timestamp: -1, hour: 1 });

export type CallLog = InferSchemaType<typeof callLogSchema> & { _id: Types.ObjectId };

export const CallLog: Model<CallLog> =
  (models.CallLog as Model<CallLog>) || model<CallLog>("CallLog", callLogSchema);
