import mongoose, { type InferSchemaType, type Model } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * BrandingConfig — the single SaaS-level branding document.
 *
 * One row keyed by `key: "saas"`. The schema stores a partial set of
 * branding fields; missing ones are filled by `DEFAULT_BRANDING` from
 * `@ecom/branding/defaults` at the resolver boundary, so downstream
 * consumers always see a complete document.
 *
 * Why a Mongo collection (vs. env vars or a JSON file):
 *   - The admin Branding Panel writes to it without a redeploy.
 *   - Audit trail integration is free (we already have an AuditLog model).
 *   - Future multi-brand expands the collection to N rows; the resolver
 *     simply takes a `key`.
 *
 * Why a singleton today (vs. a global config object):
 *   - `findOneAndUpdate({ key }, …, { upsert: true })` is atomic and
 *     idempotent across replicas; an in-memory config wouldn't be.
 *   - Future white-label work flips this to per-tenant by varying `key`.
 *
 * The schema deliberately uses `Mixed` for the asset / color / email /
 * seo / operational subtrees so partial admin updates don't have to
 * thread Mongoose paths for every nested key. Validation lives in zod
 * (`@ecom/branding/schema`) at the router boundary, where it can produce
 * helpful per-field errors. Treat this collection as JSON-with-an-index.
 */

const brandingConfigSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      maxlength: 64,
    },
    name: { type: String, trim: true, maxlength: 120 },
    legalName: { type: String, trim: true, maxlength: 120 },
    tagline: { type: String, trim: true, maxlength: 280 },
    shortTagline: { type: String, trim: true, maxlength: 280 },
    productCategory: { type: String, trim: true, maxlength: 280 },
    defaultLocale: { type: String, trim: true, maxlength: 12 },
    homeUrl: { type: String, trim: true, maxlength: 400 },
    statusPageUrl: { type: String, trim: true, maxlength: 400 },
    termsUrl: { type: String, trim: true, maxlength: 400 },
    privacyUrl: { type: String, trim: true, maxlength: 400 },
    supportUrl: { type: String, trim: true, maxlength: 400 },
    supportEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    privacyEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    salesEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    helloEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    noReplyEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    colors: { type: Schema.Types.Mixed },
    assets: { type: Schema.Types.Mixed },
    email: { type: Schema.Types.Mixed },
    seo: { type: Schema.Types.Mixed },
    operational: { type: Schema.Types.Mixed },
    /**
     * Monotonically increments on every successful write. The admin panel
     * uses this for optimistic concurrency control: if the version on the
     * client doesn't match the version on disk, the save is rejected so
     * two admins editing in parallel can't silently overwrite each other.
     */
    version: { type: Number, default: 0 },
    /** Merchant._id of the admin who last wrote. */
    updatedBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
  },
  { timestamps: true, collection: "branding_configs" },
);

export type BrandingConfigSchema = InferSchemaType<typeof brandingConfigSchema>;

export type BrandingConfigModelType = Model<BrandingConfigSchema>;

export const BrandingConfig: BrandingConfigModelType =
  (models.BrandingConfig as BrandingConfigModelType | undefined) ??
  model<BrandingConfigSchema>("BrandingConfig", brandingConfigSchema);
