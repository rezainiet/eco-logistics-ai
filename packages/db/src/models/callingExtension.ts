import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

export const CALLING_EXTENSION_STATUSES = ["active", "inactive"] as const;
export type CallingExtensionStatus = (typeof CALLING_EXTENSION_STATUSES)[number];

const callingExtensionSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    extension: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (v: string) => /^\d{2,10}$/.test(v),
        message: "extension must be 2-10 digits",
      },
    },
    assignedUserId: { type: Schema.Types.ObjectId, ref: "MerchantUser" },
    status: { type: String, enum: CALLING_EXTENSION_STATUSES, default: "active" },
    label: { type: String, trim: true, maxlength: 120 },
    providerKey: { type: String, trim: true, lowercase: true, maxlength: 80 },
    providerExtensionId: { type: String, trim: true, maxlength: 160 },
  },
  { timestamps: true },
);

callingExtensionSchema.index({ merchantId: 1, extension: 1 }, { unique: true });
callingExtensionSchema.index(
  { merchantId: 1, assignedUserId: 1 },
  {
    unique: true,
    partialFilterExpression: { assignedUserId: { $type: "objectId" } },
  },
);
callingExtensionSchema.index(
  { merchantId: 1, providerKey: 1, providerExtensionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerKey: { $type: "string" },
      providerExtensionId: { $type: "string" },
    },
  },
);

export type CallingExtension = InferSchemaType<typeof callingExtensionSchema> & {
  _id: Types.ObjectId;
};

export const CallingExtension: Model<CallingExtension> =
  (models.CallingExtension as Model<CallingExtension>) ||
  model<CallingExtension>("CallingExtension", callingExtensionSchema);
