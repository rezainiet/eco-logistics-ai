import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import {
  TEMPLATE_CATEGORIES,
  blankTemplateSpec,
  listSectionTypes,
  parseTemplateSpec,
  templateDefaultLocale,
  templateLocales,
} from "@ecom/landing";
import { LandingPage, LandingPageTemplate, LandingPageTemplateVersion } from "@ecom/db";
import { router, scopedAdminProcedure } from "../trpc.js";
import { writeAdminAudit } from "../../lib/audit.js";
import { issuesError } from "../../lib/landing/pages.js";
import { specHash } from "../../lib/landing/templates.js";

/**
 * Admin template management (super_admin only via `landing.template.manage`).
 *
 * Version discipline:
 *   - An admin only ever edits a DRAFT version. At most one draft exists
 *     per template (unique partial index).
 *   - Publishing flips draft → published and points the template at it.
 *     Published versions are immutable (model hooks refuse updates), so
 *     existing pages pinned to older versions never change underneath
 *     their owners.
 *   - System templates are read-only; duplicate one to customise it.
 */

const manage = scopedAdminProcedure("landing.template.manage");

const templateKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers and hyphens")
  .min(3)
  .max(60);
const meta = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(""),
  category: z.enum(TEMPLATE_CATEGORIES).default("general"),
};

type AdminCtx = {
  user: { id: string; email: string };
  adminScope: string;
  request: { ip: string | null; userAgent: string | null };
};

function auditAdmin(
  ctx: AdminCtx,
  action: Parameters<typeof writeAdminAudit>[0]["action"],
  templateId: Types.ObjectId,
  metaData: Record<string, unknown>,
) {
  return writeAdminAudit({
    actorId: new Types.ObjectId(ctx.user.id),
    actorEmail: ctx.user.email,
    actorType: "admin",
    action,
    subjectType: "landing_template",
    subjectId: templateId,
    meta: { adminScope: ctx.adminScope, ...metaData },
    ip: ctx.request.ip,
    userAgent: ctx.request.userAgent,
  });
}

async function templateOrThrow(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
  const tpl = await LandingPageTemplate.findById(id).lean();
  if (!tpl) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
  return tpl;
}

function assertCustom(tpl: { origin: string }) {
  if (tpl.origin === "system") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "System templates are managed in code. Duplicate this template to customise it.",
    });
  }
}

function parseOrThrow(spec: unknown) {
  const parsed = parseTemplateSpec(spec);
  if (!parsed.ok) throw issuesError("Template spec is invalid", parsed.issues);
  return parsed.spec;
}

async function allocateVersion(templateId: Types.ObjectId): Promise<number> {
  const bumped = await LandingPageTemplate.findOneAndUpdate(
    { _id: templateId },
    { $inc: { latestVersion: 1 } },
    { new: true },
  ).lean();
  if (!bumped) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
  return bumped.latestVersion;
}

async function createDraftVersion(templateId: Types.ObjectId, spec: unknown, actorId: Types.ObjectId) {
  const parsed = parseOrThrow(spec);
  const version = await allocateVersion(templateId);
  try {
    return await LandingPageTemplateVersion.create({
      templateId,
      version,
      status: "draft",
      spec: parsed,
      specVersion: parsed.specVersion,
      specHash: specHash(parsed),
      createdBy: actorId,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new TRPCError({ code: "CONFLICT", message: "This template already has an open draft version" });
    }
    throw err;
  }
}

export const adminLandingTemplatesRouter = router({
  sectionTypes: manage.query(() =>
    listSectionTypes().map((s) => ({
      type: s.type,
      version: s.version,
      label: s.label,
      description: s.description,
      visual: s.visual,
      fields: s.fields.map((f) => ({ key: f.key, type: f.type, label: f.label, required: !!f.required })),
    })),
  ),

  list: manage.query(async () => {
    const [templates, drafts, usage] = await Promise.all([
      LandingPageTemplate.find({}).sort({ status: 1, sortOrder: 1, createdAt: 1 }).lean(),
      LandingPageTemplateVersion.find({ status: "draft" }).select("templateId version spec").lean(),
      LandingPage.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { status: { $ne: "archived" } } },
        { $group: { _id: "$templateId", count: { $sum: 1 } } },
      ]),
    ]);
    const draftBy = new Map(drafts.map((d) => [String(d.templateId), d]));
    const currentIds = templates.map((t) => t.currentVersionId).filter(Boolean);
    const currents = await LandingPageTemplateVersion.find({ _id: { $in: currentIds } }).select("spec").lean();
    const currentBy = new Map(currents.map((v) => [String(v._id), v.spec]));
    const usageBy = new Map(usage.map((u) => [String(u._id), u.count]));
    return templates.map((t) => {
      const draft = draftBy.get(String(t._id));
      // Thumbnail: the live version, else the open draft.
      const parsed = parseTemplateSpec((t.currentVersionId && currentBy.get(String(t.currentVersionId))) ?? draft?.spec);
      const previewSpec = parsed.ok ? parsed.spec : null;
      return {
      id: String(t._id),
      key: t.key,
      name: t.name,
      description: t.description ?? "",
      category: t.category,
      origin: t.origin,
      status: t.status,
      currentVersion: t.currentVersion ?? null,
      draftVersion: draft?.version ?? null,
      pageCount: usageBy.get(String(t._id)) ?? 0,
      updatedAt: t.updatedAt,
      previewSpec,
      locales: previewSpec ? templateLocales(previewSpec) : [],
      defaultLocale: previewSpec ? templateDefaultLocale(previewSpec) : null,
    };
    });
  }),

  get: manage.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const tpl = await templateOrThrow(input.id);
    const versions = await LandingPageTemplateVersion.find({ templateId: tpl._id }).sort({ version: -1 }).lean();
    return {
      template: {
        id: String(tpl._id),
        key: tpl.key,
        name: tpl.name,
        description: tpl.description ?? "",
        category: tpl.category,
        origin: tpl.origin,
        status: tpl.status,
        currentVersionId: tpl.currentVersionId ? String(tpl.currentVersionId) : null,
        currentVersion: tpl.currentVersion ?? null,
      },
      versions: versions.map((v) => ({
        id: String(v._id),
        version: v.version,
        status: v.status,
        spec: v.spec as unknown,
        specHash: v.specHash,
        notes: v.notes ?? null,
        publishedAt: v.publishedAt ?? null,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
    };
  }),

  create: manage
    .input(z.object({ key: templateKey, ...meta }))
    .mutation(async ({ ctx, input }) => {
      const actorId = new Types.ObjectId(ctx.user.id);
      let tpl;
      try {
        tpl = await LandingPageTemplate.create({
          key: input.key,
          name: input.name,
          description: input.description,
          category: input.category,
          origin: "custom",
          status: "draft",
          latestVersion: 0,
          createdBy: actorId,
          updatedBy: actorId,
        });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          throw new TRPCError({ code: "CONFLICT", message: "A template with that key already exists" });
        }
        throw err;
      }
      const draft = await createDraftVersion(tpl._id, blankTemplateSpec(), actorId);
      await auditAdmin(ctx, "landing.template_created", tpl._id, { key: input.key });
      return { id: String(tpl._id), draftVersionId: String(draft._id) };
    }),

  duplicate: manage
    .input(z.object({ id: z.string(), key: templateKey, name: meta.name }))
    .mutation(async ({ ctx, input }) => {
      const source = await templateOrThrow(input.id);
      const sourceVersion =
        (source.currentVersionId && (await LandingPageTemplateVersion.findById(source.currentVersionId).lean())) ||
        (await LandingPageTemplateVersion.findOne({ templateId: source._id }).sort({ version: -1 }).lean());
      if (!sourceVersion) throw new TRPCError({ code: "BAD_REQUEST", message: "Source template has no versions" });
      const actorId = new Types.ObjectId(ctx.user.id);
      let tpl;
      try {
        tpl = await LandingPageTemplate.create({
          key: input.key,
          name: input.name,
          description: source.description,
          category: source.category,
          origin: "custom",
          status: "draft",
          latestVersion: 0,
          createdBy: actorId,
          updatedBy: actorId,
        });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          throw new TRPCError({ code: "CONFLICT", message: "A template with that key already exists" });
        }
        throw err;
      }
      const draft = await createDraftVersion(tpl._id, sourceVersion.spec, actorId);
      await auditAdmin(ctx, "landing.template_created", tpl._id, {
        key: input.key,
        duplicatedFrom: source.key,
        sourceVersion: sourceVersion.version,
      });
      return { id: String(tpl._id), draftVersionId: String(draft._id) };
    }),

  updateMeta: manage
    .input(z.object({ id: z.string(), ...meta }))
    .mutation(async ({ ctx, input }) => {
      const tpl = await templateOrThrow(input.id);
      assertCustom(tpl);
      await LandingPageTemplate.updateOne(
        { _id: tpl._id },
        {
          $set: {
            name: input.name,
            description: input.description,
            category: input.category,
            updatedBy: new Types.ObjectId(ctx.user.id),
          },
        },
      );
      await auditAdmin(ctx, "landing.template_updated", tpl._id, { fields: ["name", "description", "category"] });
      return { ok: true };
    }),

  /** Open a draft version, seeded from the current published spec. */
  createDraft: manage.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const tpl = await templateOrThrow(input.id);
    assertCustom(tpl);
    const existing = await LandingPageTemplateVersion.findOne({ templateId: tpl._id, status: "draft" }).lean();
    if (existing) return { draftVersionId: String(existing._id), version: existing.version };
    const base = tpl.currentVersionId ? await LandingPageTemplateVersion.findById(tpl.currentVersionId).lean() : null;
    const draft = await createDraftVersion(tpl._id, base?.spec ?? blankTemplateSpec(), new Types.ObjectId(ctx.user.id));
    return { draftVersionId: String(draft._id), version: draft.version };
  }),

  saveDraft: manage
    .input(z.object({ id: z.string(), versionId: z.string(), spec: z.unknown(), notes: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const tpl = await templateOrThrow(input.id);
      assertCustom(tpl);
      const spec = parseOrThrow(input.spec);
      if (!Types.ObjectId.isValid(input.versionId)) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found" });
      const res = await LandingPageTemplateVersion.updateOne(
        { _id: input.versionId, templateId: tpl._id, status: "draft" },
        {
          $set: {
            spec,
            specVersion: spec.specVersion,
            specHash: specHash(spec),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          },
        },
      );
      if (res.matchedCount === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That version is already published and can no longer change. Create a new draft.",
        });
      }
      await LandingPageTemplate.updateOne({ _id: tpl._id }, { $set: { updatedBy: new Types.ObjectId(ctx.user.id) } });
      return { ok: true };
    }),

  publishDraft: manage
    .input(z.object({ id: z.string(), versionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const tpl = await templateOrThrow(input.id);
      assertCustom(tpl);
      if (!Types.ObjectId.isValid(input.versionId)) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found" });
      const draft = await LandingPageTemplateVersion.findOne({ _id: input.versionId, templateId: tpl._id, status: "draft" }).lean();
      if (!draft) throw new TRPCError({ code: "CONFLICT", message: "No open draft with that id" });
      parseOrThrow(draft.spec);
      const actorId = new Types.ObjectId(ctx.user.id);
      const published = await LandingPageTemplateVersion.findOneAndUpdate(
        { _id: draft._id, templateId: tpl._id, status: "draft" },
        { $set: { status: "published", publishedAt: new Date(), publishedBy: actorId } },
        { new: true },
      ).lean();
      if (!published) throw new TRPCError({ code: "CONFLICT", message: "That draft was already published" });
      await LandingPageTemplate.updateOne(
        { _id: tpl._id },
        {
          $set: {
            currentVersionId: published._id,
            currentVersion: published.version,
            updatedBy: actorId,
            ...(tpl.status === "draft" ? { status: "active" } : {}),
          },
        },
      );
      await auditAdmin(ctx, "landing.template_version_published", tpl._id, {
        version: published.version,
        specHash: published.specHash,
      });
      return { version: published.version };
    }),

  setStatus: manage
    .input(z.object({ id: z.string(), status: z.enum(["active", "disabled", "archived"]) }))
    .mutation(async ({ ctx, input }) => {
      const tpl = await templateOrThrow(input.id);
      if (input.status === "active" && !tpl.currentVersionId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Publish a version before activating this template" });
      }
      await LandingPageTemplate.updateOne(
        { _id: tpl._id },
        { $set: { status: input.status, updatedBy: new Types.ObjectId(ctx.user.id) } },
      );
      await auditAdmin(ctx, "landing.template_status_changed", tpl._id, { from: tpl.status, to: input.status });
      return { ok: true };
    }),
});
