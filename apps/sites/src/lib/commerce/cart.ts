import { type CatalogProduct, type CatalogVariant, MAX_CART_LINES } from "@ecom/landing";

/**
 * Cart for one published landing page. Holds only product ids (plus the
 * variant id for a product with variants) and quantities — prices, names
 * and stock always come from the page's live catalog, and the server
 * re-checks everything when the order is placed.
 *
 * One line per product, or per variant: adding the same variant again
 * raises its quantity; different variants of one product are separate lines.
 */
export interface CartLine {
  productId: string;
  variantId?: string;
  quantity: number;
}

const ID_RE = /^[a-f0-9]{24}$/;

export const lineKey = (l: { productId: string; variantId?: string | null }) => (l.variantId ? `${l.productId}:${l.variantId}` : l.productId);

/** Parses stored/untrusted cart data. */
export function parseCart(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return [];
  const out: CartLine[] = [];
  for (const r of raw.slice(0, MAX_CART_LINES)) {
    const id = (r as { productId?: unknown })?.productId;
    const vid = (r as { variantId?: unknown })?.variantId;
    const q = (r as { quantity?: unknown })?.quantity;
    if (typeof id !== "string" || !ID_RE.test(id) || typeof q !== "number" || !Number.isInteger(q) || q <= 0) continue;
    if (vid !== undefined && (typeof vid !== "string" || !ID_RE.test(vid))) continue;
    const line: CartLine = { productId: id, ...(typeof vid === "string" ? { variantId: vid } : {}), quantity: q };
    if (!out.some((l) => lineKey(l) === lineKey(line))) out.push(line);
  }
  return out;
}

/** The variant a line refers to (null for a simple product; undefined when it no longer exists). */
function variantOf(product: CatalogProduct, variantId?: string): CatalogVariant | null | undefined {
  if (!product.variants?.length) return variantId ? undefined : null;
  return variantId ? product.variants.find((v) => v.id === variantId) : undefined;
}

/** Most units one line can hold: the variant's for a variant line, else the product's. */
function maxFor(product: CatalogProduct, variant: CatalogVariant | null): number {
  if (variant) return variant.available ? variant.maxQuantity : 0;
  return product.available ? product.maxQuantity : 0;
}

/** Drops lines for products/variants that are gone or unavailable; caps quantities at what can be bought. */
export function reconcileCart(lines: CartLine[], catalog: CatalogProduct[]): CartLine[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const out: CartLine[] = [];
  for (const l of lines) {
    const p = byId.get(l.productId);
    if (!p) continue;
    const v = variantOf(p, l.variantId);
    if (v === undefined) continue;
    const max = maxFor(p, v);
    if (max < 1) continue;
    out.push({ ...l, quantity: Math.min(l.quantity, max) });
  }
  return out;
}

export function addToCart(lines: CartLine[], product: CatalogProduct, quantity = 1, variant: CatalogVariant | null = null): CartLine[] {
  if (product.variants?.length && !variant) return lines; // a variant must be chosen
  const max = maxFor(product, variant);
  if (max < 1) return lines;
  const key = lineKey({ productId: product.id, variantId: variant?.id });
  const existing = lines.find((l) => lineKey(l) === key);
  if (existing) return setQuantity(lines, product, existing.quantity + quantity, variant);
  if (lines.length >= MAX_CART_LINES) return lines;
  return [...lines, { productId: product.id, ...(variant ? { variantId: variant.id } : {}), quantity: Math.min(quantity, max) }];
}

export function setQuantity(lines: CartLine[], product: CatalogProduct, quantity: number, variant: CatalogVariant | null = null): CartLine[] {
  const q = Math.max(1, Math.min(Math.floor(quantity), maxFor(product, variant)));
  const key = lineKey({ productId: product.id, variantId: variant?.id });
  return lines.map((l) => (lineKey(l) === key ? { ...l, quantity: q } : l));
}

/**
 * Buy now: make sure the cart holds `quantity` of this product (or variant)
 * without adding a second batch — pressing Buy now twice, or after adding
 * the same item to the cart, checks out what the customer chose instead of
 * doubling it. Other lines stay as they are. Same caps as `addToCart`;
 * returns the lines unchanged when the item cannot be bought.
 */
export function buyNowLines(lines: CartLine[], product: CatalogProduct, quantity = 1, variant: CatalogVariant | null = null): CartLine[] {
  if (product.variants?.length && !variant) return lines; // a variant must be chosen
  if (maxFor(product, variant) < 1) return lines;
  const key = lineKey({ productId: product.id, variantId: variant?.id });
  const existing = lines.find((l) => lineKey(l) === key);
  if (!existing) return addToCart(lines, product, quantity, variant);
  return existing.quantity >= quantity ? lines : setQuantity(lines, product, quantity, variant);
}

export function removeFromCart(lines: CartLine[], key: string): CartLine[] {
  return lines.filter((l) => lineKey(l) !== key);
}

export interface CartRow {
  key: string;
  product: CatalogProduct;
  variant: CatalogVariant | null;
  /** Price of this line's unit: the variant's, else the product's. */
  price: number;
  /** Image of this line: the variant's, else the product's. */
  imageAssetId: string | null;
  quantity: number;
  lineTotal: number;
}

export interface CartTotals {
  count: number;
  subtotal: number;
  lines: CartRow[];
}

export function cartTotals(lines: CartLine[], catalog: CatalogProduct[]): CartTotals {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const rows = lines.flatMap((l): CartRow[] => {
    const p = byId.get(l.productId);
    if (!p) return [];
    const v = variantOf(p, l.variantId);
    if (v === undefined) return [];
    const price = v ? v.price : p.price;
    return [
      {
        key: lineKey(l),
        product: p,
        variant: v,
        price,
        imageAssetId: v?.imageAssetId ?? p.imageAssetId,
        quantity: l.quantity,
        lineTotal: Math.round(price * l.quantity * 100) / 100,
      },
    ];
  });
  return {
    count: rows.reduce((s, r) => s + r.quantity, 0),
    subtotal: Math.round(rows.reduce((s, r) => s + r.lineTotal, 0) * 100) / 100,
    lines: rows,
  };
}

/** Random, URL-safe idempotency key for one checkout attempt. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const storageKey = (slug: string) => `confirmx:cart:${slug}`;

export function loadCart(slug: string): CartLine[] {
  try {
    return parseCart(JSON.parse(window.localStorage.getItem(storageKey(slug)) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveCart(slug: string, lines: CartLine[]): void {
  try {
    if (lines.length) window.localStorage.setItem(storageKey(slug), JSON.stringify(lines));
    else window.localStorage.removeItem(storageKey(slug));
  } catch {
    // Storage blocked (private mode): the cart still works for this visit.
  }
}
