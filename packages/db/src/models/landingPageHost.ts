import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

/**
 * Hostname → page mapping. The single source of truth for slug uniqueness
 * and the only key the public renderer resolves by.
 *
 * `hostname` holds the page label for platform subdomains (`mybrand` for
 * `mybrand.<LANDING_ROOT_DOMAIN>`), so the root domain can be chosen or
 * changed later without a data migration. Custom domains (a later phase)
 * will add `kind: "custom_domain"` rows keyed by the full hostname.
 *
 * Releasing a hostname keeps the row (status "released") until
 * `reusableAfter`, so a freshly abandoned slug cannot be claimed by another
 * merchant and used to impersonate the previous owner.
 */
export const LANDING_HOST_KINDS = ["platform_subdomain"] as const;
export const LANDING_HOST_STATUSES = ["active", "released"] as const;
export type LandingHostStatus = (typeof LANDING_HOST_STATUSES)[number];

const landingPageHostSchema = new Schema(
  {
    hostname: { type: String, required: true, trim: true, lowercase: true, maxlength: 253 },
    kind: { type: String, enum: LANDING_HOST_KINDS, default: "platform_subdomain" },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    pageId: { type: Schema.Types.ObjectId, ref: "LandingPage", required: true },
    status: { type: String, enum: LANDING_HOST_STATUSES, default: "active" },
    releasedAt: { type: Date },
    reusableAfter: { type: Date },
  },
  { timestamps: true, collection: "landing_page_hosts" },
);

landingPageHostSchema.index({ hostname: 1 }, { unique: true });
landingPageHostSchema.index(
  { pageId: 1 },
  { unique: true, partialFilterExpression: { status: "active" }, name: "one_active_host_per_page" },
);
landingPageHostSchema.index({ merchantId: 1, status: 1 });

export type LandingPageHost = InferSchemaType<typeof landingPageHostSchema> & { _id: Types.ObjectId };

export const LandingPageHost: Model<LandingPageHost> =
  (models.LandingPageHost as Model<LandingPageHost>) ||
  model<LandingPageHost>("LandingPageHost", landingPageHostSchema);
