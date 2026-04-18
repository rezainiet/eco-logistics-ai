import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

const merchantStatsSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
    totalOrders: { type: Number, default: 0 },
    pending:     { type: Number, default: 0 },
    confirmed:   { type: Number, default: 0 },
    packed:      { type: Number, default: 0 },
    shipped:     { type: Number, default: 0 },
    in_transit:  { type: Number, default: 0 },
    delivered:   { type: Number, default: 0 },
    cancelled:   { type: Number, default: 0 },
    rto:         { type: Number, default: 0 },
    updatedAt:   { type: Date, default: () => new Date() },
  },
  { timestamps: false }
);

export type MerchantStats = InferSchemaType<typeof merchantStatsSchema> & { _id: Types.ObjectId };

export const MerchantStats: Model<MerchantStats> =
  (models.MerchantStats as Model<MerchantStats>) ||
  model<MerchantStats>("MerchantStats", merchantStatsSchema);
