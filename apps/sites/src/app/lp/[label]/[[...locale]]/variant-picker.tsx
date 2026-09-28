"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type CatalogProduct, type CatalogVariant, type CommerceStrings, findVariant } from "@ecom/landing";

/**
 * Variant picker for a product with variants (e.g. Color × Size): one row of
 * value buttons per option; the image, price and availability follow the
 * selection immediately. Only combinations the catalog offers can be picked;
 * values that lead to no available variant are shown disabled. The server
 * re-checks the variant, its price and its stock at checkout.
 */
export function VariantPicker({
  product,
  t,
  money,
  num,
  imageUrl,
  onAdd,
  onClose,
}: {
  product: CatalogProduct;
  t: CommerceStrings;
  money: (n: number) => string;
  num: (n: number) => string;
  imageUrl: (assetId: string | null) => string | null;
  onAdd: (variant: CatalogVariant, quantity: number) => void;
  onClose: () => void;
}) {
  const options = product.options ?? [];
  const variants = product.variants ?? [];
  // Start on the first available variant (or nothing picked).
  const first = variants.find((v) => v.available);
  const [picked, setPicked] = useState<Array<string | null>>(() => options.map((_, i) => first?.optionValues[i] ?? null));
  const [qty, setQty] = useState(1);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const complete = picked.every((v): v is string => v !== null);
  const variant = complete ? findVariant(product, picked as string[]) : undefined;
  const max = variant?.available ? variant.maxQuantity : 0;
  useEffect(() => setQty((q) => Math.max(1, Math.min(q, Math.max(1, max)))), [max]);

  /** Can `value` at option `i` still lead to an available variant, given the other picks? */
  const possible = useMemo(
    () => (i: number, value: string) =>
      variants.some((v) => v.available && v.optionValues[i] === value && picked.every((p, j) => j === i || p === null || v.optionValues[j] === p)),
    [variants, picked],
  );

  const image = imageUrl(variant?.imageAssetId ?? product.imageAssetId);
  const price = variant?.price ?? product.price;
  const old = variant?.compareAtPrice && variant.compareAtPrice > price ? variant.compareAtPrice : null;

  return (
    <div className="fixed inset-0 z-50" data-lp-variant-picker="">
      <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 h-full w-full cursor-default bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lpv-title"
        className="absolute inset-x-0 bottom-0 max-h-[92vh] overflow-y-auto rounded-t-2xl bg-white p-4 text-neutral-900 shadow-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[440px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {image ? <img src={image} alt="" className="h-full w-full object-cover" data-lp-variant-image="" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="lpv-title" className="line-clamp-2 font-semibold leading-snug">
              {product.name}
            </h2>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="text-lg font-bold tabular-nums text-[color:var(--lp-primary)]">{money(price)}</span>
              {old ? <span className="text-sm text-neutral-500 line-through tabular-nums">{money(old)}</span> : null}
            </p>
            <p className="mt-0.5 text-sm" aria-live="polite">
              {!complete ? (
                <span className="text-neutral-500">{t.chooseOptions}</span>
              ) : !variant || !variant.available ? (
                <span className="text-red-600">{t.outOfStock}</span>
              ) : variant.stockStatus === "low_stock" ? (
                <span className="font-medium text-amber-700">{t.lowStock}</span>
              ) : (
                <span className="text-green-700">{t.inStock}</span>
              )}
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="-mr-1 -mt-1 inline-flex h-10 w-10 items-center justify-center rounded-full text-xl hover:bg-neutral-100" aria-label={t.close}>
            ×
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {options.map((o, i) => (
            <fieldset key={o.name}>
              <legend className="mb-2 text-sm font-medium">
                {o.name}
                {picked[i] ? <span className="font-normal text-neutral-500">: {picked[i]}</span> : <span className="font-normal text-neutral-500"> — {t.chooseValue(o.name)}</span>}
              </legend>
              <div className="flex flex-wrap gap-2">
                {o.values.map((value) => {
                  const selected = picked[i] === value;
                  const can = possible(i, value);
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setPicked((p) => p.map((x, j) => (j === i ? (selected ? null : value) : x)))}
                      className={
                        "min-h-10 rounded-full border px-4 py-1.5 text-sm transition-colors " +
                        (selected
                          ? "border-[var(--lp-primary)] bg-[var(--lp-primary)] font-semibold text-[color:var(--lp-on-primary)]"
                          : can
                            ? "border-neutral-300 hover:border-neutral-500"
                            : "border-dashed border-neutral-300 text-neutral-400 line-through")
                      }
                      data-lp-option={o.name}
                      data-lp-value={value}
                    >
                      {value}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="mt-5 flex items-center gap-3">
          <div className="inline-flex items-center rounded-full border border-neutral-300" role="group" aria-label={t.quantity}>
            <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-lg disabled:opacity-40" aria-label={t.decrease}>
              −
            </button>
            <span className="min-w-8 text-center font-semibold tabular-nums" aria-live="polite">
              {num(qty)}
            </span>
            <button type="button" onClick={() => setQty((q) => Math.min(max, q + 1))} disabled={!max || qty >= max} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-lg disabled:opacity-40" aria-label={t.increase}>
              +
            </button>
          </div>
          <button
            type="button"
            disabled={!variant || !variant.available}
            onClick={() => variant && onAdd(variant, qty)}
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-[var(--lp-radius)] bg-[var(--lp-primary)] px-5 py-3 text-base font-semibold text-[color:var(--lp-on-primary)] shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            data-lp-variant-add=""
          >
            {t.addToCart}
          </button>
        </div>
      </div>
    </div>
  );
}
