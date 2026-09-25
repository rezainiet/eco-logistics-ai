import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  AuditLog,
  LandingAsset,
  LandingPage,
  LandingPageHost,
  LandingPageRevision,
  LandingPageTemplate,
  LandingPageTemplateVersion,
  Merchant,
} from "@ecom/db";
import { invalidateAdminProfile } from "../src/lib/admin-rbac.js";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { sniffImageMime } from "../src/lib/landing/assets.js";
import { invalidateSubscriptionCache } from "../src/server/trpc.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

const ROOT = "pages.test";

type C = Record<string, Record<string, unknown>>;
/** English content of a (localized) draft. */
const en = (got: { draftContent: unknown }) => (got.draftContent as Record<string, C>).en!;
/** Wrap single-locale content in the localized shape saveDraft expects. */
const L = (c: unknown) => ({ en: c });
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function setup() {
  await ensureSystemTemplates();
  const merchant = await createMerchant();
  const caller = callerFor(authUserFor(merchant));
  const templates = await caller.landingPages.templates();
  const launch = templates.find((t) => t.key === "launch")!;
  return { merchant, caller, templates, launch };
}

async function publishable(caller: ReturnType<typeof callerFor>, pageId: string, slug: string) {
  const got = await caller.landingPages.get({ id: pageId });
  const content = en(got);
  content.order!.cta = { label: "Order on WhatsApp", action: { kind: "whatsapp", phone: "+8801711000000" } };
  const saved = await caller.landingPages.saveDraft({
    id: pageId,
    content: L(content),
    expectedRevision: got.page.draftRevision,
  });
  await caller.landingPages.setSlug({ id: pageId, slug });
  return { content, revision: saved.page.draftRevision };
}

const resolve = (host: string) => resolveLandingPageByHost(host, { rootDomain: ROOT, useCache: false });

describe("landing pages", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });
  afterAll(disconnectDb);

  describe("system template seeding", () => {
    it("is idempotent and versions only on spec change", async () => {
      const first = await ensureSystemTemplates();
      expect(first.created).toBe(5);
      expect(first.versioned).toBe(5);
      const again = await ensureSystemTemplates();
      expect(again).toEqual({ created: 0, versioned: 0 });

      const tpl = await LandingPageTemplate.findOne({ key: "launch" }).lean();
      // Simulate a code change by altering the stored hash (raw driver — the
      // model refuses updates to published versions).
      await LandingPageTemplateVersion.collection.updateOne({ _id: tpl!.currentVersionId! }, { $set: { specHash: "stale" } });
      const bumped = await ensureSystemTemplates();
      expect(bumped.versioned).toBe(1);
      const after = await LandingPageTemplate.findOne({ key: "launch" }).lean();
      expect(after!.currentVersion).toBe(2);
      expect(await LandingPageTemplateVersion.countDocuments({ templateId: tpl!._id })).toBe(2);
    });
  });

  describe("merchant lifecycle", () => {
    it("lets a merchant create multiple pages from different templates", async () => {
      const { caller, templates } = await setup();
      expect(templates.map((t) => t.key)).toEqual(["bd-modern-shop", "bd-premium-brand", "launch", "showcase", "local-service"]);
      for (const t of templates) {
        await caller.landingPages.create({ templateId: t.id, name: `Page ${t.key}` });
      }
      await caller.landingPages.create({ templateId: templates[0]!.id, name: "Second launch page" });
      const list = await caller.landingPages.list();
      expect(list).toHaveLength(templates.length + 1);
      expect(list.every((p) => p.status === "draft")).toBe(true);
    });

    it("saves drafts with optimistic concurrency", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Launch" });
      const got = await caller.landingPages.get({ id: page.id });
      const content = en(got);
      content.hero!.headline = "First edit";
      const saved = await caller.landingPages.saveDraft({ id: page.id, content: L(content), expectedRevision: 1 });
      expect(saved.page.draftRevision).toBe(2);

      content.hero!.headline = "Stale edit";
      await expect(
        caller.landingPages.saveDraft({ id: page.id, content: L(content), expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const stored = await LandingPage.findById(page.id).lean();
      expect((stored!.draftContent as Record<string, C>).en!.hero!.headline).toBe("First edit");
    });

    it("validates drafts server-side (locked fields, unsafe URLs, unknown keys)", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Launch" });
      const got = await caller.landingPages.get({ id: page.id });
      const base = en(got);

      const locked = structuredClone(base);
      locked.hero!.variant = "banner";
      await expect(caller.landingPages.saveDraft({ id: page.id, content: L(locked), expectedRevision: 1 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });

      const js = structuredClone(base);
      js.hero!.primaryCta = { label: "x", action: { kind: "link", url: "javascript:alert(1)" } };
      await expect(caller.landingPages.saveDraft({ id: page.id, content: L(js), expectedRevision: 1 })).rejects.toThrow(/Unsafe/);

      const extra = { ...structuredClone(base), script: { src: "https://evil.example/x.js" } };
      await expect(caller.landingPages.saveDraft({ id: page.id, content: L(extra), expectedRevision: 1 })).rejects.toThrow(
        /Unknown section/,
      );
    });

    it("publishes into an immutable revision; draft edits never change the live page", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Launch" });

      await expect(caller.landingPages.publish({ id: page.id, expectedRevision: 1 })).rejects.toThrow(/subdomain/);

      const { content, revision } = await publishable(caller, page.id, "nova-store");
      const pub = await caller.landingPages.publish({ id: page.id, expectedRevision: revision });
      expect(pub.revisionNumber).toBe(1);
      expect(pub.page.status).toBe("published");

      const live = await resolve("nova-store.pages.test");
      expect(live.kind).toBe("ok");
      if (live.kind !== "ok") return;
      expect(live.content.hero!.headline).toBe("Everyday quality, delivered to your door");

      content.hero!.headline = "Unpublished edit";
      const saved = await caller.landingPages.saveDraft({ id: page.id, content: L(content), expectedRevision: revision });
      expect(saved.page.hasUnpublishedChanges).toBe(true);
      const stillLive = await resolve("nova-store.pages.test");
      expect(stillLive.kind === "ok" && stillLive.content.hero!.headline).toBe("Everyday quality, delivered to your door");

      const repub = await caller.landingPages.publish({ id: page.id, expectedRevision: saved.page.draftRevision });
      expect(repub.revisionNumber).toBe(2);
      const updated = await resolve("nova-store.pages.test");
      expect(updated.kind === "ok" && updated.content.hero!.headline).toBe("Unpublished edit");

      // Republishing an unchanged draft is a no-op, not a new revision.
      const noop = await caller.landingPages.publish({ id: page.id, expectedRevision: saved.page.draftRevision });
      expect(noop.unchanged).toBe(true);
      expect(await LandingPageRevision.countDocuments({ pageId: page.id })).toBe(2);

      const audit = await AuditLog.countDocuments({ action: "landing.page_published" });
      expect(audit).toBe(2);
    });

    it("refuses to publish when required fields are empty", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Launch" });
      await caller.landingPages.setSlug({ id: page.id, slug: "incomplete" });
      // Launch's order CTA is required and defaults to action "none".
      await expect(caller.landingPages.publish({ id: page.id, expectedRevision: 1 })).rejects.toThrow(/order\.cta/);
    });

    it("rejects a stale publish", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Launch" });
      const { revision } = await publishable(caller, page.id, "stale-shop");
      await expect(caller.landingPages.publish({ id: page.id, expectedRevision: revision - 1 })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    it("unpublish and archive take the page offline; archive holds the slug", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Launch" });
      const { revision } = await publishable(caller, page.id, "held-shop");
      await caller.landingPages.publish({ id: page.id, expectedRevision: revision });

      await caller.landingPages.unpublish({ id: page.id });
      expect((await resolve("held-shop.pages.test")).kind).toBe("not_found");

      await caller.landingPages.publish({ id: page.id, expectedRevision: revision });
      expect((await resolve("held-shop.pages.test")).kind).toBe("ok");

      await caller.landingPages.archive({ id: page.id });
      expect((await resolve("held-shop.pages.test")).kind).toBe("not_found");
      const host = await LandingPageHost.findOne({ hostname: "held-shop" }).lean();
      expect(host!.status).toBe("released");

      // Another merchant cannot take a freshly released slug...
      const other = await createMerchant();
      const otherCaller = callerFor(authUserFor(other));
      const otherPage = await otherCaller.landingPages.create({ templateId: launch.id, name: "Other" });
      const check = await otherCaller.landingPages.checkSlug({ slug: "held-shop" });
      expect(check).toMatchObject({ available: false, reason: "held" });
      await expect(otherCaller.landingPages.setSlug({ id: otherPage.id, slug: "held-shop" })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      // ...but the previous owner can reclaim it for another page.
      const mine = await caller.landingPages.create({ templateId: launch.id, name: "Relaunch" });
      await caller.landingPages.setSlug({ id: mine.id, slug: "held-shop" });
      // Archived pages can no longer be edited.
      await expect(
        caller.landingPages.saveDraft({ id: page.id, content: {}, expectedRevision: revision }),
      ).rejects.toThrow(/archived/);
    });

    it("enforces unique and valid subdomains", async () => {
      const { caller, launch } = await setup();
      const a = await caller.landingPages.create({ templateId: launch.id, name: "A" });
      const b = await caller.landingPages.create({ templateId: launch.id, name: "B" });
      await caller.landingPages.setSlug({ id: a.id, slug: "My-Shop" });
      expect((await LandingPage.findById(a.id).lean())!.slug).toBe("my-shop");
      await expect(caller.landingPages.setSlug({ id: b.id, slug: "my-shop" })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(caller.landingPages.setSlug({ id: b.id, slug: "admin" })).rejects.toThrow(/reserved/);
      await expect(caller.landingPages.setSlug({ id: b.id, slug: "bad slug!" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      // Changing a page's slug releases the old one.
      await caller.landingPages.setSlug({ id: a.id, slug: "my-shop-2" });
      expect((await LandingPageHost.findOne({ hostname: "my-shop" }).lean())!.status).toBe("released");
      expect(await LandingPageHost.countDocuments({ pageId: a.id, status: "active" })).toBe(1);
    });

    it("restores a revision into the draft and duplicates pages", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Launch" });
      const { content, revision } = await publishable(caller, page.id, "restore-shop");
      await caller.landingPages.publish({ id: page.id, expectedRevision: revision });
      content.hero!.headline = "Changed";
      const saved = await caller.landingPages.saveDraft({ id: page.id, content: L(content), expectedRevision: revision });
      const restored = await caller.landingPages.restoreRevision({
        id: page.id,
        revisionNumber: 1,
        expectedRevision: saved.page.draftRevision,
      });
      const got = await caller.landingPages.get({ id: page.id });
      expect(en(got).hero!.headline).toBe(
        "Everyday quality, delivered to your door",
      );
      expect(restored.draftRevision).toBe(saved.page.draftRevision + 1);

      const copy = await caller.landingPages.duplicate({ id: page.id });
      expect(copy.status).toBe("draft");
      expect(copy.slug).toBeNull();
      expect(copy.name).toBe("Launch (copy)");
    });

    it("caps pages per merchant", async () => {
      const { caller, launch, merchant } = await setup();
      const docs = Array.from({ length: 50 }, (_, i) => ({
        merchantId: merchant._id,
        name: `p${i}`,
        templateId: new Types.ObjectId(launch.id),
        templateVersionId: new Types.ObjectId(),
        draftContent: {},
      }));
      await LandingPage.insertMany(docs);
      await expect(caller.landingPages.create({ templateId: launch.id, name: "One too many" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  describe("tenant isolation", () => {
    it("never exposes or mutates another merchant's page", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Mine" });
      const { revision } = await publishable(caller, page.id, "tenant-a");

      const intruder = callerFor(authUserFor(await createMerchant()));
      await expect(intruder.landingPages.get({ id: page.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        intruder.landingPages.saveDraft({ id: page.id, content: {}, expectedRevision: revision }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(intruder.landingPages.publish({ id: page.id, expectedRevision: revision })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(intruder.landingPages.unpublish({ id: page.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(intruder.landingPages.archive({ id: page.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(intruder.landingPages.setSlug({ id: page.id, slug: "stolen" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(intruder.landingPages.duplicate({ id: page.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await intruder.landingPages.list()).toHaveLength(0);
      await expect(intruder.landingPages.get({ id: "not-an-id" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses content that references another merchant's images", async () => {
      const { caller, launch } = await setup();
      const other = callerFor(authUserFor(await createMerchant()));
      const theirs = await other.landingPages.uploadAsset({ dataUrl: `data:image/png;base64,${PNG_1PX}` });

      const page = await caller.landingPages.create({ templateId: launch.id, name: "Mine" });
      const got = await caller.landingPages.get({ id: page.id });
      const content = en(got);
      content.hero!.image = { assetId: theirs.id, alt: "" };
      await expect(caller.landingPages.saveDraft({ id: page.id, content: L(content), expectedRevision: 1 })).rejects.toThrow(
        /images were not found/,
      );

      const mine = await caller.landingPages.uploadAsset({ dataUrl: `data:image/png;base64,${PNG_1PX}` });
      content.hero!.image = { assetId: mine.id, alt: "Product" };
      await expect(caller.landingPages.saveDraft({ id: page.id, content: L(content), expectedRevision: 1 })).resolves.toBeTruthy();
    });

    it("blocks unauthenticated and lapsed merchants from publishing", async () => {
      const { launch } = await setup();
      const anon = callerFor(null as never);
      await expect(anon.landingPages.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      const lapsed = await createMerchant({ status: "suspended" });
      const lapsedCaller = callerFor(authUserFor(lapsed));
      await expect(lapsedCaller.landingPages.create({ templateId: launch.id, name: "x" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("takes a suspended merchant's live pages offline", async () => {
      const { caller, launch, merchant } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Live" });
      const { revision } = await publishable(caller, page.id, "suspend-me");
      await caller.landingPages.publish({ id: page.id, expectedRevision: revision });
      expect((await resolve("suspend-me.pages.test")).kind).toBe("ok");
      await Merchant.updateOne({ _id: merchant._id }, { $set: { "subscription.status": "suspended" } });
      invalidateSubscriptionCache(String(merchant._id));
      expect((await resolve("suspend-me.pages.test")).kind).toBe("unavailable");
      // They can still take it down themselves.
      await expect(caller.landingPages.unpublish({ id: page.id })).resolves.toBeTruthy();
    });
  });

  describe("public host resolution", () => {
    it("resolves only well-formed hosts under the root domain", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Live" });
      const { revision } = await publishable(caller, page.id, "resolver");
      await caller.landingPages.publish({ id: page.id, expectedRevision: revision });

      const ok = await resolve("Resolver.Pages.Test:443");
      expect(ok.kind).toBe("ok");
      if (ok.kind === "ok") {
        expect(ok.slug).toBe("resolver");
        expect(ok).not.toHaveProperty("page");
        expect(ok.seo.title).toBe("Everyday quality, delivered to your door");
        expect(ok).not.toHaveProperty("merchantId");
        expect(JSON.stringify(ok)).not.toContain(String((await LandingPage.findById(page.id).lean())!.merchantId));
      }

      for (const host of [
        "unknown.pages.test",
        "pages.test",
        "a.resolver.pages.test",
        "resolver.pages.test.evil.example",
        "resolver.other.test",
        "[::1]",
        "",
        "resolver.pages.test/../../",
        "admin.pages.test",
      ]) {
        expect((await resolve(host)).kind, host).toBe("not_found");
      }
      expect((await resolveLandingPageByHost("resolver.pages.test", { rootDomain: null })).kind).toBe("not_found");
    });

    it("never serves a draft-only page", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Draft" });
      await caller.landingPages.setSlug({ id: page.id, slug: "draft-only" });
      expect((await resolve("draft-only.pages.test")).kind).toBe("not_found");
    });

    it("keeps serving the pinned template version after the template changes", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Pinned" });
      const { revision } = await publishable(caller, page.id, "pinned");
      await caller.landingPages.publish({ id: page.id, expectedRevision: revision });
      const before = await resolve("pinned.pages.test");

      const tpl = await LandingPageTemplate.findOne({ key: "launch" }).lean();
      await LandingPageTemplateVersion.collection.updateOne({ _id: tpl!.currentVersionId! }, { $set: { specHash: "stale" } });
      await ensureSystemTemplates();
      const after = await resolve("pinned.pages.test");
      expect(after.kind === "ok" && after.templateVersion.version).toBe(1);
      expect(before.kind === "ok" && before.templateVersion.version).toBe(after.kind === "ok" && after.templateVersion.version);

      const got = await caller.landingPages.get({ id: page.id });
      expect(got.template.upgradeAvailable).toBe(true);
      const up = await caller.landingPages.upgradeTemplate({ id: page.id, expectedRevision: got.page.draftRevision });
      expect(up.upgraded).toBe(true);
      // Upgrading changes the draft only; live stays on v1 until republished.
      const stillV1 = await resolve("pinned.pages.test");
      expect(stillV1.kind === "ok" && stillV1.templateVersion.version).toBe(1);
    });
  });

  describe("immutability", () => {
    it("refuses updates to published revisions and template versions", async () => {
      const { caller, launch } = await setup();
      const page = await caller.landingPages.create({ templateId: launch.id, name: "Immutable" });
      const { revision } = await publishable(caller, page.id, "immutable");
      await caller.landingPages.publish({ id: page.id, expectedRevision: revision });
      const rev = await LandingPageRevision.findOne({ pageId: page.id });
      await expect(LandingPageRevision.updateOne({ _id: rev!._id }, { $set: { content: {} } })).rejects.toThrow(/immutable/);
      rev!.set("content", { hacked: true });
      await expect(rev!.save()).rejects.toThrow(/immutable/);

      const version = await LandingPageTemplateVersion.findOne({ status: "published" });
      await expect(
        LandingPageTemplateVersion.updateOne({ _id: version!._id }, { $set: { spec: {} } }),
      ).rejects.toThrow(/immutable/);
      version!.set("notes", "edited");
      await expect(version!.save()).rejects.toThrow(/immutable/);
    });
  });

  describe("assets", () => {
    it("sniffs content and rejects non-raster uploads", async () => {
      const { caller } = await setup();
      const up = await caller.landingPages.uploadAsset({ dataUrl: `data:image/png;base64,${PNG_1PX}` });
      expect(up.mime).toBe("image/png");
      expect(up.url).toMatch(new RegExp(`/api/landing-assets/${up.id}$`));
      const again = await caller.landingPages.uploadAsset({ dataUrl: `data:image/png;base64,${PNG_1PX}` });
      expect(again).toMatchObject({ id: up.id, deduplicated: true });

      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");
      await expect(caller.landingPages.uploadAsset({ dataUrl: `data:image/svg+xml;base64,${svg}` })).rejects.toThrow(
        /Only PNG/,
      );
      const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
      await expect(caller.landingPages.uploadAsset({ dataUrl: `data:image/png;base64,${html}` })).rejects.toThrow(
        /not a supported image/,
      );
      expect(sniffImageMime(Buffer.from("GIF89a......"))).toBe("image/gif");
      expect(await LandingAsset.countDocuments()).toBe(1);
    });
  });

  describe("admin template management", () => {
    async function admin() {
      const m = await createMerchant({ role: "admin" });
      await Merchant.updateOne({ _id: m._id }, { $set: { adminScopes: ["super_admin"] } });
      invalidateAdminProfile(String(m._id));
      return callerFor(authUserFor(m));
    }

    it("is super_admin only", async () => {
      await ensureSystemTemplates();
      const merchant = callerFor(authUserFor(await createMerchant()));
      await expect(merchant.adminLandingTemplates.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
      const support = await createMerchant({ role: "admin" });
      await Merchant.updateOne({ _id: support._id }, { $set: { adminScopes: ["support_admin"] } });
      invalidateAdminProfile(String(support._id));
      await expect(callerFor(authUserFor(support)).adminLandingTemplates.list()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("drafts, publishes and freezes custom template versions", async () => {
      await ensureSystemTemplates();
      const a = await admin();
      const list = await a.adminLandingTemplates.list();
      const launch = list.find((t) => t.key === "launch")!;

      // System templates are read-only.
      await expect(a.adminLandingTemplates.createDraft({ id: launch.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

      const dup = await a.adminLandingTemplates.duplicate({ id: launch.id, key: "launch-custom", name: "Launch (custom)" });
      const detail = await a.adminLandingTemplates.get({ id: dup.id });
      expect(detail.template.status).toBe("draft");
      const draft = detail.versions[0]!;
      expect(draft.status).toBe("draft");

      // Not offered to merchants until published + active.
      const merchant = callerFor(authUserFor(await createMerchant()));
      expect((await merchant.landingPages.templates()).some((t) => t.key === "launch-custom")).toBe(false);

      const spec = structuredClone(draft.spec) as { sections: Array<{ id: string; fields?: Record<string, unknown> }> };
      spec.sections.find((s) => s.id === "hero")!.fields = {
        ...spec.sections.find((s) => s.id === "hero")!.fields,
        headline: { default: "Custom headline" },
      };
      await a.adminLandingTemplates.saveDraft({ id: dup.id, versionId: draft.id, spec });

      const bad = structuredClone(spec) as { sections: Array<Record<string, unknown>> };
      bad.sections.push({ id: "x", type: "iframe", typeVersion: 1 });
      await expect(a.adminLandingTemplates.saveDraft({ id: dup.id, versionId: draft.id, spec: bad })).rejects.toThrow(
        /Unknown section type/,
      );

      const pub = await a.adminLandingTemplates.publishDraft({ id: dup.id, versionId: draft.id });
      expect(pub.version).toBe(1);
      const offered = (await merchant.landingPages.templates()).find((t) => t.key === "launch-custom");
      expect(offered).toBeTruthy();

      // A merchant page pinned to v1.
      const mPage = await merchant.landingPages.create({ templateId: dup.id, name: "On custom" });

      // The published version can no longer be saved.
      await expect(a.adminLandingTemplates.saveDraft({ id: dup.id, versionId: draft.id, spec })).rejects.toMatchObject({
        code: "CONFLICT",
      });

      // Editing means a new draft → v2; the merchant page stays on v1.
      const v2 = await a.adminLandingTemplates.createDraft({ id: dup.id });
      expect(v2.version).toBe(2);
      await a.adminLandingTemplates.publishDraft({ id: dup.id, versionId: v2.draftVersionId });
      const pageRow = await LandingPage.findById(mPage.id).lean();
      const v1 = await LandingPageTemplateVersion.findOne({ templateId: dup.id, version: 1 }).lean();
      expect(String(pageRow!.templateVersionId)).toBe(String(v1!._id));

      // Disabled templates vanish from the picker but pages keep working.
      await a.adminLandingTemplates.setStatus({ id: dup.id, status: "disabled" });
      expect((await merchant.landingPages.templates()).some((t) => t.key === "launch-custom")).toBe(false);
      await expect(merchant.landingPages.get({ id: mPage.id })).resolves.toBeTruthy();
      await expect(merchant.landingPages.create({ templateId: dup.id, name: "x" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      expect(await AuditLog.countDocuments({ action: "landing.template_version_published" })).toBe(2);
    });

    it("creates a blank custom template and refuses duplicate keys", async () => {
      await ensureSystemTemplates();
      const a = await admin();
      const created = await a.adminLandingTemplates.create({ key: "blank-one", name: "Blank" });
      expect(created.draftVersionId).toBeTruthy();
      await expect(a.adminLandingTemplates.create({ key: "blank-one", name: "Again" })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(a.adminLandingTemplates.setStatus({ id: created.id, status: "active" })).rejects.toThrow(
        /Publish a version/,
      );
      const sections = await a.adminLandingTemplates.sectionTypes();
      expect(sections.some((s) => s.type === "hero")).toBe(true);
    });
  });
});
