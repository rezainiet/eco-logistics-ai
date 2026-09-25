import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

/**
 * Merchant-uploaded landing-page image.
 *
 * Interim storage: bytes live in Mongo (`storage: "mongo"`), matching the
 * existing convention of storing merchant logos inline, because ConfirmX
 * has no object store yet. Page content only ever references an asset by
 * id, so moving bytes to S3/R2 later (`storage: "s3"`, `storageKey`) needs
 * no content migration.
 *
 * Only raster formats whose magic bytes were verified server-side are
 * stored. SVG is never accepted (it is a script-capable document).
 */
export const LANDING_ASSET_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const landingAssetSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    mime: { type: String, enum: LANDING_ASSET_MIME, required: true },
    bytes: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, maxlength: 64 },
    storage: { type: String, enum: ["mongo"], default: "mongo" },
    data: { type: Buffer, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
  },
  { timestamps: true, collection: "landing_assets" },
);

landingAssetSchema.index({ merchantId: 1, createdAt: -1 });
landingAssetSchema.index({ merchantId: 1, sha256: 1 });

export type LandingAsset = InferSchemaType<typeof landingAssetSchema> & { _id: Types.ObjectId };

export const LandingAsset: Model<LandingAsset> =
  (models.LandingAsset as Model<LandingAsset>) || model<LandingAsset>("LandingAsset", landingAssetSchema);
