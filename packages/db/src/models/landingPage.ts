import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

/**
 * A merchant's landing page. Tenant = Merchant; every read and write is
 * scoped by `merchantId` (see apps/api/src/server/routers/landingPages.ts).
 *
 * Draft vs live:
 *   - `draftContent` + `draftRevision` is what the editor edits. Saving
 *     bumps `draftRevision` with a compare-and-set, so a stale editor gets
 *     CONFLICT instead of silently overwriting newer work.
 *   - What the public sees is the immutable `LandingPageRevision` named by
 *     `publishedRevisionId`, and only while `status === "published"`.
 *     Editing the draft never touches it.
 *
 * `templateVersionId` pins the draft to an exact template version. Pages do
 * not follow template edits automatically; the owner opts in to upgrade.
 */
export const LANDING_PAGE_STATUSES = ["draft", "published", "unpublished", "archived"] as const;
export type LandingPageStatus = (typeof LANDING_PAGE_STATUSES)[number];

const landingPageSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    templateId: { type: Schema.Types.ObjectId, ref: "LandingPageTemplate", required: true },
    templateVersionId: { type: Schema.Types.ObjectId, ref: "LandingPageTemplateVersion", required: true },
    status: { type: String, enum: LANDING_PAGE_STATUSES, default: "draft" },

    draftContent: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    draftRevision: { type: Number, required: true, default: 1, min: 1 },
    draftUpdatedAt: { type: Date },
    draftUpdatedBy: { type: Schema.Types.ObjectId, ref: "Merchant" },

    /** Last allocated LandingPageRevision.number for this page. */
    revisionCounter: { type: Number, default: 0 },
    publishedRevisionId: { type: Schema.Types.ObjectId, ref: "LandingPageRevision" },
    publishedRevisionNumber: { type: Number },
    /** draftRevision that produced the current published revision. */
    publishedFromDraftRevision: { type: Number },
    publishedAt: { type: Date },
    unpublishedAt: { type: Date },
    archivedAt: { type: Date },

    /** Denormalised from the active LandingPageHost, for listing only. */
    slug: { type: String, trim: true, lowercase: true, maxlength: 63 },
  },
  { timestamps: true, collection: "landing_pages", minimize: false },
);

landingPageSchema.index({ merchantId: 1, status: 1, updatedAt: -1 });
landingPageSchema.index({ merchantId: 1, templateId: 1 });

export type LandingPage = InferSchemaType<typeof landingPageSchema> & { _id: Types.ObjectId };

export const LandingPage: Model<LandingPage> =
  (models.LandingPage as Model<LandingPage>) || model<LandingPage>("LandingPage", landingPageSchema);

/**
 * Immutable snapshot of what was published. Created once per publish and
 * never updated (query hooks below refuse updates outright). Rollback
 * copies a revision back into the draft; it never edits history.
 */
const landingPageRevisionSchema = new Schema(
  {
    pageId: { type: Schema.Types.ObjectId, ref: "LandingPage", required: true },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    number: { type: Number, required: true, min: 1 },
    templateId: { type: Schema.Types.ObjectId, ref: "LandingPageTemplate", required: true },
    templateVersionId: { type: Schema.Types.ObjectId, ref: "LandingPageTemplateVersion", required: true },
    content: { type: Schema.Types.Mixed, required: true },
    /** The draftRevision this snapshot was taken from. */
    fromDraftRevision: { type: Number, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "landing_page_revisions",
    minimize: false,
  },
);

landingPageRevisionSchema.index({ pageId: 1, number: 1 }, { unique: true });
landingPageRevisionSchema.index({ merchantId: 1, pageId: 1, number: -1 });

function refuseRevisionUpdate() {
  throw new Error("LandingPageRevision is immutable");
}
landingPageRevisionSchema.pre("updateOne", refuseRevisionUpdate);
landingPageRevisionSchema.pre("updateMany", refuseRevisionUpdate);
landingPageRevisionSchema.pre("findOneAndUpdate", refuseRevisionUpdate);
landingPageRevisionSchema.pre("replaceOne", refuseRevisionUpdate);
landingPageRevisionSchema.pre("save", function (next) {
  if (!this.isNew) {
    next(new Error("LandingPageRevision is immutable"));
    return;
  }
  next();
});

export type LandingPageRevision = InferSchemaType<typeof landingPageRevisionSchema> & {
  _id: Types.ObjectId;
};

export const LandingPageRevision: Model<LandingPageRevision> =
  (models.LandingPageRevision as Model<LandingPageRevision>) ||
  model<LandingPageRevision>("LandingPageRevision", landingPageRevisionSchema);
