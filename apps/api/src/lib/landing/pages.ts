import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import {
  type ContentIssue,
  MAX_CONTENT_BYTES,
  coerceContent,
  defaultContent,
  landingPublicUrl,
  validateContent,
  validateSlug,
} from "@ecom/landing";
import {
  LandingPage,
  LandingPageHost,
  LandingPageRevision,
  LandingPageTemplate,
} from "@ecom/db";
import { env } from "../../env.js";
import { writeAudit } from "../audit.js";
import { assertAssetsOwned } from "./assets.js";
import { invalidateLandingHost } from "./resolve.js";
import { type LoadedVersion, loadTemplateVersion } from "./templates.js";

/**
 * Merchant landing-page lifecycle. Every function takes the merchant id
 * from the authenticated context and every query filters on it — a page id
 * from another tenant behaves exactly like a page that does not exist.
 *
 * Concurrency: the draft is guarded by `draftRevision` compare-and-set.
 * Publishing is a sequence of single-document atomic writes (allocate a
 * revision number → insert the immutable revision → flip the page pointer),
 * each conditioned on the same `draftRevision`, so it needs no multi-
 * document transaction: a lost race leaves at worst an orphan revision that
 * nothing points to.
 */

export interface Actor {
  merchantId: Types.ObjectId;
  actorId: Types.ObjectId;
  email?: string;
  ip?: string | null;
  userAgent?: string | null;
}

type PageDoc = NonNullable<Awaited<ReturnType<typeof findOwned>>>;

function oid(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw new TRPCError({ code: "NOT_FOUND", message: "Landing page not found" });
  return new Types.ObjectId(id);
}

async function findOwned(merchantId: Types.ObjectId, pageId: string) {
  return LandingPage.findOne({ _id: oid(pageId), merchantId }).lean();
}

export async function getOwnedPage(merchantId: Types.ObjectId, pageId: string): Promise<PageDoc> {
  const page = await findOwned(merchantId, pageId);
  if (!page) throw new TRPCError({ code: "NOT_FOUND", message: "Landing page not found" });
  return page;
}

function assertEditable(page: PageDoc) {
  if (page.status === "archived") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This page is archived" });
  }
}

export function issuesError(prefix: string, issues: ContentIssue[]): TRPCError {
  const lines = issues.slice(0, 8).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
  const more = issues.length > 8 ? ` (+${issues.length - 8} more)` : "";
  return new TRPCError({ code: "BAD_REQUEST", message: `${prefix} — ${lines.join("; ")}${more}` });
}

async function versionOrThrow(id: Types.ObjectId | string): Promise<LoadedVersion> {
  const v = await loadTemplateVersion(id);
  if (!v) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Template version unavailable" });
  return v;
}

async function conflictOrMissing(merchantId: Types.ObjectId, pageId: string): Promise<never> {
  const exists = await findOwned(merchantId, pageId);
  if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "Landing page not found" });
  if (exists.status === "archived") throw new TRPCError({ code: "BAD_REQUEST", message: "This page is archived" });
  throw new TRPCError({
    code: "CONFLICT",
    message: "This page was changed in another tab or by someone else. Reload to get the latest version.",
  });
}

function audit(actor: Actor, action: Parameters<typeof writeAudit>[0]["action"], pageId: Types.ObjectId, meta: Record<string, unknown>) {
  return writeAudit({
    merchantId: actor.merchantId,
    actorId: actor.actorId,
    actorEmail: actor.email,
    actorType: "merchant",
    action,
    subjectType: "landing_page",
    subjectId: pageId,
    meta,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
}

export function publicUrlFor(slug: string | null | undefined): string | null {
  const pattern =
    env.LANDING_PUBLIC_URL_PATTERN ?? (env.NODE_ENV === "production" ? null : "http://{slug}.localhost:3002");
  return landingPublicUrl(pattern, slug);
}

export function pageSummary(page: PageDoc) {
  return {
    id: String(page._id),
    name: page.name,
    status: page.status,
    templateId: String(page.templateId),
    templateVersionId: String(page.templateVersionId),
    slug: page.slug ?? null,
    publicUrl: page.status === "published" ? publicUrlFor(page.slug) : null,
    draftRevision: page.draftRevision,
    publishedRevisionNumber: page.publishedRevisionNumber ?? null,
    publishedAt: page.publishedAt ?? null,
    hasUnpublishedChanges:
      page.status === "published" && page.publishedFromDraftRevision !== page.draftRevision,
    updatedAt: page.updatedAt,
    createdAt: page.createdAt,
  };
}

async function assertUnderPageLimit(merchantId: Types.ObjectId) {
  const count = await LandingPage.countDocuments({ merchantId, status: { $ne: "archived" } });
  if (count >= env.LANDING_MAX_PAGES_PER_MERCHANT) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You can have up to ${env.LANDING_MAX_PAGES_PER_MERCHANT} landing pages. Archive one to create another.`,
    });
  }
}

export async function createPage(actor: Actor, input: { templateId: string; name: string }) {
  await assertUnderPageLimit(actor.merchantId);
  if (!Types.ObjectId.isValid(input.templateId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
  }
  const tpl = await LandingPageTemplate.findOne({ _id: input.templateId, status: "active" }).lean();
  if (!tpl?.currentVersionId) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
  const version = await versionOrThrow(tpl.currentVersionId);
  if (version.status !== "published") throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });

  const page = await LandingPage.create({
    merchantId: actor.merchantId,
    name: input.name,
    templateId: tpl._id,
    templateVersionId: tpl.currentVersionId,
    status: "draft",
    draftContent: defaultContent(version.spec),
    draftRevision: 1,
    draftUpdatedAt: new Date(),
    draftUpdatedBy: actor.actorId,
  });
  await audit(actor, "landing.page_created", page._id, { templateKey: tpl.key, templateVersion: version.version });
  return pageSummary(page.toObject() as PageDoc);
}

function contentSize(content: unknown): number {
  return Buffer.byteLength(JSON.stringify(content ?? null), "utf8");
}

export async function saveDraft(
  actor: Actor,
  input: { pageId: string; content: unknown; expectedRevision: number },
) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  assertEditable(page);
  if (contentSize(input.content) > MAX_CONTENT_BYTES) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Page content is too large" });
  }
  const version = await versionOrThrow(page.templateVersionId);
  const result = validateContent(version.spec, input.content, "draft");
  if (!result.ok) throw issuesError("Draft not saved", result.issues);
  await assertAssetsOwned(actor.merchantId, result.content);

  const updated = await LandingPage.findOneAndUpdate(
    {
      _id: page._id,
      merchantId: actor.merchantId,
      draftRevision: input.expectedRevision,
      status: { $ne: "archived" },
    },
    {
      $set: { draftContent: result.content, draftUpdatedAt: new Date(), draftUpdatedBy: actor.actorId },
      $inc: { draftRevision: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) return conflictOrMissing(actor.merchantId, input.pageId);
  return { page: pageSummary(updated), content: result.content };
}

export async function publishPage(actor: Actor, input: { pageId: string; expectedRevision: number }) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  assertEditable(page);
  if (page.draftRevision !== input.expectedRevision) return conflictOrMissing(actor.merchantId, input.pageId);

  const host = await LandingPageHost.findOne({ pageId: page._id, merchantId: actor.merchantId, status: "active" }).lean();
  if (!host) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a subdomain for this page before publishing" });
  }

  // Nothing changed since the live revision — publishing again is a no-op.
  if (page.status === "published" && page.publishedFromDraftRevision === page.draftRevision) {
    return { page: pageSummary(page), revisionNumber: page.publishedRevisionNumber ?? null, unchanged: true };
  }

  const version = await versionOrThrow(page.templateVersionId);
  if (version.status !== "published") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This page's template version is not published" });
  }
  const result = validateContent(version.spec, page.draftContent, "publish");
  if (!result.ok) throw issuesError("Page not published", result.issues);
  await assertAssetsOwned(actor.merchantId, result.content);

  const allocated = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId, draftRevision: input.expectedRevision, status: { $ne: "archived" } },
    { $inc: { revisionCounter: 1 } },
    { new: true },
  ).lean();
  if (!allocated) return conflictOrMissing(actor.merchantId, input.pageId);

  const revision = await LandingPageRevision.create({
    pageId: page._id,
    merchantId: actor.merchantId,
    number: allocated.revisionCounter,
    templateId: page.templateId,
    templateVersionId: page.templateVersionId,
    content: result.content,
    fromDraftRevision: input.expectedRevision,
    createdBy: actor.actorId,
  });

  const now = new Date();
  const live = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId, draftRevision: input.expectedRevision, status: { $ne: "archived" } },
    {
      $set: {
        status: "published",
        publishedRevisionId: revision._id,
        publishedRevisionNumber: revision.number,
        publishedFromDraftRevision: input.expectedRevision,
        publishedAt: now,
      },
      $unset: { unpublishedAt: 1 },
    },
    { new: true },
  ).lean();
  if (!live) return conflictOrMissing(actor.merchantId, input.pageId);

  await invalidateLandingHost(host.hostname);
  await audit(actor, "landing.page_published", page._id, {
    revision: revision.number,
    templateVersionId: String(page.templateVersionId),
    slug: host.hostname,
  });
  return { page: pageSummary(live), revisionNumber: revision.number, unchanged: false };
}

export async function unpublishPage(actor: Actor, input: { pageId: string }) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  if (page.status !== "published") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This page is not published" });
  }
  const updated = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId, status: "published" },
    { $set: { status: "unpublished", unpublishedAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) return conflictOrMissing(actor.merchantId, input.pageId);
  await invalidateLandingHost(page.slug);
  await audit(actor, "landing.page_unpublished", page._id, { revision: page.publishedRevisionNumber });
  return pageSummary(updated);
}

function holdUntil(from: Date): Date {
  return new Date(from.getTime() + env.LANDING_SLUG_HOLD_DAYS * 24 * 60 * 60 * 1000);
}

async function releaseActiveHost(merchantId: Types.ObjectId, pageId: Types.ObjectId): Promise<string | null> {
  const now = new Date();
  const released = await LandingPageHost.findOneAndUpdate(
    { pageId, merchantId, status: "active" },
    { $set: { status: "released", releasedAt: now, reusableAfter: holdUntil(now) } },
    { new: true },
  ).lean();
  return released?.hostname ?? null;
}

export async function archivePage(actor: Actor, input: { pageId: string }) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  if (page.status === "archived") return pageSummary(page);
  const updated = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId, status: { $ne: "archived" } },
    { $set: { status: "archived", archivedAt: new Date() }, $unset: { slug: 1 } },
    { new: true },
  ).lean();
  if (!updated) return conflictOrMissing(actor.merchantId, input.pageId);
  const released = await releaseActiveHost(actor.merchantId, page._id);
  await invalidateLandingHost(released ?? page.slug);
  await audit(actor, "landing.page_archived", page._id, { releasedSlug: released });
  return pageSummary(updated);
}

export async function renamePage(actor: Actor, input: { pageId: string; name: string }) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  assertEditable(page);
  const updated = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId },
    { $set: { name: input.name } },
    { new: true },
  ).lean();
  if (!updated) return conflictOrMissing(actor.merchantId, input.pageId);
  return pageSummary(updated);
}

export async function duplicatePage(actor: Actor, input: { pageId: string; name?: string }) {
  const source = await getOwnedPage(actor.merchantId, input.pageId);
  await assertUnderPageLimit(actor.merchantId);
  const copy = await LandingPage.create({
    merchantId: actor.merchantId,
    name: (input.name ?? `${source.name} (copy)`).slice(0, 80),
    templateId: source.templateId,
    templateVersionId: source.templateVersionId,
    status: "draft",
    draftContent: source.draftContent,
    draftRevision: 1,
    draftUpdatedAt: new Date(),
    draftUpdatedBy: actor.actorId,
  });
  await audit(actor, "landing.page_created", copy._id, { duplicatedFrom: String(source._id) });
  return pageSummary(copy.toObject() as PageDoc);
}

export type SlugAvailability =
  | { available: true; slug: string }
  | { available: false; slug: string; reason: "format" | "length" | "reserved" | "taken" | "held"; message: string };

export async function checkSlug(merchantId: Types.ObjectId, rawSlug: string, pageId?: string): Promise<SlugAvailability> {
  const check = validateSlug(rawSlug);
  if (!check.ok) return { available: false, slug: rawSlug, reason: check.reason, message: check.message };
  const existing = await LandingPageHost.findOne({ hostname: check.slug }).lean();
  if (!existing) return { available: true, slug: check.slug };
  if (existing.status === "active") {
    if (pageId && String(existing.pageId) === pageId && existing.merchantId.equals(merchantId)) {
      return { available: true, slug: check.slug };
    }
    return { available: false, slug: check.slug, reason: "taken", message: "That subdomain is already taken" };
  }
  const sameOwner = existing.merchantId.equals(merchantId);
  if (!sameOwner && existing.reusableAfter && existing.reusableAfter > new Date()) {
    return { available: false, slug: check.slug, reason: "held", message: "That subdomain was recently released and is not available yet" };
  }
  return { available: true, slug: check.slug };
}

export async function claimSlug(actor: Actor, input: { pageId: string; slug: string }) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  assertEditable(page);
  const availability = await checkSlug(actor.merchantId, input.slug, input.pageId);
  if (!availability.available) {
    throw new TRPCError({
      code: availability.reason === "taken" || availability.reason === "held" ? "CONFLICT" : "BAD_REQUEST",
      message: availability.message,
    });
  }
  const slug = availability.slug;
  const current = await LandingPageHost.findOne({ pageId: page._id, merchantId: actor.merchantId, status: "active" }).lean();
  if (current?.hostname === slug) return { slug, page: pageSummary(page) };

  // One active host per page (unique partial index): release the old one
  // first. It stays held for this merchant, so they can take it back.
  const released = current ? await releaseActiveHost(actor.merchantId, page._id) : null;

  const taken = async () => {
    // Re-check under the unique index: claim a released row atomically, or insert.
    const existing = await LandingPageHost.findOne({ hostname: slug }).lean();
    if (existing) {
      const claimable =
        existing.status === "released" &&
        (existing.merchantId.equals(actor.merchantId) || !existing.reusableAfter || existing.reusableAfter <= new Date());
      if (!claimable) return false;
      const got = await LandingPageHost.findOneAndUpdate(
        { _id: existing._id, status: "released" },
        {
          $set: { status: "active", merchantId: actor.merchantId, pageId: page._id },
          $unset: { releasedAt: 1, reusableAfter: 1 },
        },
        { new: true },
      ).lean();
      return !!got;
    }
    try {
      await LandingPageHost.create({ hostname: slug, merchantId: actor.merchantId, pageId: page._id, status: "active" });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  };

  if (!(await taken())) {
    throw new TRPCError({ code: "CONFLICT", message: "That subdomain was just taken. Try another." });
  }
  const updated = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId },
    { $set: { slug } },
    { new: true },
  ).lean();
  await invalidateLandingHost(released);
  await invalidateLandingHost(slug);
  await audit(actor, "landing.slug_claimed", page._id, { slug, previous: released });
  return { slug, page: pageSummary(updated ?? page) };
}

export async function restoreRevision(
  actor: Actor,
  input: { pageId: string; revisionNumber: number; expectedRevision: number },
) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  assertEditable(page);
  const revision = await LandingPageRevision.findOne({
    pageId: page._id,
    merchantId: actor.merchantId,
    number: input.revisionNumber,
  }).lean();
  if (!revision) throw new TRPCError({ code: "NOT_FOUND", message: "Revision not found" });
  const updated = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId, draftRevision: input.expectedRevision, status: { $ne: "archived" } },
    {
      $set: {
        draftContent: revision.content,
        templateVersionId: revision.templateVersionId,
        draftUpdatedAt: new Date(),
        draftUpdatedBy: actor.actorId,
      },
      $inc: { draftRevision: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) return conflictOrMissing(actor.merchantId, input.pageId);
  return pageSummary(updated);
}

export async function upgradeTemplate(actor: Actor, input: { pageId: string; expectedRevision: number }) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  assertEditable(page);
  const tpl = await LandingPageTemplate.findById(page.templateId).lean();
  if (!tpl?.currentVersionId || tpl.status !== "active") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This template has no newer version available" });
  }
  if (tpl.currentVersionId.equals(page.templateVersionId)) {
    return { page: pageSummary(page), upgraded: false };
  }
  const target = await versionOrThrow(tpl.currentVersionId);
  const updated = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId, draftRevision: input.expectedRevision, status: { $ne: "archived" } },
    {
      $set: {
        templateVersionId: tpl.currentVersionId,
        draftContent: coerceContent(target.spec, page.draftContent),
        draftUpdatedAt: new Date(),
        draftUpdatedBy: actor.actorId,
      },
      $inc: { draftRevision: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) return conflictOrMissing(actor.merchantId, input.pageId);
  return { page: pageSummary(updated), upgraded: true };
}
