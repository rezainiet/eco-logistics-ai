import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
import { PHONE_RE } from "./merchant.js";

const { Schema, model, models } = mongoose;

export const CALLING_NUMBER_STATUSES = ["active", "inactive"] as const;
export type CallingNumberStatus = (typeof CALLING_NUMBER_STATUSES)[number];

const callingNumberSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (v: string) => PHONE_RE.test(v),
        message: "Invalid phone number",
      },
    },
    normalizedPhone: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (v: string) => PHONE_RE.test(v),
        message: "Invalid normalized phone number",
      },
    },
    status: { type: String, enum: CALLING_NUMBER_STATUSES, default: "active" },
    label: { type: String, trim: true, maxlength: 120 },
    providerKey: { type: String, trim: true, lowercase: true, maxlength: 80 },
    providerNumberId: { type: String, trim: true, maxlength: 160 },
    assignedExtensionId: { type: Schema.Types.ObjectId, ref: "CallingExtension" },
  },
  { timestamps: true },
);

callingNumberSchema.index({ merchantId: 1, status: 1 });
callingNumberSchema.index({ normalizedPhone: 1 }, { unique: true });
callingNumberSchema.index(
  { providerKey: 1, providerNumberId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerKey: { $type: "string" },
      providerNumberId: { $type: "string" },
    },
  },
);

export type CallingNumber = InferSchemaType<typeof callingNumberSchema> & {
  _id: Types.ObjectId;
};

export const CallingNumber: Model<CallingNumber> =
  (models.CallingNumber as Model<CallingNumber>) ||
  model<CallingNumber>("CallingNumber", callingNumberSchema);
