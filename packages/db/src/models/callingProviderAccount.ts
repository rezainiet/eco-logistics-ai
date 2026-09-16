import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

export const CALLING_PROVIDER_ACCOUNT_STATUSES = ["active", "inactive", "suspended"] as const;
export type CallingProviderAccountStatus = (typeof CALLING_PROVIDER_ACCOUNT_STATUSES)[number];

const callingProviderAccountSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    providerKey: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    providerCustomerId: { type: String, required: true, trim: true, maxlength: 160 },
    domain: { type: String, trim: true, maxlength: 200 },
    status: { type: String, enum: CALLING_PROVIDER_ACCOUNT_STATUSES, default: "active" },
    lastSyncedAt: { type: Date },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

callingProviderAccountSchema.index({ merchantId: 1, providerKey: 1 }, { unique: true });
callingProviderAccountSchema.index(
  { providerKey: 1, providerCustomerId: 1 },
  { unique: true },
);

export type CallingProviderAccount = InferSchemaType<typeof callingProviderAccountSchema> & {
  _id: Types.ObjectId;
};

export const CallingProviderAccount: Model<CallingProviderAccount> =
  (models.CallingProviderAccount as Model<CallingProviderAccount>) ||
  model<CallingProviderAccount>("CallingProviderAccount", callingProviderAccountSchema);
