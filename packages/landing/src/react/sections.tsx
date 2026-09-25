import type { ComponentType } from "react";
import { ctaHref } from "../cta.js";
import { safeUrl } from "../safe.js";
import type { SectionContent } from "../spec.js";
import { SOCIAL_NETWORKS } from "../vocab.js";
import {
  Container,
  CtaButton,
  Icon,
  LandingImage,
  type RenderEnv,
  RichText,
  S,
  SectionHeading,
  Stars,
  TYPE,
  ctxOf,
  cx,
  ed,
  type EditAttrs,
} from "./primitives.js";
import { COMMERCE_COMPONENTS } from "./sections-commerce.js";

export interface SectionProps {
  id: string;
  values: SectionContent;
  env: RenderEnv;
}

function Header({ values: v, env }: SectionProps) {
  const style = S.str(v.style);
  const logo = S.img(v.logo);
  return (
    <header
      className={cx(
        "w-full",
        style === "solid" && "bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]",
        style === "light" && "border-b border-black/5 bg-[var(--lp-bg)]",
        style === "transparent" && "bg-transparent",
      )}
    >
      <Container className="flex items-center justify-between gap-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {logo ? <LandingImage value={logo} env={env} className="h-9 w-auto max-w-[140px] object-contain" placeholder="none" edit={ed(env, "logo")} /> : null}
          {S.str(v.brandName) ? (
            <span className="truncate text-lg font-bold" {...ed(env, "brandName")}>
              {S.str(v.brandName)}
            </span>
          ) : null}
        </div>
        <CtaButton value={S.cta(v.cta)} size="sm" variant={style === "solid" ? "inverse" : "primary"} className="shrink-0" edit={ed(env, "cta")} />
      </Container>
    </header>
  );
}

function Badges({ items, inverse, center, env }: { items: Array<Record<string, unknown>>; inverse?: boolean; center?: boolean; env: RenderEnv }) {
  if (!items.length) return null;
  return (
    <ul className={cx("mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm font-medium", center && "justify-center")}>
      {items.map((b, i) => (
        <li key={i} className={cx("flex items-center gap-2", !inverse && "text-[color:var(--lp-muted)]")} {...ed(env, "badges", i)}>
          <Icon name={S.str(b.icon)} className={cx("h-4 w-4 shrink-0", !inverse && "text-[color:var(--lp-primary)]")} />
          {S.str(b.text)}
        </li>
      ))}
    </ul>
  );
}

function Hero({ values: v, env }: SectionProps) {
  const variant = S.str(v.variant);
  const eyebrow = S.str(v.eyebrow);
  const sub = S.str(v.subheadline);
  const badges = S.arr(v.badges);
  const buttons = (inverse?: boolean) => (
    <div className={cx("mt-8 flex flex-wrap gap-3", variant === "centered" && "justify-center")}>
      <CtaButton value={S.cta(v.primaryCta)} size="lg" variant={inverse ? "inverse" : "primary"} edit={ed(env, "primaryCta")} />
      <CtaButton value={S.cta(v.secondaryCta)} size="lg" variant={inverse ? "outline-inverse" : "secondary"} edit={ed(env, "secondaryCta")} />
    </div>
  );
  const E = (key: string) => ed(env, key);

  if (variant === "split") {
    return (
      <Container className="grid items-center gap-10 py-14 md:grid-cols-2 md:py-24">
        <div>
          {eyebrow ? (
            <p className={cx("mb-4 text-[color:var(--lp-primary)]", TYPE.eyebrow)} {...E("eyebrow")}>
              {eyebrow}
            </p>
          ) : null}
          <h1 className={cx("text-4xl sm:text-5xl", TYPE.display)} {...E("headline")}>
            {S.str(v.headline)}
          </h1>
          {sub ? (
            <p className="mt-6 text-lg leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...E("subheadline")}>
              {sub}
            </p>
          ) : null}
          {buttons()}
          <Badges items={badges} env={env} />
        </div>
        <LandingImage value={S.img(v.image)} env={env} className="aspect-[4/3] w-full rounded-[var(--lp-radius)] shadow-xl md:aspect-[4/5]" edit={E("image")} />
      </Container>
    );
  }

  if (variant === "banner") {
    const img = S.img(v.image);
    const src = img ? env.assetUrl(img.assetId) : null;
    return (
      <div className="relative isolate overflow-hidden bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]" {...E("image")}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={img?.alt ?? ""} className="absolute inset-0 -z-20 h-full w-full object-cover" />
        ) : (
          <div aria-hidden="true" className="absolute inset-0 -z-20 bg-gradient-to-br from-[var(--lp-primary)] via-[var(--lp-primary)] to-[var(--lp-accent)]" />
        )}
        {/* Contrast scrim: keeps white copy legible over any photo or gradient. */}
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-black/65 via-black/45 to-black/20" />
        <Container className="py-20 md:py-32">
          <div className="max-w-2xl">
            {eyebrow ? (
              <p className={cx("mb-4 inline-block bg-[var(--lp-accent)] px-3 py-1 text-xs text-black/85", TYPE.eyebrow)} {...E("eyebrow")}>
                {eyebrow}
              </p>
            ) : null}
            <h1 className={cx("text-4xl sm:text-6xl", TYPE.display)} {...E("headline")}>
              {S.str(v.headline)}
            </h1>
            {sub ? (
              <p className="mt-6 text-lg leading-[var(--lp-lh-body)] opacity-95 sm:text-xl" {...E("subheadline")}>
                {sub}
              </p>
            ) : null}
            {buttons(true)}
            <Badges items={badges} inverse env={env} />
          </div>
        </Container>
      </div>
    );
  }

  // centered
  return (
    <div className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-40 -z-0 h-[480px] bg-gradient-to-b from-[var(--lp-surface)] to-transparent" />
      <Container className="relative py-16 text-center md:py-28">
        {eyebrow ? (
          <p
            className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full bg-[var(--lp-surface)] px-4 py-1.5 text-sm font-semibold text-[color:var(--lp-primary)] ring-1 ring-black/5"
            {...E("eyebrow")}
          >
            <Icon name="sparkles" className="h-4 w-4" />
            {eyebrow}
          </p>
        ) : null}
        <h1 className={cx("mx-auto max-w-4xl text-4xl sm:text-6xl", TYPE.display)} {...E("headline")}>
          {S.str(v.headline)}
        </h1>
        {sub ? (
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)] sm:text-xl" {...E("subheadline")}>
            {sub}
          </p>
        ) : null}
        {buttons()}
        <Badges items={badges} center env={env} />
        {S.img(v.image) ? (
          <LandingImage
            value={S.img(v.image)}
            env={env}
            className="mx-auto mt-14 aspect-[16/9] w-full max-w-4xl rounded-[var(--lp-radius)] shadow-2xl"
            edit={E("image")}
          />
        ) : null}
      </Container>
    </div>
  );
}

function Features({ values: v, env }: SectionProps) {
  const cols = S.str(v.columns);
  const cards = S.str(v.style) !== "minimal";
  return (
    <Container className="py-16 md:py-20">
      <SectionHeading title={S.str(v.heading)} intro={S.str(v.intro)} env={env} />
      <div className={cx("grid gap-6 sm:grid-cols-2", cols === "3" && "lg:grid-cols-3", cols === "4" && "lg:grid-cols-4")}>
        {S.arr(v.items).map((item, i) => (
          <div key={i} className={cx(cards ? "rounded-[var(--lp-radius)] bg-[var(--lp-surface)] p-6 ring-1 ring-black/5" : "p-2")} {...ed(env, "items", i)}>
            <span className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-[var(--lp-radius)] bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]">
              <Icon name={S.str(item.icon)} className="h-5 w-5" />
            </span>
            <h3 className={cx("text-lg", TYPE.heading)} {...ed(env, "items", i, "title")}>
              {S.str(item.title)}
            </h3>
            {S.str(item.text) ? (
              <p className="mt-2 leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...ed(env, "items", i, "text")}>
                {S.str(item.text)}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </Container>
  );
}

function Benefits({ values: v, env }: SectionProps) {
  const imageLeft = S.str(v.imageSide) === "left";
  return (
    <div className="bg-[var(--lp-surface)]">
      <Container className="grid items-center gap-10 py-16 md:grid-cols-2 md:gap-12 md:py-20">
        <LandingImage
          value={S.img(v.image)}
          env={env}
          className={cx("aspect-[4/3] w-full rounded-[var(--lp-radius)] md:aspect-square", imageLeft ? "md:order-first" : "md:order-last")}
          edit={ed(env, "image")}
        />
        <div>
          <h2 className={cx("text-3xl sm:text-4xl", TYPE.heading)} {...ed(env, "heading")}>
            {S.str(v.heading)}
          </h2>
          {S.str(v.body) ? <RichText value={S.str(v.body)} className="mt-5 text-lg text-[color:var(--lp-muted)]" edit={ed(env, "body")} /> : null}
          <ul className="mt-8 space-y-4">
            {S.arr(v.items).map((item, i) => (
              <li key={i} className="flex gap-3" {...ed(env, "items", i)}>
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]">
                  <Icon name="check" className="h-3.5 w-3.5" />
                </span>
                <span>
                  <span className="font-semibold" {...ed(env, "items", i, "title")}>
                    {S.str(item.title)}
                  </span>
                  {S.str(item.text) ? (
                    <span className="block text-[color:var(--lp-muted)]" {...ed(env, "items", i, "text")}>
                      {S.str(item.text)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-8">
            <CtaButton value={S.cta(v.cta)} edit={ed(env, "cta")} />
          </div>
        </div>
      </Container>
    </div>
  );
}

function Testimonials({ values: v, env }: SectionProps) {
  const ctx = ctxOf(env);
  return (
    <Container className="py-16 md:py-20">
      <SectionHeading title={S.str(v.heading)} env={env} />
      <div className="grid gap-6 md:grid-cols-3">
        {S.arr(v.items).map((t, i) => {
          const avatar = S.img(t.avatar);
          const name = S.str(t.name);
          const rating = Number(S.str(t.rating)) || 0;
          return (
            <figure key={i} className="flex flex-col rounded-[var(--lp-radius)] bg-[var(--lp-surface)] p-6 shadow-sm ring-1 ring-black/5" {...ed(env, "items", i)}>
              <Stars count={rating} label={ctx.t.stars(rating)} edit={ed(env, "items", i, "rating")} />
              <blockquote className="mt-4 flex-1 text-lg leading-[var(--lp-lh-body)]" {...ed(env, "items", i, "quote")}>
                “{S.str(t.quote)}”
              </blockquote>
              <figcaption className="mt-6 flex items-center gap-3">
                {avatar ? (
                  <LandingImage value={avatar} env={env} className="h-10 w-10 rounded-full" placeholder="none" edit={ed(env, "items", i, "avatar")} />
                ) : (
                  <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]">
                    <Icon name="heart" className="h-4 w-4" />
                  </span>
                )}
                <span>
                  <span className="block font-semibold" {...ed(env, "items", i, "name")}>
                    {name}
                  </span>
                  {S.str(t.role) ? (
                    <span className="block text-sm text-[color:var(--lp-muted)]" {...ed(env, "items", i, "role")}>
                      {S.str(t.role)}
                    </span>
                  ) : null}
                </span>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </Container>
  );
}

function Services({ values: v, env }: SectionProps) {
  const items = S.arr(v.items);
  // If any card has a photo, give photo-less cards a matching placeholder so
  // every card in the row has the same structure and height.
  const anyImage = items.some((s) => S.img(s.image));
  return (
    <div className="bg-[var(--lp-surface)]">
      <Container className="py-16 md:py-20">
        <SectionHeading title={S.str(v.heading)} intro={S.str(v.intro)} align="left" env={env} />
        <div className="grid gap-6 sm:grid-cols-2 md:grid-cols-3">
          {items.map((s, i) => (
            <article key={i} className="flex flex-col overflow-hidden rounded-[var(--lp-radius)] bg-[var(--lp-bg)] shadow-sm ring-1 ring-black/5" {...ed(env, "items", i)}>
              {anyImage ? (
                <LandingImage value={S.img(s.image)} env={env} placeholder="soft" icon="wrench" className="aspect-[16/10] w-full" edit={ed(env, "items", i, "image")} />
              ) : (
                <div className="h-1.5 bg-[var(--lp-primary)]" />
              )}
              <div className="flex flex-1 flex-col p-6">
                <h3 className={cx("text-xl", TYPE.heading)} {...ed(env, "items", i, "title")}>
                  {S.str(s.title)}
                </h3>
                {S.str(s.text) ? (
                  <p className="mt-2 flex-1 leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...ed(env, "items", i, "text")}>
                    {S.str(s.text)}
                  </p>
                ) : null}
                {S.str(s.price) ? (
                  <p className="mt-4 text-lg font-bold text-[color:var(--lp-primary)]" {...ed(env, "items", i, "price")}>
                    {S.str(s.price)}
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </Container>
    </div>
  );
}

function About({ values: v, env }: SectionProps) {
  const stats = S.arr(v.stats);
  const img = S.img(v.image);
  return (
    <Container className={cx("grid gap-12 py-16 md:py-20", img && "md:grid-cols-2 md:items-center")}>
      <div className={cx(!img && "max-w-3xl")}>
        <h2 className={cx("text-3xl sm:text-4xl", TYPE.heading)} {...ed(env, "heading")}>
          {S.str(v.heading)}
        </h2>
        {S.str(v.body) ? <RichText value={S.str(v.body)} className="mt-5 text-lg text-[color:var(--lp-muted)]" edit={ed(env, "body")} /> : null}
        {stats.length ? (
          <dl className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-3">
            {stats.map((s, i) => (
              <div key={i} className="border-l-4 border-[color:var(--lp-accent)] pl-4" {...ed(env, "stats", i)}>
                <dt className="text-sm text-[color:var(--lp-muted)]">{S.str(s.label)}</dt>
                <dd className="text-3xl font-bold text-[color:var(--lp-primary)]">{S.str(s.value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      {img ? <LandingImage value={img} env={env} className="aspect-[4/3] w-full rounded-[var(--lp-radius)]" edit={ed(env, "image")} /> : null}
    </Container>
  );
}

function Faq({ values: v, env }: SectionProps) {
  return (
    <Container className="max-w-3xl py-16 md:py-20">
      <SectionHeading title={S.str(v.heading)} env={env} />
      <div className="divide-y divide-black/10 rounded-[var(--lp-radius)] bg-[var(--lp-surface)] ring-1 ring-black/5">
        {S.arr(v.items).map((q, i) => (
          <details key={i} className="group p-5 sm:p-6" open={i === 0} {...ed(env, "items", i)}>
            <summary
              className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold"
              {...ed(env, "items", i, "question")}
            >
              {S.str(q.question)}
              <span aria-hidden="true" className="text-[color:var(--lp-primary)] transition-transform group-open:rotate-45">+</span>
            </summary>
            <RichText value={S.str(q.answer)} className="mt-3 text-[color:var(--lp-muted)]" edit={ed(env, "items", i, "answer")} />
          </details>
        ))}
      </div>
    </Container>
  );
}

function ContactRow({
  icon,
  label,
  children,
  href,
  edit,
}: {
  icon: string;
  label: string;
  children: string;
  href?: string | null;
  edit?: EditAttrs;
}) {
  if (!children) return null;
  return (
    <div className="flex gap-4" {...edit}>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--lp-radius)] bg-[var(--lp-surface)] text-[color:var(--lp-primary)]">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-[color:var(--lp-muted)]">{label}</p>
        {href ? (
          <a href={href} className="inline-flex min-h-11 items-center whitespace-pre-line break-words font-semibold hover:underline">
            {children}
          </a>
        ) : (
          <p className="whitespace-pre-line break-words font-semibold leading-[var(--lp-lh-body)]">{children}</p>
        )}
      </div>
    </div>
  );
}

function Contact({ values: v, env }: SectionProps) {
  const { t } = ctxOf(env);
  const phone = S.str(v.phone);
  const wa = S.str(v.whatsapp);
  const email = S.str(v.email);
  return (
    <Container className="py-16 md:py-20">
      <div className="grid gap-10 rounded-[var(--lp-radius)] p-6 ring-1 ring-black/10 sm:p-8 lg:grid-cols-2 lg:p-12">
        <div>
          <h2 className={cx("text-3xl", TYPE.heading)} {...ed(env, "heading")}>
            {S.str(v.heading)}
          </h2>
          {S.str(v.text) ? (
            <p className="mt-4 text-lg leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...ed(env, "text")}>
              {S.str(v.text)}
            </p>
          ) : null}
          <div className="mt-8">
            <CtaButton value={S.cta(v.cta)} size="lg" edit={ed(env, "cta")} />
          </div>
        </div>
        <div className="space-y-5">
          <ContactRow icon="phone" label={t.phone} href={ctaHref({ kind: "phone", phone })?.href} edit={ed(env, "phone")}>
            {phone}
          </ContactRow>
          <ContactRow icon="chat" label={t.whatsapp} href={ctaHref({ kind: "whatsapp", phone: wa })?.href} edit={ed(env, "whatsapp")}>
            {wa}
          </ContactRow>
          <ContactRow icon="chat" label={t.email} href={ctaHref({ kind: "email", email })?.href} edit={ed(env, "email")}>
            {email}
          </ContactRow>
          <ContactRow icon="map-pin" label={t.address} edit={ed(env, "address")}>
            {S.str(v.address)}
          </ContactRow>
          <ContactRow icon="clock" label={t.hours} edit={ed(env, "hours")}>
            {S.str(v.hours)}
          </ContactRow>
        </div>
      </div>
    </Container>
  );
}

function Cta({ values: v, env }: SectionProps) {
  if (S.str(v.style) === "card") {
    return (
      <Container className="py-16 md:py-20">
        <div className="mx-auto max-w-3xl rounded-[var(--lp-radius)] bg-[var(--lp-surface)] p-8 text-center shadow-lg ring-1 ring-black/5 md:p-14">
          <h2 className={cx("text-3xl sm:text-4xl", TYPE.heading)} {...ed(env, "heading")}>
            {S.str(v.heading)}
          </h2>
          {S.str(v.text) ? (
            <p className="mx-auto mt-4 max-w-xl text-lg leading-[var(--lp-lh-body)] text-[color:var(--lp-muted)]" {...ed(env, "text")}>
              {S.str(v.text)}
            </p>
          ) : null}
          <div className="mt-8">
            <CtaButton value={S.cta(v.cta)} size="lg" edit={ed(env, "cta")} />
          </div>
        </div>
      </Container>
    );
  }
  return (
    <div className="bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]">
      <Container className="flex flex-col items-center gap-6 py-14 text-center lg:flex-row lg:justify-between lg:text-left">
        <div className="max-w-2xl">
          <h2 className={cx("text-3xl", TYPE.heading)} {...ed(env, "heading")}>
            {S.str(v.heading)}
          </h2>
          {S.str(v.text) ? (
            <p className="mt-2 text-lg leading-[var(--lp-lh-body)] opacity-90" {...ed(env, "text")}>
              {S.str(v.text)}
            </p>
          ) : null}
        </div>
        <CtaButton value={S.cta(v.cta)} size="lg" variant="inverse" className="shrink-0" edit={ed(env, "cta")} />
      </Container>
    </div>
  );
}

export const SOCIAL_LABEL = new Map<string, string>(SOCIAL_NETWORKS.map((n) => [n.value, n.label]));

function Footer({ values: v, env }: SectionProps) {
  const links = S.arr(v.links);
  const socials = S.arr(v.socials);
  return (
    <footer className="border-t border-black/10 bg-[var(--lp-surface)]">
      <Container className="flex flex-col gap-8 py-12 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-lg font-bold" {...ed(env, "brandName")}>
            {S.str(v.brandName)}
          </p>
          {S.str(v.tagline) ? (
            <p className="mt-1 text-[color:var(--lp-muted)]" {...ed(env, "tagline")}>
              {S.str(v.tagline)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-4 text-sm md:items-end">
          {links.length ? (
            <nav className="flex flex-wrap gap-x-5 gap-y-1">
              {links.map((l, i) => {
                const href = safeUrl(S.str(l.url));
                return href ? (
                  <a key={i} href={href} rel="noopener noreferrer nofollow ugc" className="inline-flex min-h-11 items-center hover:underline" {...ed(env, "links", i)}>
                    {S.str(l.label)}
                  </a>
                ) : null;
              })}
            </nav>
          ) : null}
          {socials.length ? (
            <div className="flex flex-wrap gap-2">
              {socials.map((s, i) => {
                const href = safeUrl(S.str(s.url));
                return href ? (
                  <a
                    key={i}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer nofollow ugc"
                    className="inline-flex min-h-11 items-center rounded-full px-4 font-medium ring-1 ring-black/15 hover:bg-black/5"
                    {...ed(env, "socials", i)}
                  >
                    {SOCIAL_LABEL.get(S.str(s.network)) ?? "Link"}
                  </a>
                ) : null;
              })}
            </div>
          ) : null}
          {S.str(v.copyright) ? (
            <p className="text-[color:var(--lp-muted)]" {...ed(env, "copyright")}>
              {S.str(v.copyright)}
            </p>
          ) : null}
        </div>
      </Container>
    </footer>
  );
}

/** type@version → component. Must cover every visual section in SECTION_TYPES. */
export const SECTION_COMPONENTS: Readonly<Record<string, ComponentType<SectionProps>>> = {
  "header@1": Header,
  "hero@1": Hero,
  "features@1": Features,
  "benefits@1": Benefits,
  "testimonials@1": Testimonials,
  "services@1": Services,
  "about@1": About,
  "faq@1": Faq,
  "contact@1": Contact,
  "cta@1": Cta,
  "footer@1": Footer,
  ...COMMERCE_COMPONENTS,
};
