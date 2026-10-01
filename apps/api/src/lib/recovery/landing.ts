import { Types } from "mongoose";
import { MAX_CART_LINES, MAX_LINE_QUANTITY, normalizeBdMobile } from "@ecom/landing";
import { Merchant, Product, RecoveryTask, TrackingEvent, availableStock, hasVariants } from "@ecom/db";
import { resolvePublishedForOrder } from "../landing/resolve.js";
import { getPlan } from "../plans.js";
import { writeAudit } from "../audit.js";
import { recordServerTrackingEvents, type ServerTrackingEvent } from "../../server/tracking/collector.js";
import { hashRecoveryToken, isWellFormedRecoveryToken } from "./token.js";

/**
 * Cart recovery for ConfirmX-hosted landing pages — the only storefront
 * whose cart ConfirmX owns, so the only one a recovery link can restore.
 *
 *   capture  : the page reports cart activity; it is stored as ordinary
 *              tracking events (same TrackingEvent/TrackingSession rows,
 *              same abandoned-cart rule as the storefront SDK).
 *   restore  : a recovery link token → that page's saved cart (ids and
 *              quantities only; the page re-checks live stock and price).
 *   convert  : an order placed with the token links back to its task.
 *
 * Every lookup starts from the page the request's hostname resolves to, so
 * a token or session can never reach another merchant's data.
 */

const ID_RE = /^[a-f0-9]{24}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,190}\.[a-z]{2,24}$/i;

export const LANDING_ACTIVITY_TYPES = ["add_to_cart", "remove_from_cart", "checkout_start", "identify", "checkout_submit"] as const;
export type LandingActivityType = (typeof LANDING_ACTIVITY_TYPES)[number];

export interface CartLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

/** A cart line as stored on the event: server names and prices, never the browser's. */
export interface SnapshotLine {
  productId: string;
  variantId?: string;
  quantity: number;
  name: string;
  price: number;
}

export interface LandingContext {
  pageId: string;
  host: string;
  locale: string;
}

export interface LandingActivityInput {
  host: string;
  locale: string | null;
  sessionId: string;
  type: string;
  clientEventId: string;
  cart: unknown;
  /** The line this event is about (add/remove). */
  item?: unknown;
  phone?: unknown;
  email?: unknown;
}

export type LandingActivityResult =
  | { ok: true; recorded: boolean }
  | { ok: false; code: "invalid_request" | "page_unavailable" };

/** Lines from untrusted input: well-formed, de-duplicated, capped. */
function parseLines(raw: unknown): CartLineInput[] {
  if (!Array.isArray(raw)) return [];
  const out: CartLineInput[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, MAX_CART_LINES)) {
    const productId = (r as { productId?: unknown })?.productId;
    const variantId = (r as { variantId?: unknown })?.variantId;
    const quantity = (r as { quantity?: unknown })?.quantity;
    if (typeof productId !== "string" || !ID_RE.test(productId)) continue;
    if (variantId != null && (typeof variantId !== "string" || !ID_RE.test(variantId))) continue;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) continue;
    const k = variantId ? `${productId}:${variantId}` : productId;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ productId, ...(variantId ? { variantId } : {}), quantity });
  }
  return out;
}

/**
 * Resolve lines against the page's linked products of THIS merchant. Lines
 * for products not on the page, of another merchant or no longer existing
 * are dropped. `requireAvailable` additionally drops what can't be bought now.
 */
async function snapshotLines(
  merchantId: Types.ObjectId,
  pageRefs: Set<string>,
  lines: CartLineInput[],
  opts: { requireAvailable?: boolean } = {},
): Promise<{ lines: SnapshotLine[]; currency: string }> {
  const onPage = lines.filter((l) => pageRefs.has(l.productId));
  if (onPage.length === 0) return { lines: [], currency: "BDT" };
  const products = await Product.find({
    _id: { $in: [...new Set(onPage.map((l) => l.productId))].map((id) => new Types.ObjectId(id)) },
    merchantId,
  })
    .select("name price currency status inventory variants")
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const out: SnapshotLine[] = [];
  for (const l of onPage) {
    const p = byId.get(l.productId);
    if (!p) continue;
    if (opts.requireAvailable && p.status !== "active") continue;
    if (hasVariants(p)) {
      const v = l.variantId ? p.variants!.find((x) => String(x._id) === l.variantId) : undefined;
      if (!v) continue;
      if (opts.requireAvailable && (v.status !== "active" || availableStock(v.inventory) <= 0)) continue;
      out.push({ productId: l.productId, variantId: l.variantId!, quantity: l.quantity, name: `${p.name} (${v.optionValues.join(" / ")})`, price: v.price ?? p.price });
    } else {
      if (l.variantId) continue;
      if (opts.requireAvailable && availableStock(p.inventory) <= 0) continue;
      out.push({ productId: l.productId, quantity: l.quantity, name: p.name, price: p.price });
    }
  }
  return { lines: out, currency: products[0]?.currency ?? "BDT" };
}

/** Plans that include behavior analytics / cart recovery collect landing cart activity. */
async function collectsLandingActivity(merchantId: Types.ObjectId): Promise<boolean> {
  const m = await Merchant.findById(merchantId).select("subscription.tier").lean();
  return !!getPlan(m?.subscription?.tier ?? "starter").features.behaviorAnalytics;
}

/**
 * Record one cart event from a published landing page. The page and the
 * merchant come from the hostname; product names/prices from the database.
 * Merchants whose plan has no cart recovery are acknowledged but not stored.
 */
export async function recordLandingActivity(
  input: LandingActivityInput,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<LandingActivityResult> {
  if (!(LANDING_ACTIVITY_TYPES as readonly string[]).includes(input.type)) return { ok: false, code: "invalid_request" };
  if (typeof input.sessionId !== "string" || !CLIENT_ID_RE.test(input.sessionId)) return { ok: false, code: "invalid_request" };
  if (typeof input.clientEventId !== "string" || !CLIENT_ID_RE.test(input.clientEventId)) return { ok: false, code: "invalid_request" };

  const page = await resolvePublishedForOrder(input.host, input.locale);
  if (!page) return { ok: false, code: "page_unavailable" };
  const merchantId = new Types.ObjectId(page.merchantId);
  if (!(await collectsLandingActivity(merchantId))) return { ok: true, recorded: false };

  const refs = new Set(page.refs.map((r) => r.productId));
  const { lines: cart } = await snapshotLines(merchantId, refs, parseLines(input.cart));
  const [item] = (await snapshotLines(merchantId, refs, parseLines(input.item ? [input.item] : []))).lines;

  const phone = normalizeBdMobile(input.phone) ?? undefined;
  const emailRaw = typeof input.email === "string" ? input.email.trim().toLowerCase().slice(0, 200) : "";
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : undefined;
  if (input.type === "identify" && !phone && !email) return { ok: false, code: "invalid_request" };
  if ((input.type === "add_to_cart" || input.type === "remove_from_cart") && !item) return { ok: true, recorded: false };

  const landing: LandingContext = { pageId: page.pageId, host: input.host.toLowerCase(), locale: page.locale };
  const event: ServerTrackingEvent = {
    sessionId: input.sessionId,
    type: input.type as LandingActivityType,
    clientEventId: input.clientEventId,
    occurredAt: new Date(),
    url: `https://${landing.host}/`,
    path: "/",
    properties: {
      source: "landing_page",
      landing,
      cart,
      ...(item ? { productId: item.productId, ...(item.variantId ? { variantId: item.variantId } : {}), quantity: item.quantity, name: item.name, price: item.price } : {}),
    },
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
  };
  const outcome = await recordServerTrackingEvents(merchantId, [event], meta);
  return { ok: true, recorded: outcome.inserted.size > 0 };
}

/** The latest landing cart a session saved (null for storefront-SDK sessions). */
export async function landingCartSnapshot(
  merchantId: Types.ObjectId,
  sessionId: string,
): Promise<{ landing: LandingContext; lines: SnapshotLine[] } | null> {
  const ev = await TrackingEvent.findOne({ merchantId, sessionId, "properties.source": "landing_page" })
    .sort({ occurredAt: -1, receivedAt: -1 })
    .select("properties")
    .lean();
  const props = ev?.properties as { landing?: Partial<LandingContext>; cart?: unknown } | undefined;
  const landing = props?.landing;
  if (!landing || typeof landing.pageId !== "string" || !ID_RE.test(landing.pageId) || typeof landing.host !== "string") return null;
  const lines: SnapshotLine[] = [];
  for (const l of Array.isArray(props!.cart) ? props!.cart : []) {
    const x = l as Partial<SnapshotLine>;
    if (typeof x.productId !== "string" || typeof x.quantity !== "number") continue;
    lines.push({
      productId: x.productId,
      ...(typeof x.variantId === "string" ? { variantId: x.variantId } : {}),
      quantity: x.quantity,
      name: typeof x.name === "string" ? x.name : "",
      price: typeof x.price === "number" ? x.price : 0,
    });
  }
  return { landing: { pageId: landing.pageId, host: landing.host, locale: typeof landing.locale === "string" ? landing.locale : "" }, lines };
}

/** Live, buyable lines of a saved cart on its page (what the email lists). */
export async function availableRecoveryLines(
  merchantId: Types.ObjectId,
  page: { refs: Array<{ productId: string }> },
  lines: SnapshotLine[],
): Promise<{ lines: SnapshotLine[]; currency: string }> {
  return snapshotLines(merchantId, new Set(page.refs.map((r) => r.productId)), lines, { requireAvailable: true });
}

const LIVE_STATUSES = ["pending", "contacted"] as const;

/** The task a token names, on the page the request came from — or why not. */
async function taskForToken(host: string, locale: string | null, token: unknown, now: Date) {
  if (!isWellFormedRecoveryToken(token)) return { error: "invalid" as const };
  const page = await resolvePublishedForOrder(host, locale);
  if (!page) return { error: "page_unavailable" as const };
  const merchantId = new Types.ObjectId(page.merchantId);
  const task = await RecoveryTask.findOne({ merchantId, "emailRecovery.tokenHash": hashRecoveryToken(token) })
    .select("_id merchantId sessionId status expiresAt landingPageId")
    .lean();
  // Another merchant's token, another page's token and an unknown token look the same.
  if (!task || String(task.landingPageId) !== page.pageId) return { error: "invalid" as const };
  if (!(LIVE_STATUSES as readonly string[]).includes(task.status) || !task.expiresAt || task.expiresAt <= now) {
    return { error: "expired" as const };
  }
  return { page, merchantId, task };
}

export type RestoreResult =
  | { ok: true; lines: Array<{ productId: string; variantId?: string; quantity: number }> }
  | { ok: false; code: "invalid" | "expired" | "page_unavailable" };

/**
 * Open a recovery link: return the saved cart (ids + quantities — no
 * personal data) and count the click. Never creates or changes an order;
 * the page re-checks every line against live stock and price, and the
 * normal checkout decides everything else.
 */
export async function restoreRecoveryCart(args: { host: string; locale: string | null; token: unknown; now?: Date }): Promise<RestoreResult> {
  const now = args.now ?? new Date();
  const found = await taskForToken(args.host, args.locale, args.token, now);
  if ("error" in found) return { ok: false, code: found.error! };
  const snap = await landingCartSnapshot(found.merchantId, found.task.sessionId);
  const refs = new Set(found.page.refs.map((r) => r.productId));
  const lines = (snap?.lines ?? [])
    .filter((l) => refs.has(l.productId))
    .map((l) => ({ productId: l.productId, ...(l.variantId ? { variantId: l.variantId } : {}), quantity: l.quantity }));
  await RecoveryTask.updateOne(
    { _id: found.task._id, merchantId: found.merchantId },
    { $inc: { "emailRecovery.clicks": 1 }, $min: { "emailRecovery.clickedAt": now } },
  );
  return { ok: true, lines };
}

/** Checkout submitted from a recovery link (counted even if the order is then refused). */
export async function markRecoveryCheckoutStarted(args: { host: string; locale: string | null; token: unknown; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  const found = await taskForToken(args.host, args.locale, args.token, now);
  if ("error" in found) return false;
  await RecoveryTask.updateOne(
    { _id: found.task._id, merchantId: found.merchantId },
    { $min: { "emailRecovery.checkoutStartedAt": now } },
  );
  return true;
}

/**
 * Link an order placed from a recovery link to its task (pending/contacted
 * → recovered). Conditional, so a token converts once; a second order with
 * the same link is a normal order and is not attributed again.
 */
export async function linkRecoveredOrder(args: {
  host: string;
  locale: string | null;
  token: unknown;
  orderId: Types.ObjectId;
  merchantId: Types.ObjectId;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  const found = await taskForToken(args.host, args.locale, args.token, now);
  if ("error" in found || String(found.merchantId) !== String(args.merchantId)) return false;
  const updated = await RecoveryTask.findOneAndUpdate(
    { _id: found.task._id, merchantId: found.merchantId, status: { $in: [...LIVE_STATUSES] } },
    {
      $set: { status: "recovered", recoveredOrderId: args.orderId, recoveredAt: now },
      $min: { "emailRecovery.checkoutStartedAt": now },
    },
    { new: true },
  ).lean();
  if (!updated) return false;
  void writeAudit({
    merchantId: found.merchantId,
    actorId: found.merchantId,
    actorType: "system",
    action: "recovery.converted",
    subjectType: "order",
    subjectId: args.orderId,
    meta: { kind: "cart_recovery_converted", taskId: String(updated._id), channel: "email" },
  });
  return true;
}
