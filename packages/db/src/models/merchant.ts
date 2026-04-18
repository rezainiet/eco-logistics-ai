import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

const PHONE_RE = /^\+?[0-9]{7,15}$/;

const COUNTRIES = ["BD", "PK", "IN", "LK", "NP", "ID", "PH", "VN", "MY", "TH"] as const;
const LANGUAGES = ["en", "bn", "ur", "hi", "ta", "id", "th", "vi", "ms"] as const;
const TIERS = ["starter", "professional", "enterprise"] as const;
const SUB_STATUS = ["trial", "active", "past_due", "paused", "cancelled"] as const;

const courierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    accountId: { type: String, required: true, trim: true },
    apiKey: { type: String, required: true },
    preferredDistricts: { type: [String], default: [] },
  },
  { _id: false }
);

const subscriptionSchema = new Schema(
  {
    tier: { type: String, enum: TIERS, default: "starter" },
    rate: { type: Number, min: 0, default: 99 },
    startDate: { type: Date, default: () => new Date() },
    status: { type: String, enum: SUB_STATUS, default: "trial" },
  },
  { _id: false }
);

const merchantSchema = new Schema(
  {
    businessName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    phone: {
      type: String,
      trim: true,
      validate: {
        validator: (v: string) => !v || PHONE_RE.test(v),
        message: "Invalid phone number",
      },
    },
    country: { type: String, enum: COUNTRIES, default: "BD" },
    language: { type: String, enum: LANGUAGES, default: "en" },
    role: { type: String, enum: ["merchant", "admin", "agent"], default: "merchant" },
    subscription: { type: subscriptionSchema, default: () => ({}) },
    couriers: { type: [courierSchema], default: [] },
  },
  { timestamps: true }
);

merchantSchema.index({ country: 1, createdAt: -1 });
merchantSchema.index({ "subscription.status": 1 });

export type Merchant = InferSchemaType<typeof merchantSchema> & { _id: Types.ObjectId };

export const Merchant: Model<Merchant> =
  (models.Merchant as Model<Merchant>) || model<Merchant>("Merchant", merchantSchema);

export const MERCHANT_COUNTRIES = COUNTRIES;
export const MERCHANT_LANGUAGES = LANGUAGES;
export const SUBSCRIPTION_TIERS = TIERS;
export const SUBSCRIPTION_STATUSES = SUB_STATUS;
