import { type CatalogProduct, MAX_CART_LINES } from "@ecom/landing";

/**
 * Cart for one published landing page. Holds only product ids and
 * quantities — prices, names and stock always come from the page's live
 * catalog, and the server re-checks everything when the order is placed.
 */
export interface CartLine {
  productId: string;
  quantity: number;
}

const ID_RE = /^[a-f0-9]{24}$/;

/** Parses stored/untrusted cart data. */
export function parseCart(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return [];
  const out: CartLine[] = [];
  for (const r of raw.slice(0, MAX_CART_LINES)) {
    const id = (r as { productId?: unknown })?.productId;
    const q = (r as { quantity?: unknown })?.quantity;
    if (typeof id === "string" && ID_RE.test(id) && typeof q === "number" && Number.isInteger(q) && q > 0 && !out.some((l) => l.productId === id)) {
      out.push({ productId: id, quantity: q });
    }
  }
  return out;
}

/** Drops lines for products that are gone or unavailable; caps quantities at what can be bought. */
export function reconcileCart(lines: CartLine[], catalog: CatalogProduct[]): CartLine[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const out: CartLine[] = [];
  for (const l of lines) {
    const p = byId.get(l.productId);
    if (!p || !p.available || p.maxQuantity < 1) continue;
    out.push({ productId: l.productId, quantity: Math.min(l.quantity, p.maxQuantity) });
  }
  return out;
}

export function addToCart(lines: CartLine[], product: CatalogProduct, quantity = 1): CartLine[] {
  if (!product.available || product.maxQuantity < 1) return lines;
  const existing = lines.find((l) => l.productId === product.id);
  if (existing) return setQuantity(lines, product, existing.quantity + quantity);
  if (lines.length >= MAX_CART_LINES) return lines;
  return [...lines, { productId: product.id, quantity: Math.min(quantity, product.maxQuantity) }];
}

export function setQuantity(lines: CartLine[], product: CatalogProduct, quantity: number): CartLine[] {
  const q = Math.max(1, Math.min(Math.floor(quantity), product.maxQuantity));
  return lines.map((l) => (l.productId === product.id ? { ...l, quantity: q } : l));
}

export function removeFromCart(lines: CartLine[], productId: string): CartLine[] {
  return lines.filter((l) => l.productId !== productId);
}

export interface CartTotals {
  count: number;
  subtotal: number;
  lines: Array<{ product: CatalogProduct; quantity: number; lineTotal: number }>;
}

export function cartTotals(lines: CartLine[], catalog: CatalogProduct[]): CartTotals {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const rows = lines.flatMap((l) => {
    const p = byId.get(l.productId);
    return p ? [{ product: p, quantity: l.quantity, lineTotal: Math.round(p.price * l.quantity * 100) / 100 }] : [];
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
