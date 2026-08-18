import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
import { PHONE_RE } from "./merchant.js";

const { Schema, model, models } = mongoose;

export const MERCHANT_USER_ROLES = ["owner", "admin", "agent"] as const;
export type MerchantUserRole = (typeof MERCHANT_USER_ROLES)[number];

export const MERCHANT_USER_STATUSES = ["active", "inactive", "invited", "suspended"] as const;
export type MerchantUserStatus = (typeof MERCHANT_USER_STATUSES)[number];

const merchantUserSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    name: { type: String, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 200 },
    phone: {
      type: String,
      trim: true,
      validate: {
        validator: (v: string) => !v || PHONE_RE.test(v),
        message: "Invalid phone number",
      },
    },
    passwordHash: { type: String },
    role: { type: String, enum: MERCHANT_USER_ROLES, default: "agent" },
    status: { type: String, enum: MERCHANT_USER_STATUSES, default: "active" },
    lastActiveAt: { type: Date },
  },
  { timestamps: true },
);

merchantUserSchema.index({ merchantId: 1, email: 1 }, { unique: true });
merchantUserSchema.index({ merchantId: 1, role: 1, status: 1 });

export type MerchantUser = InferSchemaType<typeof merchantUserSchema> & { _id: Types.ObjectId };

export const MerchantUser: Model<MerchantUser> =
  (models.MerchantUser as Model<MerchantUser>) ||
  model<MerchantUser>("MerchantUser", merchantUserSchema);
