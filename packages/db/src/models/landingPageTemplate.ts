import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

/**
 * Landing-page templates — platform-owned (global), never merchant-owned.
 *
 * `origin: "system"` rows are seeded from code (`@ecom/landing`
 * SYSTEM_TEMPLATES) and are read-only to admins; `origin: "custom"` rows
 * are created by a super_admin, usually by duplicating a system template.
 *
 * Merchants may create pages only from templates with `status: "active"`
 * AND a `currentVersionId` (a published version).
 */
export const LANDING_TEMPLATE_STATUSES = ["draft", "active", "disabled", "archived"] as const;
export type LandingTemplateStatus = (typeof LANDING_TEMPLATE_STATUSES)[number];

export const LANDING_TEMPLATE_ORIGINS = ["system", "custom"] as const;
export type LandingTemplateOrigin = (typeof LANDING_TEMPLATE_ORIGINS)[number];

export const LANDING_TEMPLATE_CATEGORIES = ["product", "service", "lead", "general"] as const;

const landingPageTemplateSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 60,
      match: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 400, default: "" },
    category: { type: String, enum: LANDING_TEMPLATE_CATEGORIES, default: "general" },
    origin: { type: String, enum: LANDING_TEMPLATE_ORIGINS, required: true },
    status: { type: String, enum: LANDING_TEMPLATE_STATUSES, default: "draft" },
    /** The published version new pages are created from. */
    currentVersionId: { type: Schema.Types.ObjectId, ref: "LandingPageTemplateVersion" },
    currentVersion: { type: Number },
    /** Highest version number allocated (draft or published). */
    latestVersion: { type: Number, default: 0 },
    sortOrder: { type: Number, default: 100 },
    /** Admin (Merchant._id with role=admin). Unset for system rows. */
    createdBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
  },
  { timestamps: true, collection: "landing_page_templates" },
);

landingPageTemplateSchema.index({ key: 1 }, { unique: true });
landingPageTemplateSchema.index({ status: 1, sortOrder: 1 });

export type LandingPageTemplate = InferSchemaType<typeof landingPageTemplateSchema> & {
  _id: Types.ObjectId;
};

export const LandingPageTemplate: Model<LandingPageTemplate> =
  (models.LandingPageTemplate as Model<LandingPageTemplate>) ||
  model<LandingPageTemplate>("LandingPageTemplate", landingPageTemplateSchema);

/**
 * A template version. Drafts are editable; once `status: "published"` the
 * row is immutable — every writer filters on `status: "draft"`, and the
 * query hooks below refuse any update that targets a published row, so an
 * admin edit can never change a live page pinned to this version.
 */
export const LANDING_TEMPLATE_VERSION_STATUSES = ["draft", "published"] as const;
export type LandingTemplateVersionStatus = (typeof LANDING_TEMPLATE_VERSION_STATUSES)[number];

const landingPageTemplateVersionSchema = new Schema(
  {
    templateId: { type: Schema.Types.ObjectId, ref: "LandingPageTemplate", required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: LANDING_TEMPLATE_VERSION_STATUSES, default: "draft" },
    /**
     * The template spec (`@ecom/landing` TemplateSpec): ordered sections,
     * field overrides (editable/required/default/label). Validated with
     * `parseTemplateSpec` at the router boundary before every write.
     */
    spec: { type: Schema.Types.Mixed, required: true },
    /** Spec format version (TemplateSpec.specVersion). */
    specVersion: { type: Number, required: true, default: 1 },
    /** sha256 of the canonical spec JSON — change detection for system seeds. */
    specHash: { type: String, required: true, maxlength: 64 },
    notes: { type: String, trim: true, maxlength: 500 },
    publishedAt: { type: Date },
    publishedBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
    createdBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
  },
  { timestamps: true, collection: "landing_page_template_versions", minimize: false },
);

landingPageTemplateVersionSchema.index({ templateId: 1, version: 1 }, { unique: true });
// At most one open draft per template.
landingPageTemplateVersionSchema.index(
  { templateId: 1 },
  { unique: true, partialFilterExpression: { status: "draft" }, name: "one_draft_per_template" },
);

function refusePublishedWrites(this: mongoose.Query<unknown, unknown>) {
  const filter = this.getFilter() as Record<string, unknown>;
  if (filter.status !== "draft") {
    throw new Error("LandingPageTemplateVersion updates must target status:'draft' — published versions are immutable");
  }
}
landingPageTemplateVersionSchema.pre("updateOne", refusePublishedWrites);
landingPageTemplateVersionSchema.pre("updateMany", refusePublishedWrites);
landingPageTemplateVersionSchema.pre("findOneAndUpdate", refusePublishedWrites);
landingPageTemplateVersionSchema.pre("replaceOne", refusePublishedWrites);
landingPageTemplateVersionSchema.pre("save", function (next) {
  if (!this.isNew && !this.isModified("status") && this.status === "published") {
    next(new Error("Published template versions are immutable"));
    return;
  }
  next();
});

export type LandingPageTemplateVersion = InferSchemaType<typeof landingPageTemplateVersionSchema> & {
  _id: Types.ObjectId;
};

export const LandingPageTemplateVersion: Model<LandingPageTemplateVersion> =
  (models.LandingPageTemplateVersion as Model<LandingPageTemplateVersion>) ||
  model<LandingPageTemplateVersion>("LandingPageTemplateVersion", landingPageTemplateVersionSchema);
