"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CatalogProduct,
  type DeliveryOption,
  type LandingCommerce as Commerce,
  type Locale,
  type NumeralMode,
  commerceStrings,
  formatMoney,
  formatNumber,
  normalizeBdMobile,
} from "@ecom/landing";
import { emitCommerceEvent } from "@/lib/analytics/commerce-events";
import {
  type CartLine,
  addToCart,
  cartTotals,
  loadCart,
  newIdempotencyKey,
  reconcileCart,
  removeFromCart,
  saveCart,
  setQuantity,
} from "@/lib/commerce/cart";

/**
 * Cart + cash-on-delivery checkout for a published landing page.
 *
 * Product cards render plain `<button data-lp-cart-add>` elements (server
 * markup, see CatalogProductCard); this component picks clicks up by
 * delegation, keeps the cart (ids + quantities only), and places the order
 * through the page's same-origin /api/checkout proxy. Prices, stock and the
 * merchant are always re-decided by the server.
 *
 * Drawer on tablet/desktop, full-height sheet on phones. Mounted by the
 * public page only — the editor preview never mounts it, so buttons there
 * stay inert.
 */

type Step = "cart" | "details" | "review" | "done";
type Details = { name: string; phone: string; address: string; district: string; email: string; notes: string; delivery: string };
type Placed = { orderNumber: string; total: number; currency: string };

const EMPTY: Details = { name: "", phone: "", address: "", district: "", email: "", notes: "", delivery: "" };

function Icon({ d, className = "h-5 w-5" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const BAG = "M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0";
const CLOSE = "M18 6L6 18M6 6l12 12";

export function LandingCommerce({
  commerce,
  locale,
  slug,
  numerals,
  assetBaseUrl,
}: {
  commerce: Commerce;
  locale: Locale;
  slug: string;
  numerals?: NumeralMode;
  assetBaseUrl: string;
}) {
  const t = commerceStrings(locale);
  const catalog = commerce.products;
  const byId = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);
  const money = useCallback((v: number) => formatMoney(v, commerce.currency, { locale, numerals }), [commerce.currency, locale, numerals]);
  const num = useCallback((v: number) => formatNumber(v, { locale, numerals, maxFractionDigits: 0 }), [locale, numerals]);
  const imageUrl = (p: CatalogProduct) => (p.imageAssetId ? `${assetBaseUrl.replace(/\/+$/, "")}/${p.imageAssetId}` : null);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("cart");
  const [details, setDetails] = useState<Details>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Set<keyof Details>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const keyRef = useRef<string | null>(null);
  const linesRef = useRef<CartLine[]>([]);
  linesRef.current = lines;
  // Synchronous guard: two clicks in the same tick must not start two requests.
  const placingRef = useRef(false);
  const loaded = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  // Restore this page's cart, checked against live stock.
  useEffect(() => {
    setLines(reconcileCart(loadCart(slug), catalog));
    loaded.current = true;
  }, [slug, catalog]);
  useEffect(() => {
    if (loaded.current) saveCart(slug, lines);
  }, [slug, lines]);

  const totals = cartTotals(lines, catalog);
  const delivery: DeliveryOption | null = commerce.delivery.find((d) => d.id === details.delivery) ?? (commerce.delivery.length === 1 ? commerce.delivery[0]! : null);
  const deliveryCharge = delivery?.charge ?? 0;
  const total = totals.subtotal + deliveryCharge;

  const openDrawer = useCallback((s: Step = "cart") => {
    lastFocus.current = document.activeElement as HTMLElement | null;
    setStep(s);
    setError(null);
    setPlaced(null);
    setOpen(true);
  }, []);
  const closeDrawer = useCallback(() => {
    setOpen(false);
    setNotice(null);
    if (step === "done") {
      setStep("cart");
      setPlaced(null);
    }
    lastFocus.current?.focus?.();
  }, [step]);

  // "Add to cart" buttons in the page (delegated; the markup is server-rendered).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const btn = (e.target instanceof Element ? e.target : null)?.closest<HTMLButtonElement>("button[data-lp-cart-add]");
      if (!btn || !btn.closest("[data-landing-root]")) return;
      e.preventDefault();
      const product = byId.get(btn.dataset.lpCartAdd ?? "");
      if (!product || !product.available) return;
      const prev = linesRef.current;
      const next = addToCart(prev, product, 1);
      const before = prev.find((l) => l.productId === product.id)?.quantity ?? 0;
      const after = next.find((l) => l.productId === product.id)?.quantity ?? 0;
      if (after > before) {
        linesRef.current = next;
        setLines(next);
        setNotice(null);
        keyRef.current = null;
        emitCommerceEvent({ type: "add_to_cart", line: { id: product.id, quantity: after - before, price: product.price }, name: product.name, currency: product.currency });
      } else {
        setNotice(t.maxReached);
      }
      openDrawer("cart");
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [byId, openDrawer, t.maxReached]);

  // Dialog behaviour: Escape closes, focus moves in, page behind does not scroll.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !placing) closeDrawer();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, placing, closeDrawer]);

  const changeLines = (next: CartLine[]) => {
    setLines(next);
    keyRef.current = null; // a different cart is a different order attempt
    setNotice(null);
  };

  const validate = (): boolean => {
    const bad = new Set<keyof Details>();
    if (details.name.trim().length < 2) bad.add("name");
    if (!normalizeBdMobile(details.phone)) bad.add("phone");
    if (details.address.trim().length < 5) bad.add("address");
    if (details.district.trim().length < 2) bad.add("district");
    if (details.email.trim() && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(details.email.trim())) bad.add("email");
    if (commerce.delivery.length > 1 && !commerce.delivery.some((d) => d.id === details.delivery)) bad.add("delivery");
    setFieldErrors(bad);
    return bad.size === 0;
  };

  const goCheckout = () => {
    setError(null);
    setStep("details");
    emitCommerceEvent({
      type: "initiate_checkout",
      lines: totals.lines.map((l) => ({ id: l.product.id, quantity: l.quantity, price: l.product.price })),
      value: totals.subtotal,
      currency: commerce.currency,
    });
  };

  const placeOrder = async () => {
    if (placingRef.current || totals.lines.length === 0) return;
    placingRef.current = true;
    setPlacing(true);
    setError(null);
    keyRef.current ??= newIdempotencyKey();
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locale,
          idempotencyKey: keyRef.current,
          items: totals.lines.map((l) => ({ productId: l.product.id, quantity: l.quantity, unitPrice: l.product.price })),
          customer: {
            name: details.name,
            phone: details.phone,
            address: details.address,
            district: details.district,
            email: details.email || null,
            notes: details.notes || null,
          },
          deliveryOptionId: delivery?.id ?? null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.ok === true) {
        const orderRef = String(body.orderNumber ?? "");
        const orderTotal = Number(body.total ?? total);
        const currency = String(body.currency ?? commerce.currency);
        const items = Array.isArray(body.items) ? (body.items as Array<{ productId: string; quantity: number; price: number }>) : [];
        emitCommerceEvent({
          type: "purchase",
          orderRef,
          lines: items.map((i) => ({ id: i.productId, quantity: i.quantity, price: i.price })),
          value: orderTotal,
          currency,
        });
        setPlaced({ orderNumber: String(body.orderNumber ?? ""), total: orderTotal, currency });
        setLines([]);
        setDetails((d) => ({ ...EMPTY, delivery: d.delivery }));
        keyRef.current = null;
        setStep("done");
        return;
      }
      const code = String(body.code ?? "");
      if (code === "insufficient_stock") {
        const id = String(body.productId ?? "");
        const available = Number(body.available ?? 0);
        setLines((prev) => (available > 0 ? prev.map((l) => (l.productId === id ? { ...l, quantity: Math.min(l.quantity, available) } : l)) : removeFromCart(prev, id)));
        keyRef.current = null;
        setStep("cart");
        setError(t.errors.stock);
      } else if (code === "unavailable" || code === "not_on_page") {
        const ids = new Set(Array.isArray(body.productIds) ? (body.productIds as string[]) : []);
        setLines((prev) => prev.filter((l) => !ids.has(l.productId)));
        keyRef.current = null;
        setStep("cart");
        setError(t.errors.unavailable);
      } else if (code === "price_changed") {
        keyRef.current = null;
        setError(t.errors.priceChanged);
      } else if (code === "invalid_customer") {
        const fields = new Set((Array.isArray(body.fields) ? body.fields : []) as Array<keyof Details>);
        setFieldErrors(fields);
        setStep("details");
      } else if (code === "invalid_delivery") {
        setFieldErrors(new Set(["delivery"]));
        setStep("details");
      } else if (code === "rate_limited" || res.status === 429) {
        setError(t.errors.rateLimited);
      } else {
        setError(t.errors.generic);
      }
    } catch {
      // Network failure: keep the same key, so retrying can never create a second order.
      setError(t.errors.generic);
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  };

  const field = (key: keyof Details, label: string, opts: { type?: string; textarea?: boolean; optional?: boolean; hint?: string; autoComplete?: string; inputMode?: "tel" | "email" | "text" } = {}) => {
    const id = `lpc-${key}`;
    const invalid = fieldErrors.has(key);
    const common = {
      id,
      value: details[key],
      "aria-invalid": invalid || undefined,
      "aria-describedby": invalid ? `${id}-err` : undefined,
      autoComplete: opts.autoComplete,
      onChange: (e: { target: { value: string } }) => {
        setDetails((d) => ({ ...d, [key]: e.target.value }));
        if (invalid) setFieldErrors((s) => new Set([...s].filter((k) => k !== key)));
      },
      className: `w-full rounded-[var(--lp-radius)] border bg-white px-3 py-2.5 text-base text-neutral-900 outline-none focus:ring-2 focus:ring-[var(--lp-primary)] ${invalid ? "border-red-500" : "border-neutral-300"}`,
    };
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="block text-sm font-medium text-neutral-800">
          {label}
          {opts.optional ? <span className="font-normal text-neutral-500"> ({t.optional})</span> : null}
        </label>
        {opts.textarea ? <textarea rows={key === "address" ? 3 : 2} {...common} /> : <input type={opts.type ?? "text"} inputMode={opts.inputMode} {...common} />}
        {opts.hint && !invalid ? <p className="text-xs text-neutral-500">{opts.hint}</p> : null}
        {invalid ? (
          <p id={`${id}-err`} className="text-xs text-red-600">
            {t.errors[key as keyof typeof t.errors] ?? t.errors.generic}
          </p>
        ) : null}
      </div>
    );
  };

  const summaryRows = (
    <dl className="space-y-1.5 text-sm">
      <div className="flex justify-between gap-3">
        <dt className="text-neutral-600">{t.subtotal}</dt>
        <dd className="tabular-nums">{money(totals.subtotal)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-neutral-600">
          {t.delivery}
          {delivery ? <span className="text-neutral-500"> · {delivery.label}</span> : null}
        </dt>
        <dd className="tabular-nums">{commerce.delivery.length === 0 ? t.deliveryTbd : delivery ? money(deliveryCharge) : "—"}</dd>
      </div>
      <div className="flex justify-between gap-3 border-t border-neutral-200 pt-2 text-base font-bold">
        <dt>{t.total}</dt>
        <dd className="tabular-nums">{money(total)}</dd>
      </div>
    </dl>
  );

  const primaryBtn =
    "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--lp-radius)] bg-[var(--lp-primary)] px-5 py-3 text-base font-semibold text-[color:var(--lp-on-primary)] shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";
  const secondaryBtn = "inline-flex min-h-12 items-center justify-center rounded-[var(--lp-radius)] border border-neutral-300 px-4 py-3 text-base font-medium text-neutral-800 hover:bg-neutral-50";

  const title = step === "cart" ? t.cart : step === "details" ? t.yourDetails : step === "review" ? t.review : t.success;

  return (
    <>
      {totals.count > 0 && !open ? (
        <button
          type="button"
          onClick={() => openDrawer("cart")}
          className="fixed bottom-4 right-4 z-40 inline-flex min-h-14 items-center gap-2 rounded-full bg-[var(--lp-primary)] px-5 py-3 font-semibold text-[color:var(--lp-on-primary)] shadow-lg ring-1 ring-black/10 sm:bottom-6 sm:right-6"
          aria-label={t.openCart(num(totals.count))}
          data-lp-cart-button=""
        >
          <Icon d={BAG} />
          <span>{t.cart}</span>
          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-white px-1.5 text-sm font-bold text-neutral-900">{num(totals.count)}</span>
        </button>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-50" data-lp-cart-drawer="">
          <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 h-full w-full cursor-default bg-black/50" onClick={() => !placing && closeDrawer()} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="lpc-title"
            lang={locale}
            className="absolute inset-0 flex flex-col bg-white text-neutral-900 shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[420px] sm:max-w-[92vw]"
          >
            <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
              <h2 id="lpc-title" className="text-lg font-bold">
                {title}
              </h2>
              <button ref={closeRef} type="button" onClick={closeDrawer} disabled={placing} className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-neutral-100" aria-label={t.close}>
                <Icon d={CLOSE} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {error ? (
                <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              ) : null}
              {notice && step === "cart" ? (
                <p role="status" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {notice}
                </p>
              ) : null}

              {step === "cart" ? (
                totals.lines.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-12 text-center text-neutral-600">
                    <Icon d={BAG} className="h-10 w-10 text-neutral-400" />
                    <p className="font-medium">{t.emptyCart}</p>
                    <button type="button" onClick={closeDrawer} className={secondaryBtn}>
                      {t.continueShopping}
                    </button>
                  </div>
                ) : (
                  <ul className="divide-y divide-neutral-200">
                    {totals.lines.map(({ product: p, quantity, lineTotal }) => {
                      const src = imageUrl(p);
                      const atMax = quantity >= p.maxQuantity;
                      return (
                        <li key={p.id} className="flex gap-3 py-3" data-lp-cart-line={p.id}>
                          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="line-clamp-2 font-medium leading-snug">{p.name}</p>
                              <button
                                type="button"
                                onClick={() => changeLines(removeFromCart(lines, p.id))}
                                className="shrink-0 rounded px-1.5 py-1 text-sm text-neutral-500 underline-offset-2 hover:text-red-600 hover:underline"
                              >
                                {t.remove}
                              </button>
                            </div>
                            <p className="text-sm text-neutral-600 tabular-nums">{money(p.price)}</p>
                            <div className="mt-2 flex items-center justify-between gap-2">
                              <div className="inline-flex items-center rounded-full border border-neutral-300" role="group" aria-label={t.quantity}>
                                <button
                                  type="button"
                                  onClick={() => changeLines(setQuantity(lines, p, quantity - 1))}
                                  disabled={quantity <= 1}
                                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-lg disabled:opacity-40"
                                  aria-label={t.decrease}
                                >
                                  −
                                </button>
                                <span className="min-w-8 text-center font-semibold tabular-nums" aria-live="polite">
                                  {num(quantity)}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => changeLines(setQuantity(lines, p, quantity + 1))}
                                  disabled={atMax}
                                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-lg disabled:opacity-40"
                                  aria-label={t.increase}
                                  title={atMax ? t.maxReached : undefined}
                                >
                                  +
                                </button>
                              </div>
                              <p className="font-semibold tabular-nums">{money(lineTotal)}</p>
                            </div>
                            {atMax ? <p className="mt-1 text-xs text-amber-700">{t.maxReached}</p> : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : null}

              {step === "details" ? (
                <form
                  id="lpc-details"
                  className="space-y-3"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (validate()) setStep("review");
                  }}
                >
                  {field("name", t.name, { autoComplete: "name" })}
                  {field("phone", t.phone, { type: "tel", inputMode: "tel", hint: t.phoneHint, autoComplete: "tel" })}
                  {field("address", t.address, { textarea: true, autoComplete: "street-address" })}
                  {field("district", t.district, { autoComplete: "address-level2" })}
                  {commerce.delivery.length > 0 ? (
                    <fieldset className="space-y-1.5">
                      <legend className="text-sm font-medium text-neutral-800">{t.deliveryArea}</legend>
                      {commerce.delivery.map((d) => (
                        <label
                          key={d.id}
                          className={`flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-[var(--lp-radius)] border px-3 py-2 ${(delivery?.id ?? "") === d.id ? "border-[var(--lp-primary)] ring-1 ring-[var(--lp-primary)]" : "border-neutral-300"}`}
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="lpc-delivery"
                              value={d.id}
                              checked={(delivery?.id ?? "") === d.id}
                              onChange={() => {
                                setDetails((x) => ({ ...x, delivery: d.id }));
                                setFieldErrors((s) => new Set([...s].filter((k) => k !== "delivery")));
                              }}
                            />
                            <span>
                              {d.label}
                              {d.time ? <span className="block text-xs text-neutral-500">{d.time}</span> : null}
                            </span>
                          </span>
                          <span className="font-medium tabular-nums">{money(d.charge)}</span>
                        </label>
                      ))}
                      {fieldErrors.has("delivery") ? <p className="text-xs text-red-600">{t.errors.delivery}</p> : null}
                    </fieldset>
                  ) : null}
                  {field("email", t.email, { type: "email", inputMode: "email", optional: true, autoComplete: "email" })}
                  {field("notes", t.notes, { textarea: true, optional: true })}
                </form>
              ) : null}

              {step === "review" ? (
                <div className="space-y-4">
                  <ul className="space-y-2 text-sm">
                    {totals.lines.map(({ product: p, quantity, lineTotal }) => (
                      <li key={p.id} className="flex justify-between gap-3">
                        <span className="min-w-0">
                          {p.name} <span className="text-neutral-500">× {num(quantity)}</span>
                        </span>
                        <span className="shrink-0 tabular-nums">{money(lineTotal)}</span>
                      </li>
                    ))}
                  </ul>
                  {summaryRows}
                  <div className="rounded-lg bg-neutral-50 p-3 text-sm">
                    <p className="font-medium">{details.name}</p>
                    <p className="text-neutral-700">{details.phone}</p>
                    <p className="whitespace-pre-line text-neutral-700">
                      {details.address}, {details.district}
                    </p>
                  </div>
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
                    <p className="font-semibold">{t.cod}</p>
                    <p>{t.codNote}</p>
                  </div>
                </div>
              ) : null}

              {step === "done" && placed ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center" role="status">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-700">
                    <Icon d="M5 12l5 5L20 7" className="h-7 w-7" />
                  </div>
                  <p className="text-lg font-bold">{t.success}</p>
                  <p className="text-sm text-neutral-600">
                    {t.orderNumber}: <span className="font-mono font-semibold text-neutral-900">{placed.orderNumber}</span>
                  </p>
                  <p className="text-sm text-neutral-600">
                    {t.total}: <span className="font-semibold text-neutral-900">{formatMoney(placed.total, placed.currency, { locale, numerals })}</span>
                  </p>
                  <p className="max-w-xs text-sm text-neutral-600">{t.successNote}</p>
                </div>
              ) : null}
            </div>

            {step !== "done" && totals.lines.length > 0 ? (
              <footer className="space-y-3 border-t border-neutral-200 px-4 py-4">
                {step !== "review" ? summaryRows : null}
                {step === "cart" ? (
                  <button type="button" onClick={goCheckout} className={primaryBtn}>
                    {t.orderNow}
                  </button>
                ) : step === "details" ? (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setStep("cart")} className={secondaryBtn}>
                      {t.back}
                    </button>
                    <button type="submit" form="lpc-details" className={primaryBtn}>
                      {t.review}
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setStep("details")} disabled={placing} className={secondaryBtn}>
                      {t.back}
                    </button>
                    <button type="button" onClick={() => void placeOrder()} disabled={placing} className={primaryBtn} aria-busy={placing} data-lp-place-order="">
                      {placing ? t.placing : t.placeOrder}
                    </button>
                  </div>
                )}
              </footer>
            ) : step === "done" ? (
              <footer className="border-t border-neutral-200 px-4 py-4">
                <button type="button" onClick={closeDrawer} className={primaryBtn}>
                  {t.close}
                </button>
              </footer>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
