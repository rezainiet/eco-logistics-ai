import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { type CatalogProduct, MAX_LINE_QUANTITY, MAX_PAGE_PRODUCTS, type PageProductRef } from "@ecom/landing";
import { LandingPage, Product, availableStock, stockStatusOf } from "@ecom/db";
import { writeAudit } from "../audit.js";
import { productView } from "../commerce/products.js";
import { type Actor, getOwnedPage, pageSummary } from "./pages.js";

/**
 * Products linked to a landing page.
 *
 * The page stores references (`draftProducts`, snapshotted into each
 * published revision) and display-only overrides — never a copy of the
 * product. Everything a customer pays for (name, price, currency, stock,
 * whether it can be bought at all) is read from the live Product, scoped to
 * the page's merchant, every time.
 */

type StoredRef = { productId: Types.ObjectId | string; ctaText?: string | null; badge?: string | null; featured?: boolean | null };

/** Plain one-line text: no control characters, collapsed whitespace. */
function plain(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || undefined;
}

export function refsOf(stored: ReadonlyArray<StoredRef> | null | undefined): PageProductRef[] {
  return (stored ?? []).map((r) => ({
    productId: String(r.productId),
    ctaText: r.ctaText ?? null,
    badge: r.badge ?? null,
    featured: r.featured === true,
  }));
}

/**
 * Live catalog for a page, in the page's order (featured first). Draft and archived
 * products (and products of any other merchant) are left out; inactive or
 * out-of-stock products are shown as unavailable.
 */
export async function catalogFor(merchantId: Types.ObjectId | string, refs: ReadonlyArray<StoredRef>): Promise<CatalogProduct[]> {
  if (!refs.length) return [];
  const ids = refs.map((r) => String(r.productId)).filter((id) => Types.ObjectId.isValid(id));
  const docs = await Product.find({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    merchantId: new Types.ObjectId(String(merchantId)),
    status: { $in: ["active", "inactive"] },
  }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const out: CatalogProduct[] = [];
  for (const ref of refs) {
    const p = byId.get(String(ref.productId));
    if (!p) continue;
    const stock = stockStatusOf(p);
    const available = p.status === "active" && stock !== "out_of_stock";
    out.push({
      id: String(p._id),
      name: p.name,
      description: p.description ?? "",
      imageAssetId: p.imageAssetId ? String(p.imageAssetId) : null,
      price: p.price,
      compareAtPrice: p.compareAtPrice ?? null,
      currency: p.currency ?? "BDT",
      available,
      stockStatus: available ? stock : "out_of_stock",
      maxQuantity: available ? Math.min(MAX_LINE_QUANTITY, availableStock(p.inventory)) : 0,
      badge: ref.badge ?? null,
      ctaText: ref.ctaText ?? null,
      featured: ref.featured === true,
    });
  }
  // Featured products first; otherwise the merchant's order.
  return [...out.filter((p) => p.featured), ...out.filter((p) => !p.featured)];
}

/** Editor view: the draft selection with each product's dashboard data, plus the preview catalog. */
export async function getPageProducts(merchantId: Types.ObjectId, pageId: string) {
  const page = await getOwnedPage(merchantId, pageId);
  const refs = refsOf(page.draftProducts as StoredRef[] | undefined);
  const docs = refs.length
    ? await Product.find({ _id: { $in: refs.map((r) => new Types.ObjectId(r.productId)) }, merchantId }).lean()
    : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return {
    draftRevision: page.draftRevision,
    items: refs.map((r) => {
      const doc = byId.get(r.productId);
      return { ...r, product: doc && doc.status !== "archived" ? productView(doc) : null };
    }),
    catalog: await catalogFor(merchantId, refs),
  };
}

/**
 * Replace the page's product selection. Every product must belong to the
 * merchant and not be archived; overrides are plain text. Bumps the draft
 * revision (compare-and-set), so the page shows unpublished changes until
 * it is published again.
 */
export async function setPageProducts(
  actor: Actor,
  input: { pageId: string; expectedRevision: number; products: ReadonlyArray<PageProductRef> },
) {
  const page = await getOwnedPage(actor.merchantId, input.pageId);
  if (page.status === "archived") throw new TRPCError({ code: "BAD_REQUEST", message: "This page is archived" });
  if (input.products.length > MAX_PAGE_PRODUCTS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `A page can show up to ${MAX_PAGE_PRODUCTS} products.` });
  }
  const seen = new Set<string>();
  const refs = input.products.map((r) => {
    if (!/^[a-f0-9]{24}$/.test(r.productId) || seen.has(r.productId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid product selection." });
    }
    seen.add(r.productId);
    const ctaText = plain(r.ctaText, 40);
    const badge = plain(r.badge, 24);
    return {
      productId: new Types.ObjectId(r.productId),
      ...(ctaText ? { ctaText } : {}),
      ...(badge ? { badge } : {}),
      ...(r.featured ? { featured: true } : {}),
    };
  });
  if (refs.length) {
    const owned = await Product.countDocuments({
      _id: { $in: refs.map((r) => r.productId) },
      merchantId: actor.merchantId,
      status: { $ne: "archived" },
    });
    // A foreign or archived id is indistinguishable from a missing one.
    if (owned !== refs.length) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
  }
  const updated = await LandingPage.findOneAndUpdate(
    { _id: page._id, merchantId: actor.merchantId, draftRevision: input.expectedRevision, status: { $ne: "archived" } },
    { $set: { draftProducts: refs, draftUpdatedAt: new Date(), draftUpdatedBy: actor.actorId }, $inc: { draftRevision: 1 } },
    { new: true },
  ).lean();
  if (!updated) {
    throw new TRPCError({ code: "CONFLICT", message: "This page was changed elsewhere. Reload to see the latest version." });
  }
  await writeAudit({
    merchantId: actor.merchantId,
    actorId: actor.actorId,
    actorEmail: actor.email,
    actorType: "merchant",
    action: "landing.products_updated",
    subjectType: "landing_page",
    subjectId: page._id,
    meta: { productIds: refs.map((r) => String(r.productId)) },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
  return { page: pageSummary(updated), ...(await getPageProducts(actor.merchantId, input.pageId)) };
}

/** Refs still publishable (owned, not archived) — what a new revision snapshots. */
export async function publishableRefs(merchantId: Types.ObjectId, stored: ReadonlyArray<StoredRef> | null | undefined) {
  const refs = stored ?? [];
  if (!refs.length) return [];
  const live = await Product.find({ _id: { $in: refs.map((r) => r.productId) }, merchantId, status: { $ne: "archived" } })
    .select("_id")
    .lean();
  const ok = new Set(live.map((d) => String(d._id)));
  return refs
    .filter((r) => ok.has(String(r.productId)))
    .map((r) => ({
      productId: new Types.ObjectId(String(r.productId)),
      ...(r.ctaText ? { ctaText: r.ctaText } : {}),
      ...(r.badge ? { badge: r.badge } : {}),
      ...(r.featured ? { featured: true } : {}),
    }));
}
