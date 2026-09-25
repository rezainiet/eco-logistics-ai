import type { ReactNode } from "react";
import { ctaHref, hasCta } from "../cta.js";
import type { CtaValue, ImageValue } from "../fields.js";
import { type NumeralMode, discountPercent, formatBDT, formatPercent } from "../format.js";
import type { Locale } from "../locales.js";
import { ASSET_ID_RE, parseRichText } from "../safe.js";
import type { IconName, PaymentMethod } from "../vocab.js";
import { PAYMENT_METHODS } from "../vocab.js";
import { type UiStrings, uiStrings } from "./strings.js";

/**
 * Trusted rendering primitives. Components never interpolate merchant
 * values into markup strings, `dangerouslySetInnerHTML`, event handlers,
 * `style` values (other than pre-validated theme tokens set once on the
 * renderer root), or URLs that did not come out of `ctaHref`/`assetUrl`.
 */

export interface RenderEnv {
  /** Maps a validated asset id to an image URL. Returns null if unavailable. */
  assetUrl: (assetId: string) => string | null;
  /** Content locale — drives UI strings, digits and typography. Default "en". */
  locale?: Locale;
  numerals?: NumeralMode;
  /**
   * Editor preview only: tag elements with the schema field they display
   * (`data-lp-field`) so a click can open that field. Never set on public
   * pages, whose markup therefore carries no editor attributes.
   */
  editable?: boolean;
}

/** Attributes naming the schema field an element shows — empty unless editable. */
export type EditAttrs = { "data-lp-field"?: string };

/**
 * Click-to-edit tag. `path` is relative to the section and uses schema keys
 * only (`headline`, `items.2.price`), so it follows the template, not the DOM.
 */
export function ed(env: RenderEnv, ...path: Array<string | number>): EditAttrs {
  return env.editable ? { "data-lp-field": path.join(".") } : {};
}

export interface Ctx {
  env: RenderEnv;
  locale: Locale;
  t: UiStrings;
  money: (v: unknown) => string | null;
}

export function ctxOf(env: RenderEnv): Ctx {
  const locale = env.locale ?? "en";
  return {
    env,
    locale,
    t: uiStrings(locale),
    money: (v) => (typeof v === "number" && Number.isFinite(v) ? formatBDT(v, { locale, numerals: env.numerals }) : null),
  };
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Typography classes. Tracking, line-height and display weight come from
 * CSS variables that the renderer sets per locale: Latin headings are set
 * tight; Bangla headings get normal tracking and taller line boxes so
 * vowel signs above and below (ি ী ু ূ ৃ) never clip.
 */
export const TYPE = {
  // "!" — responsive text-size utilities (sm:text-5xl…) also set line-height
  // and would otherwise override the per-locale value at larger breakpoints.
  display: "[font-weight:var(--lp-weight-display)] !leading-[var(--lp-lh-heading)] tracking-[var(--lp-tracking)]",
  heading: "[font-weight:var(--lp-weight-heading)] !leading-[var(--lp-lh-heading)] tracking-[var(--lp-tracking)]",
  eyebrow: "text-sm font-semibold tracking-[var(--lp-tracking-eyebrow)] [text-transform:var(--lp-eyebrow-case)]",
};

export const S = {
  str(v: unknown): string {
    return typeof v === "string" ? v : "";
  },
  arr<T = Record<string, unknown>>(v: unknown): T[] {
    return Array.isArray(v) ? (v as T[]) : [];
  },
  img(v: unknown): ImageValue | null {
    if (!v || typeof v !== "object") return null;
    const i = v as ImageValue;
    return typeof i.assetId === "string" && ASSET_ID_RE.test(i.assetId) ? i : null;
  },
  cta(v: unknown): CtaValue | null {
    return hasCta(v as CtaValue) ? (v as CtaValue) : null;
  },
  num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  },
  payment(v: unknown): PaymentMethod | null {
    return typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v) ? (v as PaymentMethod) : null;
  },
};

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-6xl px-5 sm:px-8", className)}>{children}</div>;
}

export function CtaButton({
  value,
  variant = "primary",
  size = "md",
  className,
  requireLink = false,
  edit,
}: {
  value: CtaValue | null;
  variant?: "primary" | "secondary" | "inverse" | "outline-inverse" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Render nothing (instead of an inert button) when there is no safe link. */
  requireLink?: boolean;
  edit?: EditAttrs;
}) {
  if (!value) return null;
  const target = ctaHref(value.action);
  if (!target && requireLink) return null;
  const cls = cx(
    // min-h-11 = 44px: comfortable touch target at every size.
    "inline-flex min-h-11 items-center justify-center gap-2 text-center font-semibold leading-snug transition-opacity hover:opacity-90 rounded-[var(--lp-radius)]",
    size === "sm" && "px-4 py-2 text-sm",
    size === "md" && "px-6 py-3 text-base",
    size === "lg" && "px-7 py-3.5 text-lg",
    variant === "primary" && "bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)] shadow-sm",
    variant === "secondary" && "border border-current text-[color:var(--lp-primary)] bg-transparent",
    variant === "inverse" && "bg-[var(--lp-on-primary)] text-[color:var(--lp-primary)] shadow-sm",
    variant === "outline-inverse" && "border border-current text-[color:var(--lp-on-primary)] bg-transparent",
    variant === "ghost" && "text-[color:var(--lp-primary)] underline-offset-4 hover:underline",
    className,
  );
  if (!target) {
    // No safe destination (e.g. an unfinished draft): show the button so
    // the layout is honest, but it goes nowhere.
    return (
      <span className={cls} aria-disabled="true" data-cta-unlinked="" {...edit}>
        {value.label}
      </span>
    );
  }
  return (
    <a
      href={target.href}
      className={cls}
      {...edit}
      {...(target.external ? { target: "_blank", rel: "noopener noreferrer nofollow ugc" } : {})}
    >
      {value.label}
    </a>
  );
}

export function RichText({ value, className, edit }: { value: string; className?: string; edit?: EditAttrs }) {
  const blocks = parseRichText(value);
  if (!blocks.length) return null;
  return (
    <div className={cx("space-y-4 leading-[var(--lp-lh-body)]", className)} {...edit}>
      {blocks.map((block, i) =>
        block.type === "paragraph" ? (
          <p key={i}>
            {block.children.map((c, j) => (
              <Inline key={j} {...c} />
            ))}
          </p>
        ) : (
          <ul key={i} className="list-disc space-y-1.5 pl-5">
            {block.items.map((item, j) => (
              <li key={j}>
                {item.map((c, k) => (
                  <Inline key={k} {...c} />
                ))}
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

function Inline({ text, bold, italic }: { text: string; bold?: boolean; italic?: boolean }) {
  if (bold) return <strong className="font-semibold">{text}</strong>;
  if (italic) return <em>{text}</em>;
  return <>{text}</>;
}

export function LandingImage({
  value,
  env,
  className,
  placeholder = "gradient",
  icon = "sparkles",
  edit,
}: {
  value: ImageValue | null;
  env: RenderEnv;
  className?: string;
  placeholder?: "gradient" | "soft" | "none";
  icon?: IconName;
  edit?: EditAttrs;
}) {
  const src = value ? env.assetUrl(value.assetId) : null;
  if (!src) {
    if (placeholder === "none") return null;
    return (
      <div
        {...edit}
        aria-hidden="true"
        className={cx(
          "flex items-center justify-center",
          placeholder === "gradient" && "bg-gradient-to-br from-[var(--lp-primary)] to-[var(--lp-accent)] opacity-90",
          placeholder === "soft" && "bg-[var(--lp-surface)] ring-1 ring-inset ring-black/5",
          className,
        )}
      >
        <Icon
          name={icon}
          className={cx(
            "h-12 w-12",
            placeholder === "gradient" ? "text-[color:var(--lp-on-primary)] opacity-70" : "text-[color:var(--lp-primary)] opacity-40",
          )}
        />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={value?.alt ?? ""} loading="lazy" decoding="async" className={cx("object-cover", className)} {...edit} />;
}

type IconShape = { paths: string[]; circles?: Array<[number, number, number]> };

const ICONS: Record<IconName, IconShape> = {
  check: { paths: ["M5 12l5 5L20 7"] },
  star: { paths: ["M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"] },
  shield: { paths: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "M9 12l2 2 4-4"] },
  truck: { paths: ["M1 3h14v13H1z", "M15 8h4l4 4v4h-8"], circles: [[5.5, 18.5, 2], [18.5, 18.5, 2]] },
  clock: { paths: ["M12 6v6l4 2"], circles: [[12, 12, 10]] },
  heart: { paths: ["M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"] },
  bolt: { paths: ["M13 2L3 14h9l-1 8 10-12h-9z"] },
  phone: {
    paths: [
      "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
    ],
  },
  chat: { paths: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"] },
  gift: { paths: ["M20 12v10H4V12", "M2 7h20v5H2z", "M12 22V7", "M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z", "M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"] },
  leaf: { paths: ["M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z", "M2 21c0-3 1.9-5.4 5.1-6"] },
  award: { paths: ["M15.5 13L17 22l-5-3-5 3 1.5-9"], circles: [[12, 8, 6]] },
  tag: { paths: ["M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"], circles: [[7, 7, 1.5]] },
  "map-pin": { paths: ["M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"], circles: [[12, 10, 3]] },
  sparkles: { paths: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"] },
  wrench: { paths: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"] },
  cart: { paths: ["M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"], circles: [[9, 21, 1], [20, 21, 1]] },
  bag: { paths: ["M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z", "M3 6h18", "M16 10a4 4 0 0 1-8 0"] },
  return: { paths: ["M1 4v6h6", "M3.5 15a9 9 0 1 0 2.1-9.4L1 10"] },
  lock: { paths: ["M5 11h14v11H5z", "M7 11V7a5 5 0 0 1 10 0v4"] },
  cash: { paths: ["M2 6h20v12H2z", "M6 12h.01", "M18 12h.01"], circles: [[12, 12, 2.5]] },
  support: { paths: ["M3 18v-6a9 9 0 0 1 18 0v6", "M21 19a2 2 0 0 1-2 2h-1v-6h3z", "M3 19a2 2 0 0 0 2 2h1v-6H3z"] },
  percent: { paths: ["M19 5L5 19"], circles: [[6.5, 6.5, 2.5], [17.5, 17.5, 2.5]] },
  fire: { paths: ["M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.3 1.6 1.4 2.8 2.5 2.8z"] },
};

/** Renders only icons shipped in this file — never merchant-supplied SVG. */
export function Icon({ name, className }: { name: string; className?: string }) {
  const shape = ICONS[name as IconName] ?? ICONS.check;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {shape.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
      {shape.circles?.map(([cx_, cy, r], i) => (
        <circle key={`c${i}`} cx={cx_} cy={cy} r={r} />
      ))}
    </svg>
  );
}

export function SectionHeading({
  title,
  intro,
  align = "center",
  env,
}: {
  title: string;
  intro?: string;
  align?: "center" | "left";
  /** Pass to make the heading (`heading`) and intro (`intro`) click-to-edit. */
  env?: RenderEnv;
}) {
  if (!title && !intro) return null;
  return (
    <div className={cx("mb-10 max-w-2xl", align === "center" && "mx-auto text-center")}>
      {title ? (
        <h2 className={cx("text-3xl sm:text-4xl", TYPE.heading)} {...(env ? ed(env, "heading") : {})}>
          {title}
        </h2>
      ) : null}
      {intro ? (
        <p className="mt-4 text-lg leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...(env ? ed(env, "intro") : {})}>
          {intro}
        </p>
      ) : null}
    </div>
  );
}

export function Stars({ count, label, edit }: { count: number; label: string; edit?: EditAttrs }) {
  if (!count) return null;
  return (
    <div className="flex gap-0.5 text-[color:var(--lp-accent)]" role="img" aria-label={label} {...edit}>
      {Array.from({ length: 5 }).map((_, i) => (
        <svg key={i} viewBox="0 0 24 24" className="h-4 w-4" fill={i < count ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />
        </svg>
      ))}
    </div>
  );
}

// ── Commerce primitives ─────────────────────────────────────────────────────

export function PriceRow({
  price,
  oldPrice,
  ctx,
  size = "md",
  inverse = false,
  base,
}: {
  price: number | null;
  oldPrice: number | null;
  ctx: Ctx;
  size?: "md" | "lg";
  inverse?: boolean;
  /** Click-to-edit prefix for the `price` / `oldPrice` fields ("" = section level). */
  base?: string;
}) {
  const current = ctx.money(price);
  if (!current) return null;
  const old = oldPrice !== null && price !== null && oldPrice > price ? ctx.money(oldPrice) : null;
  const at = (key: string) => (base === undefined ? {} : ed(ctx.env, ...(base ? [base, key] : [key])));
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span
        {...at("price")}
        className={cx(
          "whitespace-nowrap font-bold",
          size === "lg" ? "text-3xl" : "text-lg",
          inverse ? "text-[color:var(--lp-on-primary)]" : "text-[color:var(--lp-primary)]",
        )}
      >
        {current}
      </span>
      {old ? (
        <span
          {...at("oldPrice")}
          className={cx("whitespace-nowrap line-through", size === "lg" ? "text-lg" : "text-sm", inverse ? "opacity-70" : "text-[color:var(--lp-muted)]")}
        >
          {old}
        </span>
      ) : null}
    </div>
  );
}

export function DiscountBadge({ price, oldPrice, ctx, className }: { price: number | null; oldPrice: number | null; ctx: Ctx; className?: string }) {
  if (price === null) return null;
  const pct = discountPercent(price, oldPrice);
  if (pct === null) return null;
  return (
    <span className={cx("inline-flex items-center whitespace-nowrap rounded-full bg-[var(--lp-accent)] px-2.5 py-1 text-xs font-bold text-black/85", className)}>
      {ctx.t.off(formatPercent(pct, { locale: ctx.locale, numerals: ctx.env.numerals }))}
    </span>
  );
}

export interface ProductValue {
  image?: unknown;
  name?: unknown;
  price?: unknown;
  oldPrice?: unknown;
  badge?: unknown;
  rating?: unknown;
  cta?: unknown;
}

/**
 * Reusable product card — used by product grids (both styles). Fixed image
 * ratio, two-line name slot and a bottom-aligned button keep every card in
 * a row the same height regardless of name length or language.
 */
export function ProductCard({
  product,
  ctx,
  variant = "cards",
  path = "",
  trackKey,
}: {
  product: ProductValue;
  ctx: Ctx;
  variant?: "cards" | "minimal";
  /** Click-to-edit path of this product within its section, e.g. "items.2". */
  path?: string;
  /** Analytics product key ("products-2") — lets the public page attribute clicks. */
  trackKey?: string;
}) {
  const price = S.num(product.price);
  const oldPrice = S.num(product.oldPrice);
  const badge = S.str(product.badge);
  const rating = Number(S.str(product.rating)) || 0;
  const minimal = variant === "minimal";
  const at = (key?: string) => (path ? ed(ctx.env, ...(key ? [path, key] : [path])) : {});
  return (
    <article
      {...at()}
      data-lp-product={trackKey}
      className={cx(
        "flex h-full flex-col overflow-hidden",
        minimal ? "bg-transparent" : "rounded-[var(--lp-radius)] bg-[var(--lp-bg)] shadow-sm ring-1 ring-black/5",
      )}
    >
      <div className="relative">
        <LandingImage
          value={S.img(product.image)}
          env={ctx.env}
          placeholder="soft"
          icon="bag"
          className={cx("aspect-square w-full", minimal && "rounded-[var(--lp-radius)]")}
          edit={at("image")}
        />
        {badge ? (
          <span
            {...at("badge")}
            className="absolute left-2 top-2 rounded-full bg-[var(--lp-primary)] px-2.5 py-1 text-xs font-semibold text-[color:var(--lp-on-primary)]"
          >
            {badge}
          </span>
        ) : null}
        <DiscountBadge price={price} oldPrice={oldPrice} ctx={ctx} className="absolute right-2 top-2" />
      </div>
      <div className={cx("flex flex-1 flex-col gap-2", minimal ? "pt-4" : "p-3 sm:p-4")}>
        <h3 {...at("name")} className={cx("line-clamp-2 min-h-[2lh] font-semibold leading-[var(--lp-lh-snug)]", minimal ? "text-lg" : "text-base")}>
          {S.str(product.name)}
        </h3>
        {rating ? <Stars count={rating} label={ctx.t.stars(rating)} edit={at("rating")} /> : null}
        <PriceRow price={price} oldPrice={oldPrice} ctx={ctx} base={path || undefined} />
        <div className="mt-auto pt-2">
          <CtaButton value={S.cta(product.cta)} size="sm" variant={minimal ? "secondary" : "primary"} className="w-full" edit={at("cta")} />
        </div>
      </div>
    </article>
  );
}

const PAYMENT_DOT: Record<PaymentMethod, string> = {
  cod: "#16a34a",
  bkash: "#e2136e",
  nagad: "#ec1c24",
  rocket: "#8c3494",
  upay: "#0072bc",
  card: "#1e3a8a",
  bank: "#475569",
};

/** Text badge for an accepted payment method (display only, no logos). */
export function PaymentBadge({ method, ctx, inverse = false }: { method: PaymentMethod; ctx: Ctx; inverse?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium",
        inverse ? "bg-white/10 ring-1 ring-white/20" : "bg-[var(--lp-bg)] ring-1 ring-black/10",
      )}
    >
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PAYMENT_DOT[method] }} />
      {ctx.t.payment[method]}
    </span>
  );
}

export { PAYMENT_METHODS };
