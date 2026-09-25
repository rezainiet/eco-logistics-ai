import type { ComponentType } from "react";
import { ctaHref } from "../cta.js";
import { safeUrl } from "../safe.js";
import { SOCIAL_NETWORKS } from "../vocab.js";
import {
  Container,
  CtaButton,
  DiscountBadge,
  Icon,
  LandingImage,
  PaymentBadge,
  PriceRow,
  ProductCard,
  RichText,
  S,
  SectionHeading,
  TYPE,
  ctxOf,
  cx,
  ed,
} from "./primitives.js";
import type { SectionProps } from "./sections.js";

/**
 * E-commerce sections. Presentation only: prices, discounts and payment
 * methods are merchant content; every button is an ordinary CTA link.
 */

const SOCIAL = new Map<string, string>(SOCIAL_NETWORKS.map((n) => [n.value, n.label]));

function Announcement({ values: v, env }: SectionProps) {
  const style = S.str(v.style);
  const href = safeUrl(S.str(v.link));
  const body = (
    <span className="inline-flex items-center justify-center gap-2">
      <Icon name={S.str(v.icon)} className="h-4 w-4 shrink-0" />
      <span {...ed(env, "text")}>{S.str(v.text)}</span>
    </span>
  );
  return (
    <div
      className={cx(
        "px-4 py-2.5 text-center text-sm font-medium leading-[var(--lp-lh-snug)]",
        style === "primary" && "bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]",
        style === "accent" && "bg-[var(--lp-accent)] text-black/85",
        style === "dark" && "bg-neutral-900 text-white",
      )}
    >
      {href ? (
        <a href={href} className="hover:underline" rel="noopener noreferrer nofollow ugc">
          {body}
        </a>
      ) : (
        body
      )}
    </div>
  );
}

function ShopHeader({ values: v, env }: SectionProps) {
  const ctx = ctxOf(env);
  const minimal = S.str(v.style) === "minimal";
  const logo = S.img(v.logo);
  const phone = S.str(v.phone);
  const phoneHref = ctaHref({ kind: "phone", phone })?.href;
  const links = S.arr(v.links)
    .map((l, i) => ({ label: S.str(l.label), href: safeUrl(S.str(l.url)), i }))
    .filter((l) => l.label && l.href);
  const nav = (className: string) =>
    links.length ? (
      <nav className={className}>
        {links.map((l, i) => (
          <a
            key={i}
            href={l.href!}
            className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-1 hover:text-[color:var(--lp-primary)]"
            {...ed(env, "links", l.i)}
          >
            {l.label}
          </a>
        ))}
      </nav>
    ) : null;

  return (
    <header className={cx("w-full bg-[var(--lp-bg)]", minimal ? "border-b border-black/10" : "shadow-sm")}>
      <Container className="flex items-center justify-between gap-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {logo ? <LandingImage value={logo} env={env} className="h-10 w-auto max-w-[140px] object-contain" placeholder="none" edit={ed(env, "logo")} /> : null}
          {S.str(v.brandName) ? (
            <span className={cx("truncate", minimal ? cx("text-xl", TYPE.heading) : "text-xl font-bold text-[color:var(--lp-primary)]")} {...ed(env, "brandName")}>
              {S.str(v.brandName)}
            </span>
          ) : null}
        </div>
        {nav("hidden items-center gap-6 text-[15px] font-medium md:flex")}
        <div className="flex shrink-0 items-center gap-3">
          {phone && phoneHref && !minimal ? (
            <a href={phoneHref} className="hidden min-h-11 items-center gap-2 text-sm font-semibold lg:inline-flex" {...ed(env, "phone")}>
              <Icon name="phone" className="h-4 w-4 text-[color:var(--lp-primary)]" />
              <span className="sr-only">{ctx.t.hotline}</span>
              {phone}
            </a>
          ) : null}
          <CtaButton value={S.cta(v.cta)} size="sm" variant={minimal ? "secondary" : "primary"} edit={ed(env, "cta")} />
        </div>
      </Container>
      {/* Small screens: category links as a swipeable row, no JS menu needed. */}
      {nav("flex gap-5 overflow-x-auto border-t border-black/5 px-5 text-sm font-medium [scrollbar-width:none] md:hidden")}
    </header>
  );
}

function PromoHero({ values: v, env }: SectionProps) {
  const banner = S.str(v.layout) === "banner";
  const badge = S.str(v.badge);
  const note = S.str(v.note);
  const img = S.img(v.image);
  const copy = (inverse: boolean) => (
    <div>
      {badge ? (
        <span className="mb-5 inline-flex items-center gap-2 rounded-full bg-[var(--lp-accent)] px-4 py-1.5 text-sm font-bold text-black/85" {...ed(env, "badge")}>
          <Icon name="fire" className="h-4 w-4" />
          {badge}
        </span>
      ) : null}
      <h1 className={cx("text-4xl sm:text-5xl lg:text-6xl", TYPE.display)} {...ed(env, "headline")}>
        {S.str(v.headline)}
      </h1>
      {S.str(v.subheadline) ? (
        <p
          className={cx("mt-5 text-lg leading-[var(--lp-lh-body)] sm:text-xl", inverse ? "opacity-95" : "text-[color:var(--lp-muted)]")}
          {...ed(env, "subheadline")}
        >
          {S.str(v.subheadline)}
        </p>
      ) : null}
      <div className="mt-8 flex flex-wrap gap-3">
        <CtaButton value={S.cta(v.primaryCta)} size="lg" variant={inverse ? "inverse" : "primary"} edit={ed(env, "primaryCta")} />
        <CtaButton value={S.cta(v.secondaryCta)} size="lg" variant={inverse ? "outline-inverse" : "secondary"} edit={ed(env, "secondaryCta")} />
      </div>
      {note ? (
        <p className={cx("mt-5 flex items-center gap-2 text-sm font-medium", inverse ? "opacity-90" : "text-[color:var(--lp-muted)]")} {...ed(env, "note")}>
          <Icon name="check" className="h-4 w-4 shrink-0" />
          {note}
        </p>
      ) : null}
    </div>
  );

  if (banner) {
    const src = img ? env.assetUrl(img.assetId) : null;
    return (
      <div className="relative isolate overflow-hidden bg-[var(--lp-primary)] text-white" {...ed(env, "image")}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={img?.alt ?? ""} className="absolute inset-0 -z-20 h-full w-full object-cover" />
        ) : null}
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-black/70 via-black/45 to-black/15" />
        <Container className="py-20 md:py-28">
          <div className="max-w-2xl">{copy(true)}</div>
        </Container>
      </div>
    );
  }

  return (
    <div className="bg-[var(--lp-surface)]">
      <Container className="grid items-center gap-10 py-12 md:grid-cols-2 md:py-20">
        {copy(false)}
        <div className="relative">
          <LandingImage
            value={img}
            env={env}
            icon="bag"
            className="aspect-[4/3] w-full rounded-[calc(var(--lp-radius)*1.5)] shadow-xl md:aspect-square"
            edit={ed(env, "image")}
          />
        </div>
      </Container>
    </div>
  );
}

function EditorialHero({ values: v, env }: SectionProps) {
  const eyebrow = S.str(v.eyebrow);
  return (
    <div className="border-b border-black/10">
      <Container className="grid items-center gap-10 py-12 md:grid-cols-12 md:gap-12 md:py-20">
        <div className="md:col-span-5">
          {eyebrow ? (
            <p className={cx("mb-6 text-[color:var(--lp-accent)]", TYPE.eyebrow)} {...ed(env, "eyebrow")}>
              {eyebrow}
            </p>
          ) : null}
          <h1 className={cx("text-4xl sm:text-5xl lg:text-6xl", TYPE.display)} {...ed(env, "headline")}>
            {S.str(v.headline)}
          </h1>
          {S.str(v.subheadline) ? (
            <p className="mt-6 text-lg leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...ed(env, "subheadline")}>
              {S.str(v.subheadline)}
            </p>
          ) : null}
          <div className="mt-10">
            <CtaButton value={S.cta(v.cta)} size="lg" edit={ed(env, "cta")} />
          </div>
        </div>
        <LandingImage
          value={S.img(v.image)}
          env={env}
          placeholder="gradient"
          icon="sparkles"
          className="aspect-[4/5] w-full md:col-span-7 md:aspect-[5/6] md:max-h-[640px]"
          edit={ed(env, "image")}
        />
      </Container>
    </div>
  );
}

function CategoryGrid({ values: v, env }: SectionProps) {
  const tiles = S.str(v.style) === "tiles";
  const items = S.arr(v.items);
  if (tiles) {
    return (
      <Container className="py-16 md:py-20">
        <SectionHeading title={S.str(v.heading)} intro={S.str(v.intro)} align="left" env={env} />
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((c, i) => {
            const href = safeUrl(S.str(c.link));
            const tile = (
              <div className="group relative overflow-hidden" {...ed(env, "items", i)}>
                <LandingImage
                  value={S.img(c.image)}
                  env={env}
                  placeholder="gradient"
                  icon="sparkles"
                  className="aspect-[4/5] w-full"
                  edit={ed(env, "items", i, "image")}
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-6 pt-16 text-white">
                  <span className={cx("text-2xl", TYPE.heading)} {...ed(env, "items", i, "name")}>
                    {S.str(c.name)}
                  </span>
                </div>
              </div>
            );
            return href ? (
              <a key={i} href={href} className="block">
                {tile}
              </a>
            ) : (
              <div key={i}>{tile}</div>
            );
          })}
        </div>
      </Container>
    );
  }
  return (
    <Container className="py-12 md:py-16">
      <SectionHeading title={S.str(v.heading)} intro={S.str(v.intro)} env={env} />
      <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 lg:grid-cols-6">
        {items.map((c, i) => {
          const href = safeUrl(S.str(c.link));
          const img = S.img(c.image);
          const inner = (
            <span className="flex flex-col items-center gap-3 text-center" {...ed(env, "items", i)}>
              <span
                className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-[var(--lp-surface)] ring-1 ring-black/10 sm:h-24 sm:w-24"
                {...ed(env, "items", i, "image")}
              >
                {img ? (
                  <LandingImage value={img} env={env} className="h-full w-full" placeholder="none" />
                ) : (
                  <Icon name="bag" className="h-8 w-8 text-[color:var(--lp-primary)]" />
                )}
              </span>
              <span className="text-sm font-semibold leading-[var(--lp-lh-snug)] sm:text-base" {...ed(env, "items", i, "name")}>
                {S.str(c.name)}
              </span>
            </span>
          );
          return href ? (
            <a key={i} href={href} className="block rounded-[var(--lp-radius)] hover:opacity-90">
              {inner}
            </a>
          ) : (
            <div key={i}>{inner}</div>
          );
        })}
      </div>
    </Container>
  );
}

function ProductGrid({ values: v, env }: SectionProps) {
  const ctx = ctxOf(env);
  const minimal = S.str(v.style) === "minimal";
  const cols = S.str(v.columns);
  return (
    <div className={cx(!minimal && "bg-[var(--lp-surface)]")}>
      <Container className="py-14 md:py-20">
        <SectionHeading title={S.str(v.heading)} intro={S.str(v.intro)} align={minimal ? "left" : "center"} env={env} />
        <div
          className={cx(
            "grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3",
            cols === "4" && "lg:grid-cols-4",
            minimal && "gap-y-10 sm:gap-x-8",
          )}
        >
          {S.arr(v.items).map((p, i) => (
            <ProductCard key={i} product={p} ctx={ctx} variant={minimal ? "minimal" : "cards"} path={`items.${i}`} />
          ))}
        </div>
        <div className="mt-10 flex justify-center">
          <CtaButton value={S.cta(v.viewAll)} variant="secondary" requireLink edit={ed(env, "viewAll")} />
        </div>
      </Container>
    </div>
  );
}

function OfferBanner({ values: v, env }: SectionProps) {
  const ctx = ctxOf(env);
  const editorial = S.str(v.style) === "editorial";
  const price = S.num(v.price);
  const oldPrice = S.num(v.oldPrice);
  const deadline = S.str(v.deadline);
  if (editorial) {
    return (
      <Container className="py-16 md:py-20">
        <div className="grid items-stretch overflow-hidden bg-[var(--lp-surface)] ring-1 ring-black/10 md:grid-cols-2">
          <LandingImage
            value={S.img(v.image)}
            env={env}
            placeholder="gradient"
            icon="sparkles"
            className="aspect-[4/3] w-full md:aspect-auto md:h-full"
            edit={ed(env, "image")}
          />
          <div className="flex flex-col justify-center p-8 md:p-14">
            {S.str(v.badge) ? (
              <p className={cx("mb-4 text-[color:var(--lp-accent)]", TYPE.eyebrow)} {...ed(env, "badge")}>
                {S.str(v.badge)}
              </p>
            ) : null}
            <h2 className={cx("text-3xl sm:text-4xl", TYPE.heading)} {...ed(env, "heading")}>
              {S.str(v.heading)}
            </h2>
            {S.str(v.text) ? (
              <p className="mt-4 text-lg leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...ed(env, "text")}>
                {S.str(v.text)}
              </p>
            ) : null}
            <div className="mt-6">
              <PriceRow price={price} oldPrice={oldPrice} ctx={ctx} size="lg" base="" />
            </div>
            {deadline ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-[color:var(--lp-muted)]" {...ed(env, "deadline")}>
                <Icon name="clock" className="h-4 w-4 shrink-0" />
                {deadline}
              </p>
            ) : null}
            <div className="mt-8">
              <CtaButton value={S.cta(v.cta)} size="lg" edit={ed(env, "cta")} />
            </div>
          </div>
        </div>
      </Container>
    );
  }
  return (
    <Container className="py-12 md:py-16">
      <div
        className="grid items-center gap-8 overflow-hidden rounded-[calc(var(--lp-radius)*1.5)] bg-[var(--lp-primary)] p-6 text-[color:var(--lp-on-primary)] sm:p-10 md:grid-cols-2"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {S.str(v.badge) ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--lp-accent)] px-3 py-1 text-sm font-bold text-black/85" {...ed(env, "badge")}>
                <Icon name="bolt" className="h-4 w-4" />
                {S.str(v.badge)}
              </span>
            ) : null}
            <DiscountBadge price={price} oldPrice={oldPrice} ctx={ctx} className="bg-white text-[color:var(--lp-primary)]" />
          </div>
          <h2 className={cx("mt-5 text-3xl sm:text-4xl", TYPE.heading)} {...ed(env, "heading")}>
            {S.str(v.heading)}
          </h2>
          {S.str(v.text) ? (
            <p className="mt-3 text-lg leading-[var(--lp-lh-body)] opacity-95" {...ed(env, "text")}>
              {S.str(v.text)}
            </p>
          ) : null}
          <div className="mt-6">
            <PriceRow price={price} oldPrice={oldPrice} ctx={ctx} size="lg" inverse base="" />
          </div>
          {deadline ? (
            <p className="mt-3 flex items-center gap-2 text-sm font-medium opacity-90" {...ed(env, "deadline")}>
              <Icon name="clock" className="h-4 w-4 shrink-0" />
              {deadline}
            </p>
          ) : null}
          <div className="mt-7">
            <CtaButton value={S.cta(v.cta)} size="lg" variant="inverse" edit={ed(env, "cta")} />
          </div>
        </div>
        <LandingImage
          value={S.img(v.image)}
          env={env}
          placeholder="soft"
          icon="bag"
          className="aspect-[4/3] w-full rounded-[var(--lp-radius)] md:aspect-square"
          edit={ed(env, "image")}
        />
      </div>
    </Container>
  );
}

function TrustFeatures({ values: v, env }: SectionProps) {
  const cards = S.str(v.style) === "cards";
  const items = S.arr(v.items);
  return (
    <div className={cx(cards ? "" : "border-y border-black/5 bg-[var(--lp-bg)]")}>
      <Container className={cards ? "py-16 md:py-20" : "py-10 md:py-12"}>
        {S.str(v.heading) ? <SectionHeading title={S.str(v.heading)} env={env} /> : null}
        <div className={cx("grid grid-cols-2 gap-4 sm:gap-6", items.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
          {items.map((it, i) => (
            <div
              key={i}
              className={cx(
                "flex flex-col items-center gap-3 text-center sm:flex-row sm:items-start sm:text-left",
                cards && "rounded-[var(--lp-radius)] bg-[var(--lp-surface)] p-5 ring-1 ring-black/5",
              )}
              {...ed(env, "items", i)}
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--lp-surface)] text-[color:var(--lp-primary)] ring-1 ring-black/5">
                <Icon name={S.str(it.icon)} className="h-6 w-6" />
              </span>
              <span className="min-w-0">
                <span className="block font-semibold leading-[var(--lp-lh-snug)]" {...ed(env, "items", i, "title")}>
                  {S.str(it.title)}
                </span>
                {S.str(it.text) ? (
                  <span className="mt-1 block text-sm leading-[var(--lp-lh-snug)] text-[color:var(--lp-muted)]" {...ed(env, "items", i, "text")}>
                    {S.str(it.text)}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </Container>
    </div>
  );
}

function DeliveryInfo({ values: v, env }: SectionProps) {
  const ctx = ctxOf(env);
  const zones = S.arr(v.zones);
  const payments = S.arr(v.payments)
    .map((p) => S.payment(p.method))
    .filter((m): m is NonNullable<typeof m> => m !== null);
  return (
    <Container className="py-16 md:py-20">
      <div className="grid gap-10 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 className={cx("text-3xl", TYPE.heading)} {...ed(env, "heading")}>
            {S.str(v.heading)}
          </h2>
          {S.str(v.intro) ? (
            <p className="mt-4 text-lg leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...ed(env, "intro")}>
              {S.str(v.intro)}
            </p>
          ) : null}
          {payments.length ? (
            <div className="mt-8">
              <p className="mb-3 font-semibold" {...ed(env, "paymentHeading")}>
                {S.str(v.paymentHeading)}
              </p>
              <div className="flex flex-wrap gap-2" {...ed(env, "payments")}>
                {[...new Set(payments)].map((m) => (
                  <PaymentBadge key={m} method={m} ctx={ctx} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="lg:col-span-3">
          <div className="overflow-hidden rounded-[var(--lp-radius)] ring-1 ring-black/10">
            {zones.map((z, i) => {
              const charge = S.num(z.charge);
              return (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-b border-black/5 bg-[var(--lp-bg)] p-4 last:border-b-0 sm:grid-cols-[1.4fr_1fr_auto] sm:p-5"
                  {...ed(env, "zones", i)}
                >
                  <span className="flex items-center gap-2 font-semibold" {...ed(env, "zones", i, "area")}>
                    <Icon name="map-pin" className="h-4 w-4 shrink-0 text-[color:var(--lp-primary)]" />
                    {S.str(z.area)}
                  </span>
                  <span
                    className="col-start-1 row-start-2 flex items-center gap-2 text-sm text-[color:var(--lp-muted)] sm:col-start-2 sm:row-start-1"
                    {...ed(env, "zones", i, "time")}
                  >
                    <Icon name="clock" className="h-4 w-4 shrink-0" />
                    {S.str(z.time)}
                  </span>
                  <span className="row-span-2 whitespace-nowrap text-right font-bold text-[color:var(--lp-primary)] sm:row-span-1" {...ed(env, "zones", i, "charge")}>
                    {charge === 0 ? ctx.t.free : ctx.money(charge)}
                  </span>
                </div>
              );
            })}
          </div>
          {S.str(v.note) ? <RichText value={S.str(v.note)} className="mt-4 text-sm text-[color:var(--lp-muted)]" edit={ed(env, "note")} /> : null}
        </div>
      </div>
    </Container>
  );
}

function ShopFooter({ values: v, env }: SectionProps) {
  const ctx = ctxOf(env);
  const phone = S.str(v.phone);
  const email = S.str(v.email);
  const links = S.arr(v.links);
  const socials = S.arr(v.socials);
  const payments = [
    ...new Set(
      S.arr(v.payments)
        .map((p) => S.payment(p.method))
        .filter((m): m is NonNullable<typeof m> => m !== null),
    ),
  ];
  return (
    <footer className="bg-[var(--lp-text)] text-[color:var(--lp-bg)]">
      <Container className="grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <p className={cx("text-2xl", TYPE.heading)} {...ed(env, "brandName")}>
            {S.str(v.brandName)}
          </p>
          {S.str(v.tagline) ? (
            <p className="mt-2 max-w-md leading-[var(--lp-lh-body)] opacity-80" {...ed(env, "tagline")}>
              {S.str(v.tagline)}
            </p>
          ) : null}
          {payments.length ? (
            <div className="mt-6 flex flex-wrap gap-2" {...ed(env, "payments")}>
              {payments.map((m) => (
                <PaymentBadge key={m} method={m} ctx={ctx} inverse />
              ))}
            </div>
          ) : null}
        </div>
        <div className="space-y-2 text-sm">
          <p className="mb-3 font-semibold uppercase tracking-[var(--lp-tracking-eyebrow)] opacity-70">{ctx.t.contact}</p>
          {phone ? (
            <a href={ctaHref({ kind: "phone", phone })?.href ?? undefined} className="flex min-h-11 items-center gap-2 hover:underline" {...ed(env, "phone")}>
              <Icon name="phone" className="h-4 w-4 shrink-0" />
              {phone}
            </a>
          ) : null}
          {email ? (
            <a
              href={ctaHref({ kind: "email", email })?.href ?? undefined}
              className="flex min-h-11 items-center gap-2 break-all hover:underline"
              {...ed(env, "email")}
            >
              <Icon name="chat" className="h-4 w-4 shrink-0" />
              {email}
            </a>
          ) : null}
          {S.str(v.address) ? (
            <p className="flex gap-2 whitespace-pre-line leading-[var(--lp-lh-body)] opacity-90" {...ed(env, "address")}>
              <Icon name="map-pin" className="mt-1 h-4 w-4 shrink-0" />
              {S.str(v.address)}
            </p>
          ) : null}
        </div>
        <div className="space-y-2 text-sm">
          {links.length ? <p className="mb-3 font-semibold uppercase tracking-[var(--lp-tracking-eyebrow)] opacity-70">{ctx.t.links}</p> : null}
          {links.map((l, i) => {
            const href = safeUrl(S.str(l.url));
            return href ? (
              <a key={i} href={href} rel="noopener noreferrer nofollow ugc" className="flex min-h-11 items-center hover:underline" {...ed(env, "links", i)}>
                {S.str(l.label)}
              </a>
            ) : null;
          })}
          {socials.length ? (
            <div className="flex flex-wrap gap-2 pt-2">
              {socials.map((s, i) => {
                const href = safeUrl(S.str(s.url));
                return href ? (
                  <a
                    key={i}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer nofollow ugc"
                    className="inline-flex min-h-11 items-center rounded-full px-4 font-medium ring-1 ring-white/25 hover:bg-white/10"
                    {...ed(env, "socials", i)}
                  >
                    {SOCIAL.get(S.str(s.network)) ?? "Link"}
                  </a>
                ) : null;
              })}
            </div>
          ) : null}
        </div>
      </Container>
      {S.str(v.copyright) ? (
        <div className="border-t border-white/10">
          <Container className="py-5 text-sm opacity-70">
            <span {...ed(env, "copyright")}>{S.str(v.copyright)}</span>
          </Container>
        </div>
      ) : null}
    </footer>
  );
}

export const COMMERCE_COMPONENTS: Readonly<Record<string, ComponentType<SectionProps>>> = {
  "announcement@1": Announcement,
  "shopHeader@1": ShopHeader,
  "promoHero@1": PromoHero,
  "editorialHero@1": EditorialHero,
  "categoryGrid@1": CategoryGrid,
  "productGrid@1": ProductGrid,
  "offerBanner@1": OfferBanner,
  "trustFeatures@1": TrustFeatures,
  "deliveryInfo@1": DeliveryInfo,
  "shopFooter@1": ShopFooter,
};
