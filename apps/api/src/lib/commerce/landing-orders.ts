import mongoose, { Types } from "mongoose";
import { MAX_CART_LINES, MAX_LINE_QUANTITY, normalizeBdMobile } from "@ecom/landing";
import { Order, Product, availableStock } from "@ecom/db";
import { writeAudit } from "../audit.js";
import { InventoryError, reserveOrderStock } from "../inventory.js";
import { afterOrderCreated, fraudDocFromRisk, generateOrderNumber, loadMerchantScoring, scoreOrderForCreate } from "../order-create.js";
import { getPlan } from "../plans.js";
import { reserveQuota } from "../usage.js";
import { hashAddress } from "../../server/risk.js";
import { resolvePublishedForOrder } from "../landing/resolve.js";

/**
 * Order placement from a published landing page (cash on delivery).
 *
 * The browser sends only: which page (its hostname), product ids +
 * quantities, the customer's details, the chosen delivery zone and an
 * idempotency key. Everything else is decided here, from the database:
 *
 *   1. the product exists                    6. the price is the product's current price
 *   2. it belongs to the page's merchant     7. all lines share one currency
 *   3. it is active                          8. the page belongs to that same merchant
 *   4. it is available (in stock)            9. the page is published (and the merchant online)
 *   5. the quantity is available            10. the product is linked on the published page
 *
 * The merchant comes from the page, never from the request. Stock is
 * reserved in the same transaction that inserts the order, with a guarded
 * atomic update per product — two customers can never both buy the last
 * unit. A repeated submission (double click, retry) with the same key
 * returns the first order instead of creating another.
 */

export interface PlaceOrderInput {
  host: string;
  locale: string | null;
  idempotencyKey: string;
  items: Array<{ productId: string; quantity: number; unitPrice?: number }>;
  customer: { name: string; phone: string; address: string; district: string; email?: string | null; notes?: string | null };
  deliveryOptionId?: string | null;
}

export interface PlaceOrderMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export type PlaceOrderError =
  | { code: "invalid_request" }
  | { code: "page_unavailable" }
  | { code: "invalid_customer"; fields: string[] }
  | { code: "invalid_delivery" }
  | { code: "not_on_page"; productIds: string[] }
  | { code: "unavailable"; productIds: string[] }
  | { code: "insufficient_stock"; productId: string; available: number }
  | { code: "price_changed"; prices: Array<{ productId: string; price: number }> }
  | { code: "mixed_currency" }
  | { code: "rate_limited" }
  | { code: "not_accepting_orders" };

export interface PlacedOrder {
  orderId: string;
  orderNumber: string;
  duplicate: boolean;
  currency: string;
  subtotal: number;
  deliveryCharge: number;
  total: number;
  items: Array<{ productId: string; name: string; quantity: number; price: number }>;
}

export type PlaceOrderResult = ({ ok: true } & PlacedOrder) | ({ ok: false } & PlaceOrderError);

const fail = (e: PlaceOrderError): PlaceOrderResult => ({ ok: false, ...e });

/** One line of plain text: control characters removed, whitespace collapsed. */
function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Multi-line plain text (address, notes). */
function cleanBlock(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,190}\.[a-z]{2,24}$/i;

export function validateCustomer(c: PlaceOrderInput["customer"]) {
  const fields: string[] = [];
  const name = clean(c?.name, 80);
  const phone = normalizeBdMobile(c?.phone);
  const address = cleanBlock(c?.address, 300);
  const district = clean(c?.district, 60);
  const emailRaw = clean(c?.email, 200).toLowerCase();
  const notes = cleanBlock(c?.notes, 500);
  if (name.length < 2) fields.push("name");
  if (!phone) fields.push("phone");
  if (address.length < 5) fields.push("address");
  if (district.length < 2) fields.push("district");
  if (emailRaw && !EMAIL_RE.test(emailRaw)) fields.push("email");
  return { fields, customer: { name, phone: phone ?? "", address, district }, email: emailRaw || null, notes: notes || null };
}

/** Durable, per-merchant limit on how fast one phone number can order (no Redis needed). */
const PHONE_WINDOW_MS = 10 * 60 * 1000;
const PHONE_MAX_ORDERS = 5;

type Outcome = { kind: "created"; order: any } | { kind: "duplicate"; order: any } | { kind: "quota" };

function placedFrom(order: any, duplicate: boolean): PlacedOrder {
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    duplicate,
    currency: order.order?.currency ?? "BDT",
    subtotal: order.order?.subtotal ?? order.order?.total ?? 0,
    deliveryCharge: order.order?.deliveryCharge ?? 0,
    total: order.order?.total ?? 0,
    items: (order.items ?? []).map((i: any) => ({
      productId: i.productId ? String(i.productId) : "",
      name: i.name,
      quantity: i.quantity,
      price: i.price,
    })),
  };
}

export async function placeLandingOrder(input: PlaceOrderInput, meta: PlaceOrderMeta = {}): Promise<PlaceOrderResult> {
  // ---- Shape ---------------------------------------------------------------
  const key = typeof input?.idempotencyKey === "string" ? input.idempotencyKey : "";
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) return fail({ code: "invalid_request" });
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_CART_LINES) return fail({ code: "invalid_request" });
  const qty = new Map<string, number>();
  const clientPrice = new Map<string, number>();
  for (const line of input.items) {
    const id = typeof line?.productId === "string" ? line.productId : "";
    const q = line?.quantity;
    if (!/^[a-f0-9]{24}$/.test(id) || !Number.isInteger(q) || q < 1 || q > MAX_LINE_QUANTITY) return fail({ code: "invalid_request" });
    qty.set(id, (qty.get(id) ?? 0) + q);
    if ((qty.get(id) ?? 0) > MAX_LINE_QUANTITY) return fail({ code: "invalid_request" });
    if (typeof line.unitPrice === "number" && Number.isFinite(line.unitPrice)) clientPrice.set(id, line.unitPrice);
  }

  // ---- (8, 9) The page: published, merchant online; merchant comes from it --
  const page = await resolvePublishedForOrder(input.host, input.locale ?? null);
  if (!page) return fail({ code: "page_unavailable" });
  const merchantId = new Types.ObjectId(page.merchantId);
  const pageId = new Types.ObjectId(page.pageId);

  // Idempotent replay: same key → same order, before any other check (the
  // first attempt may have taken the last unit).
  const clientRequestId = `lp_${key}`;
  const existing = await Order.findOne({ merchantId, "source.clientRequestId": clientRequestId }).lean();
  if (existing) return { ok: true, ...placedFrom(existing, true) };

  const { fields, customer, email, notes } = validateCustomer(input.customer);
  if (fields.length) return fail({ code: "invalid_customer", fields });

  // ---- (10) Every product must be linked on the PUBLISHED page -------------
  const onPage = new Set(page.refs.map((r) => r.productId));
  const notOnPage = [...qty.keys()].filter((id) => !onPage.has(id));
  if (notOnPage.length) return fail({ code: "not_on_page", productIds: notOnPage });

  // ---- (1–4, 6, 7) Live products of THIS merchant ---------------------------
  const products = await Product.find({ _id: { $in: [...qty.keys()].map((id) => new Types.ObjectId(id)) }, merchantId }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const unavailable = [...qty.keys()].filter((id) => {
    const p = byId.get(id);
    return !p || p.status !== "active" || availableStock(p.inventory) <= 0;
  });
  if (unavailable.length) return fail({ code: "unavailable", productIds: unavailable });
  const currencies = new Set(products.map((p) => p.currency ?? "BDT"));
  if (currencies.size !== 1) return fail({ code: "mixed_currency" });
  const changed = [...clientPrice].filter(([id, price]) => byId.get(id)!.price !== price);
  if (changed.length) {
    return fail({ code: "price_changed", prices: [...qty.keys()].map((id) => ({ productId: id, price: byId.get(id)!.price })) });
  }
  // (5) Early, friendly stock check — the reservation below is the real guard.
  for (const [id, q] of qty) {
    const available = availableStock(byId.get(id)!.inventory);
    if (q > available) return fail({ code: "insufficient_stock", productId: id, available });
  }

  // ---- Delivery charge from the published page's own zones ------------------
  let deliveryCharge = 0;
  let deliveryLabel: string | null = null;
  if (page.delivery.length) {
    const zone = page.delivery.find((d) => d.id === input.deliveryOptionId);
    if (!zone) return fail({ code: "invalid_delivery" });
    deliveryCharge = zone.charge;
    deliveryLabel = zone.label;
  }

  // ---- Abuse limit: orders per phone per merchant ---------------------------
  const recent = await Order.countDocuments({
    merchantId,
    "customer.phone": customer.phone,
    "source.channel": "landing_page",
    createdAt: { $gte: new Date(Date.now() - PHONE_WINDOW_MS) },
  });
  if (recent >= PHONE_MAX_ORDERS) return fail({ code: "rate_limited" });

  // ---- Price snapshot + totals (server values only) --------------------------
  const currency = [...currencies][0]!;
  const items = [...qty].map(([id, quantity]) => {
    const p = byId.get(id)!;
    return {
      name: p.name,
      ...(p.sku ? { sku: p.sku } : {}),
      quantity,
      price: p.price,
      productId: p._id,
      ...(p.imageAssetId ? { imageAssetId: p.imageAssetId } : {}),
    };
  });
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const subtotal = round2(items.reduce((s, i) => s + i.price * i.quantity, 0));
  const total = round2(subtotal + deliveryCharge);

  const scoring = await loadMerchantScoring(merchantId);
  const plan = getPlan(scoring.tier);
  const addressHash = hashAddress(customer.address, customer.district);
  const ip = meta.ip ?? undefined;
  const risk = await scoreOrderForCreate({ merchantId, cod: total, customer, ip, addressHash, scoring });

  // ---- One transaction: idempotency re-check, quota, order, stock -----------
  const session = await mongoose.startSession();
  let outcome: Outcome;
  try {
    outcome = await session.withTransaction<Outcome>(async () => {
      const dup = await Order.findOne({ merchantId, "source.clientRequestId": clientRequestId }).session(session).lean();
      if (dup) return { kind: "duplicate", order: dup };
      const reservation = await reserveQuota(merchantId, plan, "ordersCreated", 1, { session });
      if (!reservation.allowed) return { kind: "quota" };
      const orderId = new Types.ObjectId();
      const now = new Date();
      const [order] = await Order.create(
        [
          {
            _id: orderId,
            merchantId,
            orderNumber: generateOrderNumber(),
            customer,
            items,
            order: {
              cod: total,
              total,
              subtotal,
              deliveryCharge,
              currency,
              status: "pending",
              ...(deliveryLabel ? { deliveryArea: deliveryLabel } : {}),
              ...(notes ? { customerNote: notes } : {}),
            },
            fraud: fraudDocFromRisk(risk),
            inventory: { state: "reserved", cycle: 1, reservedAt: now },
            source: {
              ...(ip ? { ip } : {}),
              ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 500) } : {}),
              ...(addressHash ? { addressHash } : {}),
              channel: "landing_page",
              sourceProvider: "landing_page",
              clientRequestId,
              landingPageId: pageId,
              landingSlug: page.label,
              landingRevision: page.revision,
              locale: page.locale,
              ...(email ? { customerEmail: email } : {}),
              placedAt: now,
            },
          },
        ],
        { session },
      );
      await reserveOrderStock(session, { merchantId, orderId, items });
      return { kind: "created", order };
    });
  } catch (err) {
    if (err instanceof InventoryError && err.code === "insufficient_stock") {
      const p = await Product.findOne({ _id: err.productId, merchantId }).select("inventory").lean();
      return fail({ code: "insufficient_stock", productId: err.productId ?? "", available: availableStock(p?.inventory) });
    }
    if (err instanceof InventoryError) return fail({ code: "unavailable", productIds: err.productId ? [err.productId] : [] });
    const code = (err as { code?: number })?.code;
    if (code === 11000) {
      const winner = await Order.findOne({ merchantId, "source.clientRequestId": clientRequestId }).lean();
      if (winner) return { ok: true, ...placedFrom(winner, true) };
    }
    throw err;
  } finally {
    await session.endSession();
  }

  if (outcome.kind === "quota") return fail({ code: "not_accepting_orders" });
  if (outcome.kind === "duplicate") return { ok: true, ...placedFrom(outcome.order, true) };

  const order = outcome.order;
  void writeAudit({
    merchantId,
    actorId: merchantId,
    actorType: "system",
    action: "order.landing_placed",
    subjectType: "order",
    subjectId: order._id,
    meta: {
      landingPageId: String(pageId),
      slug: page.label,
      revision: page.revision,
      locale: page.locale,
      productIds: items.map((i) => String(i.productId)),
      total,
      currency,
      delivery: deliveryLabel,
    },
  });
  await afterOrderCreated({ merchantId, order, risk, userId: String(merchantId) });
  return { ok: true, ...placedFrom(order, false) };
}
