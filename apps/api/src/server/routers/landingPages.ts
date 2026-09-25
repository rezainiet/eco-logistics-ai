import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { SUPPORTED_LOCALES, readLocalized, templateDefaultLocale, templateLocales } from "@ecom/landing";
import {
  LandingPage,
  LandingPageHost,
  LandingPageRevision,
  LandingPageTemplate,
} from "@ecom/db";
import {
  billableProcedure,
  merchantObjectId,
  protectedProcedure,
  publicProcedure,
  router,
} from "../trpc.js";
import {
  type Actor,
  archivePage,
  checkSlug,
  claimSlug,
  createPage,
  duplicatePage,
  getOwnedPage,
  pageSummary,
  publicUrlFor,
  publishPage,
  renamePage,
  restoreRevision,
  saveDraft,
  setLocales,
  unpublishPage,
  upgradeTemplate,
} from "../../lib/landing/pages.js";
import { loadTemplateVersion } from "../../lib/landing/templates.js";
import { storeLandingAsset } from "../../lib/landing/assets.js";
import { landingAssetBaseUrl, resolveLandingPageByHost } from "../../lib/landing/resolve.js";

/**
 * Merchant landing pages. Tenant = the authenticated merchant: every
 * procedure derives merchantId from ctx, never from input.
 *
 * Reads use protectedProcedure. Mutations that create or publish content
 * use billableProcedure (active subscription required). Taking content
 * DOWN (unpublish, archive) stays available to lapsed merchants on
 * purpose — a merchant must always be able to remove their own page.
 */

type Ctx = {
  user: { id: string; email: string };
  request: { ip: string | null; userAgent: string | null };
};

function actorOf(ctx: Ctx): Actor {
  const id = merchantObjectId(ctx);
  return { merchantId: id, actorId: id, email: ctx.user.email, ip: ctx.request.ip, userAgent: ctx.request.userAgent };
}

const pageId = z.string().min(1).max(64);
const pageName = z.string().trim().min(1, "Give the page a name").max(80);
const revision = z.number().int().min(1);
const locale = z.enum(SUPPORTED_LOCALES);

export const landingPagesRouter = router({
  /** Templates a merchant can start from (active, with a published version). */
  templates: protectedProcedure.query(async () => {
    const rows = await LandingPageTemplate.find({ status: "active", currentVersionId: { $exists: true } })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    const out = [];
    for (const t of rows) {
      const v = t.currentVersionId ? await loadTemplateVersion(t.currentVersionId) : null;
      if (!v || v.status !== "published") continue;
      out.push({
        id: String(t._id),
        key: t.key,
        name: t.name,
        description: t.description ?? "",
        category: t.category,
        version: v.version,
        locales: templateLocales(v.spec),
        defaultLocale: templateDefaultLocale(v.spec),
        spec: v.spec,
      });
    }
    return out;
  }),

  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const filter: Record<string, unknown> = { merchantId };
      if (!input?.includeArchived) filter.status = { $ne: "archived" };
      const pages = await LandingPage.find(filter).sort({ updatedAt: -1 }).limit(500).lean();
      const templateIds = [...new Set(pages.map((p) => String(p.templateId)))];
      const templates = await LandingPageTemplate.find({ _id: { $in: templateIds } }).select("name").lean();
      const names = new Map(templates.map((t) => [String(t._id), t.name]));
      return pages.map((p) => ({ ...pageSummary(p), templateName: names.get(String(p.templateId)) ?? "Template" }));
    }),

  get: protectedProcedure.input(z.object({ id: pageId })).query(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    const page = await getOwnedPage(merchantId, input.id);
    const [version, template, revisions] = await Promise.all([
      loadTemplateVersion(page.templateVersionId),
      LandingPageTemplate.findById(page.templateId).select("name key status currentVersionId currentVersion").lean(),
      LandingPageRevision.find({ pageId: page._id, merchantId })
        .select("number templateVersionId createdAt fromDraftRevision")
        .sort({ number: -1 })
        .limit(30)
        .lean(),
    ]);
    if (!version) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Template version unavailable" });
    return {
      page: pageSummary(page),
      /** Localized: { <locale>: PageContent } for every enabled locale. */
      draftContent: readLocalized(page.draftContent) as Record<string, unknown>,
      allowedLocales: templateLocales(version.spec),
      spec: version.spec,
      template: {
        id: String(page.templateId),
        name: template?.name ?? "Template",
        key: template?.key ?? "",
        version: version.version,
        upgradeAvailable:
          !!template?.currentVersionId &&
          template.status === "active" &&
          !template.currentVersionId.equals(page.templateVersionId),
        latestVersion: template?.currentVersion ?? version.version,
      },
      revisions: revisions.map((r) => ({
        number: r.number,
        createdAt: r.createdAt,
        live: page.status === "published" && page.publishedRevisionNumber === r.number,
      })),
      assetBaseUrl: landingAssetBaseUrl(),
    };
  }),

  create: billableProcedure
    .input(z.object({ templateId: z.string().min(1).max(64), name: pageName, locale: locale.optional() }))
    .mutation(({ ctx, input }) => createPage(actorOf(ctx), input)),

  setLocales: billableProcedure
    .input(
      z.object({
        id: pageId,
        locales: z.array(locale).min(1).max(SUPPORTED_LOCALES.length),
        defaultLocale: locale,
        expectedRevision: revision,
        seed: z.enum(["template", "copy"]).default("template"),
      }),
    )
    .mutation(({ ctx, input }) =>
      setLocales(actorOf(ctx), {
        pageId: input.id,
        locales: input.locales,
        defaultLocale: input.defaultLocale,
        expectedRevision: input.expectedRevision,
        seed: input.seed,
      }),
    ),

  rename: billableProcedure
    .input(z.object({ id: pageId, name: pageName }))
    .mutation(({ ctx, input }) => renamePage(actorOf(ctx), { pageId: input.id, name: input.name })),

  saveDraft: billableProcedure
    .input(z.object({ id: pageId, content: z.unknown(), expectedRevision: revision }))
    .mutation(({ ctx, input }) =>
      saveDraft(actorOf(ctx), { pageId: input.id, content: input.content, expectedRevision: input.expectedRevision }),
    ),

  publish: billableProcedure
    .input(z.object({ id: pageId, expectedRevision: revision }))
    .mutation(({ ctx, input }) => publishPage(actorOf(ctx), { pageId: input.id, expectedRevision: input.expectedRevision })),

  unpublish: protectedProcedure
    .input(z.object({ id: pageId }))
    .mutation(({ ctx, input }) => unpublishPage(actorOf(ctx), { pageId: input.id })),

  archive: protectedProcedure
    .input(z.object({ id: pageId }))
    .mutation(({ ctx, input }) => archivePage(actorOf(ctx), { pageId: input.id })),

  duplicate: billableProcedure
    .input(z.object({ id: pageId, name: pageName.optional() }))
    .mutation(({ ctx, input }) => duplicatePage(actorOf(ctx), { pageId: input.id, name: input.name })),

  checkSlug: protectedProcedure
    .input(z.object({ slug: z.string().max(80), pageId: pageId.optional() }))
    .query(({ ctx, input }) => checkSlug(merchantObjectId(ctx), input.slug, input.pageId)),

  setSlug: billableProcedure
    .input(z.object({ id: pageId, slug: z.string().max(80) }))
    .mutation(async ({ ctx, input }) => {
      const r = await claimSlug(actorOf(ctx), { pageId: input.id, slug: input.slug });
      return { ...r, publicUrl: publicUrlFor(r.slug) };
    }),

  host: protectedProcedure.input(z.object({ id: pageId })).query(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    const page = await getOwnedPage(merchantId, input.id);
    const host = await LandingPageHost.findOne({ pageId: page._id, merchantId, status: "active" }).select("hostname").lean();
    return { slug: host?.hostname ?? null, previewUrl: publicUrlFor(host?.hostname) };
  }),

  restoreRevision: billableProcedure
    .input(z.object({ id: pageId, revisionNumber: z.number().int().min(1), expectedRevision: revision }))
    .mutation(({ ctx, input }) =>
      restoreRevision(actorOf(ctx), {
        pageId: input.id,
        revisionNumber: input.revisionNumber,
        expectedRevision: input.expectedRevision,
      }),
    ),

  upgradeTemplate: billableProcedure
    .input(z.object({ id: pageId, expectedRevision: revision }))
    .mutation(({ ctx, input }) => upgradeTemplate(actorOf(ctx), { pageId: input.id, expectedRevision: input.expectedRevision })),

  uploadAsset: billableProcedure
    // Size is enforced inside storeLandingAsset (decoded bytes) so the
    // merchant sees "Images must be 700 KB or smaller", not a schema dump.
    // express.json still caps the whole request at 1 MB.
    .input(z.object({ dataUrl: z.string().max(2_000_000) }))
    .mutation(async ({ ctx, input }) => {
      const id = merchantObjectId(ctx);
      const stored = await storeLandingAsset({ merchantId: id, actorId: id, dataUrl: input.dataUrl });
      return { ...stored, url: `${landingAssetBaseUrl()}/${stored.id}` };
    }),
});

/**
 * Public, unauthenticated resolution for the landing renderer. Input is a
 * hostname only; output is the published revision or a not-found.
 */
export const publicLandingRouter = router({
  resolveByHost: publicProcedure
    .input(z.object({ host: z.string().max(300), locale: z.string().max(8).nullish() }))
    .query(({ input }) => resolveLandingPageByHost(input.host, { locale: input.locale ?? null })),
});
