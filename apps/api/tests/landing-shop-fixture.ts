import { Order, Product } from "@ecom/db";
import { placeLandingOrder, type PlaceOrderInput } from "../src/lib/commerce/landing-orders.js";
import { ensureSystemTemplates } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { authUserFor, callerFor, createMerchant } from "./helpers.js";

/** Shared test fixture (not a test file): a published landing page selling one product. */

let seq = 0;
export const key = () => `mkt-${Date.now()}-${++seq}-abcdefgh`;

/** One attribution touch dated now (or `at`). */
export const touch = (extra: Record<string, unknown>, at = new Date()) => ({ at: at.toISOString(), ...extra });

export async function shop(slug = `mkt-${seq++}-shop`) {
  await ensureSystemTemplates();
  const merchant = await createMerchant();
  const caller = callerFor(authUserFor(merchant));
  const shirt = await caller.products.create({ name: "Shirt", price: 1000, initialStock: 50 });
  const tpl = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
  const page = await caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
  const got = await caller.landingPages.get({ id: page.id });
  const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
  bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
  const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
  const linked = await caller.landingPages.setProducts({ id: page.id, expectedRevision: saved.page.draftRevision, products: [{ productId: shirt.id }] });
  await caller.landingPages.setSlug({ id: page.id, slug });
  await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
  const host = `${slug}.localhost`;
  const resolved = await resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });
  if (resolved.kind !== "ok") throw new Error("not published");
  const zone = resolved.commerce!.delivery[0]!.id;
  const place = (attribution?: unknown, phone = "01712345678", extra: Partial<PlaceOrderInput> = {}) =>
    placeLandingOrder({
      host,
      locale: null,
      idempotencyKey: key(),
      items: [{ productId: shirt.id, quantity: 1 }],
      customer: { name: "রহিম", phone, address: "বাড়ি ১২, রোড ৫, ধানমন্ডি", district: "ঢাকা" },
      deliveryOptionId: zone,
      attribution,
      ...extra,
    });
  return { merchant, caller, page, shirt, host, place };
}


export async function deliver(caller: ReturnType<typeof callerFor>, orderNumber: string) {
  const o = await Order.findOne({ orderNumber }).lean();
  for (const s of ["confirmed", "packed", "shipped", "delivered"]) await caller.orders.updateOrder({ id: String(o!._id), status: s as never });
  return o!;
}

export { Product };
