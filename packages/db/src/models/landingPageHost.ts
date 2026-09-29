import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

/**
 * Hostname → page mapping. The single source of truth for slug uniqueness
 * and the only key the public renderer resolves by.
 *
 * `hostname` holds the page label for platform subdomains (`mybrand` for
 * `mybrand.<LANDING_ROOT_DOMAIN>`), so the root domain can be chosen or
 * changed later without a data migration.
 *
 * Custom domains are `kind: "custom_domain"` rows keyed by the full hostname
 * (`shop.example.com`), one domain → one page. They never use status
 * "active" (so the one-active-subdomain-per-page index is untouched) but
 * their own lifecycle:
 *   pending_verification → verified (TXT ownership proven) → ssl_pending
 *   (DNS points here; waiting for the certificate) → live, or error.
 * Only "live" rows are ever served. Removing a custom domain deletes its
 * row: a new claim must prove DNS ownership again, so no hold period is
 * needed against impersonation.
 *
 * Releasing a hostname keeps the row (status "released") until
 * `reusableAfter`, so a freshly abandoned slug cannot be claimed by another
 * merchant and used to impersonate the previous owner.
 */
export const LANDING_HOST_KINDS = ["platform_subdomain", "custom_domain"] as const;
export const CUSTOM_DOMAIN_STATUSES = ["pending_verification", "verified", "ssl_pending", "live", "error"] as const;
export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUSES)[number];
export const LANDING_HOST_STATUSES = ["active", "released", ...CUSTOM_DOMAIN_STATUSES] as const;
export type LandingHostStatus = (typeof LANDING_HOST_STATUSES)[number];

/** Lifecycle details of a custom domain (absent on platform subdomains). */
const customDomainSchema = new Schema(
  {
    /** Random token the merchant publishes as TXT `_confirmx-verify.<hostname>`. */
    verificationToken: { type: String, required: true, maxlength: 80 },
    verifiedAt: { type: Date },
    /** Last ownership / routing check (merchant-triggered, rate limited). */
    lastCheckedAt: { type: Date },
    /** Whether the hostname's A/CNAME pointed at the platform on the last check. */
    dnsPointsHere: { type: Boolean },
    /** Certificate requests handed to the server helper (limits retries). */
    sslRequestedAt: { type: Date },
    sslAttempts: { type: Number, default: 0 },
    /**
     * Consecutive failed issuances and when the last one failed: drives the
     * retry backoff (no certbot call until it has passed). Cleared on success.
     */
    sslFailures: { type: Number, default: 0 },
    sslFailedAt: { type: Date },
    liveAt: { type: Date },
    certExpiresAt: { type: Date },
    /** Last report from the server helper. */
    helperReportedAt: { type: Date },
    /** Merchant-safe error text (never raw command output). */
    lastError: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const landingPageHostSchema = new Schema(
  {
    hostname: { type: String, required: true, trim: true, lowercase: true, maxlength: 253 },
    kind: { type: String, enum: LANDING_HOST_KINDS, default: "platform_subdomain" },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    pageId: { type: Schema.Types.ObjectId, ref: "LandingPage", required: true },
    status: { type: String, enum: LANDING_HOST_STATUSES, default: "active" },
    releasedAt: { type: Date },
    reusableAfter: { type: Date },
    customDomain: { type: customDomainSchema, default: undefined },
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
