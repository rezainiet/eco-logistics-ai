import type { ComponentType } from "react";
import { SOCIAL_NETWORKS } from "../sections.js";
import { safeUrl } from "../safe.js";
import { ctaHref } from "../cta.js";
import type { SectionContent } from "../spec.js";
import {
  Container,
  CtaButton,
  Icon,
  LandingImage,
  type RenderEnv,
  RichText,
  S,
  SectionHeading,
  cx,
} from "./primitives.js";

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
      <Container className="flex items-center justify-between gap-4 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {logo ? <LandingImage value={logo} env={env} className="h-9 w-auto max-w-[140px] object-contain" placeholder="none" /> : null}
          {S.str(v.brandName) ? <span className="truncate text-lg font-bold tracking-tight">{S.str(v.brandName)}</span> : null}
        </div>
        <CtaButton value={S.cta(v.cta)} size="sm" variant={style === "solid" ? "inverse" : "primary"} />
      </Container>
    </header>
  );
}

function Badges({ items, inverse }: { items: Array<Record<string, unknown>>; inverse?: boolean }) {
  if (!items.length) return null;
  return (
    <ul className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm font-medium">
      {items.map((b, i) => (
        <li key={i} className={cx("flex items-center gap-2", !inverse && "text-[color:var(--lp-muted)]")}>
          <Icon name={S.str(b.icon)} className={cx("h-4 w-4", !inverse && "text-[color:var(--lp-primary)]")} />
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
      <CtaButton value={S.cta(v.primaryCta)} size="lg" variant={inverse ? "inverse" : "primary"} />
      <CtaButton value={S.cta(v.secondaryCta)} size="lg" variant={inverse ? "outline-inverse" : "secondary"} />
    </div>
  );

  if (variant === "split") {
    return (
      <Container className="grid items-center gap-10 py-16 md:grid-cols-2 md:py-24">
        <div>
          {eyebrow ? <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-[color:var(--lp-primary)]">{eyebrow}</p> : null}
          <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">{S.str(v.headline)}</h1>
          {sub ? <p className="mt-6 text-lg text-[color:var(--lp-muted)]">{sub}</p> : null}
          {buttons()}
          <Badges items={badges} />
        </div>
        <LandingImage value={S.img(v.image)} env={env} className="aspect-[4/5] w-full rounded-[var(--lp-radius)] shadow-xl" />
      </Container>
    );
  }

  if (variant === "banner") {
    const img = S.img(v.image);
    const src = img ? env.assetUrl(img.assetId) : null;
    return (
      <div className="relative isolate overflow-hidden bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={img?.alt ?? ""} className="absolute inset-0 -z-10 h-full w-full object-cover opacity-30" />
        ) : (
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-br from-[var(--lp-primary)] via-[var(--lp-primary)] to-[var(--lp-accent)] opacity-90" />
        )}
        <Container className="py-24 md:py-32">
          <div className="max-w-2xl">
            {eyebrow ? (
              <p className="mb-4 inline-block bg-[var(--lp-accent)] px-3 py-1 text-xs font-bold uppercase tracking-widest text-black/80">{eyebrow}</p>
            ) : null}
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">{S.str(v.headline)}</h1>
            {sub ? <p className="mt-6 text-lg opacity-90 sm:text-xl">{sub}</p> : null}
            {buttons(true)}
            <Badges items={badges} inverse />
          </div>
        </Container>
      </div>
    );
  }

  // centered
  return (
    <div className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-40 -z-0 h-[480px] bg-gradient-to-b from-[var(--lp-surface)] to-transparent" />
      <Container className="relative py-20 text-center md:py-28">
        {eyebrow ? (
          <p className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full bg-[var(--lp-surface)] px-4 py-1.5 text-sm font-semibold text-[color:var(--lp-primary)] ring-1 ring-black/5">
            <Icon name="sparkles" className="h-4 w-4" />
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mx-auto max-w-4xl text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">{S.str(v.headline)}</h1>
        {sub ? <p className="mx-auto mt-6 max-w-2xl text-lg text-[color:var(--lp-muted)] sm:text-xl">{sub}</p> : null}
        {buttons()}
        <div className="flex justify-center">
          <Badges items={badges} />
        </div>
        {S.img(v.image) ? (
          <LandingImage value={S.img(v.image)} env={env} className="mx-auto mt-14 aspect-[16/9] w-full max-w-4xl rounded-[var(--lp-radius)] shadow-2xl" />
        ) : null}
      </Container>
    </div>
  );
}

function Features({ values: v }: SectionProps) {
  const cols = S.str(v.columns);
  const cards = S.str(v.style) !== "minimal";
  return (
    <Container className="py-20">
      <SectionHeading title={S.str(v.heading)} intro={S.str(v.intro)} />
      <div className={cx("grid gap-6 sm:grid-cols-2", cols === "3" && "lg:grid-cols-3", cols === "4" && "lg:grid-cols-4")}>
        {S.arr(v.items).map((item, i) => (
          <div
            key={i}
            className={cx(cards ? "rounded-[var(--lp-radius)] bg-[var(--lp-surface)] p-6 ring-1 ring-black/5" : "p-2")}
          >
            <span className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-[var(--lp-radius)] bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]">
              <Icon name={S.str(item.icon)} className="h-5 w-5" />
            </span>
            <h3 className="text-lg font-semibold">{S.str(item.title)}</h3>
            {S.str(item.text) ? <p className="mt-2 text-[color:var(--lp-muted)]">{S.str(item.text)}</p> : null}
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
      <Container className="grid items-center gap-12 py-20 md:grid-cols-2">
        <LandingImage
          value={S.img(v.image)}
          env={env}
          className={cx("aspect-square w-full rounded-[var(--lp-radius)]", imageLeft ? "md:order-first" : "md:order-last")}
        />
        <div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{S.str(v.heading)}</h2>
          {S.str(v.body) ? <RichText value={S.str(v.body)} className="mt-5 text-lg text-[color:var(--lp-muted)]" /> : null}
          <ul className="mt-8 space-y-4">
            {S.arr(v.items).map((item, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]">
                  <Icon name="check" className="h-3.5 w-3.5" />
                </span>
                <span>
                  <span className="font-semibold">{S.str(item.title)}</span>
                  {S.str(item.text) ? <span className="block text-[color:var(--lp-muted)]">{S.str(item.text)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-8">
            <CtaButton value={S.cta(v.cta)} />
          </div>
        </div>
      </Container>
    </div>
  );
}

function Stars({ count }: { count: number }) {
  if (!count) return null;
  return (
    <div className="flex gap-0.5 text-[color:var(--lp-accent)]" aria-label={`${count} out of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <svg key={i} viewBox="0 0 24 24" className="h-4 w-4" fill={i < count ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />
        </svg>
      ))}
    </div>
  );
}

function Testimonials({ values: v, env }: SectionProps) {
  return (
    <Container className="py-20">
      <SectionHeading title={S.str(v.heading)} />
      <div className="grid gap-6 md:grid-cols-3">
        {S.arr(v.items).map((t, i) => {
          const avatar = S.img(t.avatar);
          const name = S.str(t.name);
          return (
            <figure key={i} className="flex flex-col rounded-[var(--lp-radius)] bg-[var(--lp-surface)] p-6 shadow-sm ring-1 ring-black/5">
              <Stars count={Number(S.str(t.rating)) || 0} />
              <blockquote className="mt-4 flex-1 text-lg leading-relaxed">“{S.str(t.quote)}”</blockquote>
              <figcaption className="mt-6 flex items-center gap-3">
                {avatar ? (
                  <LandingImage value={avatar} env={env} className="h-10 w-10 rounded-full" placeholder="none" />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--lp-primary)] font-semibold text-[color:var(--lp-on-primary)]">
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span>
                  <span className="block font-semibold">{name}</span>
                  {S.str(t.role) ? <span className="block text-sm text-[color:var(--lp-muted)]">{S.str(t.role)}</span> : null}
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
  return (
    <div className="bg-[var(--lp-surface)]">
      <Container className="py-20">
        <SectionHeading title={S.str(v.heading)} intro={S.str(v.intro)} align="left" />
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {S.arr(v.items).map((s, i) => {
            const img = S.img(s.image);
            return (
              <article key={i} className="flex flex-col overflow-hidden rounded-[var(--lp-radius)] bg-[var(--lp-bg)] shadow-sm ring-1 ring-black/5">
                {img ? <LandingImage value={img} env={env} className="aspect-[16/10] w-full" /> : <div className="h-1.5 bg-[var(--lp-primary)]" />}
                <div className="flex flex-1 flex-col p-6">
                  <h3 className="text-xl font-semibold">{S.str(s.title)}</h3>
                  {S.str(s.text) ? <p className="mt-2 flex-1 text-[color:var(--lp-muted)]">{S.str(s.text)}</p> : null}
                  {S.str(s.price) ? <p className="mt-4 text-lg font-bold text-[color:var(--lp-primary)]">{S.str(s.price)}</p> : null}
                </div>
              </article>
            );
          })}
        </div>
      </Container>
    </div>
  );
}

function About({ values: v, env }: SectionProps) {
  const stats = S.arr(v.stats);
  const img = S.img(v.image);
  return (
    <Container className={cx("grid gap-12 py-20", img && "md:grid-cols-2 md:items-center")}>
      <div>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{S.str(v.heading)}</h2>
        {S.str(v.body) ? <RichText value={S.str(v.body)} className="mt-5 text-lg text-[color:var(--lp-muted)]" /> : null}
        {stats.length ? (
          <dl className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-3">
            {stats.map((s, i) => (
              <div key={i} className="border-l-4 border-[color:var(--lp-accent)] pl-4">
                <dt className="text-sm text-[color:var(--lp-muted)]">{S.str(s.label)}</dt>
                <dd className="text-3xl font-bold text-[color:var(--lp-primary)]">{S.str(s.value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      {img ? <LandingImage value={img} env={env} className="aspect-[4/3] w-full rounded-[var(--lp-radius)]" /> : null}
    </Container>
  );
}

function Faq({ values: v }: SectionProps) {
  return (
    <Container className="max-w-3xl py-20">
      <SectionHeading title={S.str(v.heading)} />
      <div className="divide-y divide-black/10 rounded-[var(--lp-radius)] bg-[var(--lp-surface)] ring-1 ring-black/5">
        {S.arr(v.items).map((q, i) => (
          <details key={i} className="group p-6" open={i === 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold">
              {S.str(q.question)}
              <span aria-hidden="true" className="text-[color:var(--lp-primary)] transition-transform group-open:rotate-45">+</span>
            </summary>
            <RichText value={S.str(q.answer)} className="mt-3 text-[color:var(--lp-muted)]" />
          </details>
        ))}
      </div>
    </Container>
  );
}

function ContactRow({ icon, label, children, href }: { icon: string; label: string; children: string; href?: string | null }) {
  if (!children) return null;
  return (
    <div className="flex gap-4">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--lp-radius)] bg-[var(--lp-surface)] text-[color:var(--lp-primary)]">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-[color:var(--lp-muted)]">{label}</p>
        {href ? (
          <a href={href} className="whitespace-pre-line font-semibold hover:underline">{children}</a>
        ) : (
          <p className="whitespace-pre-line font-semibold">{children}</p>
        )}
      </div>
    </div>
  );
}

function Contact({ values: v }: SectionProps) {
  const phone = S.str(v.phone);
  const wa = S.str(v.whatsapp);
  const email = S.str(v.email);
  return (
    <Container className="py-20">
      <div className="grid gap-10 rounded-[var(--lp-radius)] p-8 ring-1 ring-black/10 md:grid-cols-2 md:p-12">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{S.str(v.heading)}</h2>
          {S.str(v.text) ? <p className="mt-4 text-lg text-[color:var(--lp-muted)]">{S.str(v.text)}</p> : null}
          <div className="mt-8">
            <CtaButton value={S.cta(v.cta)} size="lg" />
          </div>
        </div>
        <div className="space-y-6">
          <ContactRow icon="phone" label="Phone" href={ctaHref({ kind: "phone", phone })?.href}>{phone}</ContactRow>
          <ContactRow icon="chat" label="WhatsApp" href={ctaHref({ kind: "whatsapp", phone: wa })?.href}>{wa}</ContactRow>
          <ContactRow icon="chat" label="Email" href={ctaHref({ kind: "email", email })?.href}>{email}</ContactRow>
          <ContactRow icon="map-pin" label="Address">{S.str(v.address)}</ContactRow>
          <ContactRow icon="clock" label="Opening hours">{S.str(v.hours)}</ContactRow>
        </div>
      </div>
    </Container>
  );
}

function Cta({ values: v }: SectionProps) {
  if (S.str(v.style) === "card") {
    return (
      <Container className="py-20">
        <div className="mx-auto max-w-3xl rounded-[var(--lp-radius)] bg-[var(--lp-surface)] p-10 text-center shadow-lg ring-1 ring-black/5 md:p-14">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{S.str(v.heading)}</h2>
          {S.str(v.text) ? <p className="mx-auto mt-4 max-w-xl text-lg text-[color:var(--lp-muted)]">{S.str(v.text)}</p> : null}
          <div className="mt-8">
            <CtaButton value={S.cta(v.cta)} size="lg" />
          </div>
        </div>
      </Container>
    );
  }
  return (
    <div className="bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)]">
      <Container className="flex flex-col items-center gap-6 py-16 text-center md:flex-row md:justify-between md:text-left">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{S.str(v.heading)}</h2>
          {S.str(v.text) ? <p className="mt-2 text-lg opacity-90">{S.str(v.text)}</p> : null}
        </div>
        <CtaButton value={S.cta(v.cta)} size="lg" variant="inverse" />
      </Container>
    </div>
  );
}

const SOCIAL_LABEL = new Map<string, string>(SOCIAL_NETWORKS.map((n) => [n.value, n.label]));

function Footer({ values: v }: SectionProps) {
  const links = S.arr(v.links);
  const socials = S.arr(v.socials);
  return (
    <footer className="border-t border-black/10 bg-[var(--lp-surface)]">
      <Container className="flex flex-col gap-8 py-12 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-lg font-bold">{S.str(v.brandName)}</p>
          {S.str(v.tagline) ? <p className="mt-1 text-[color:var(--lp-muted)]">{S.str(v.tagline)}</p> : null}
        </div>
        <div className="flex flex-col gap-4 text-sm md:items-end">
          {links.length ? (
            <nav className="flex flex-wrap gap-x-5 gap-y-2">
              {links.map((l, i) => {
                const href = safeUrl(S.str(l.url));
                return href ? (
                  <a key={i} href={href} rel="noopener noreferrer nofollow ugc" className="hover:underline">
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
                    className="rounded-full px-3 py-1 font-medium ring-1 ring-black/15 hover:bg-black/5"
                  >
                    {SOCIAL_LABEL.get(S.str(s.network)) ?? "Link"}
                  </a>
                ) : null;
              })}
            </div>
          ) : null}
          {S.str(v.copyright) ? <p className="text-[color:var(--lp-muted)]">{S.str(v.copyright)}</p> : null}
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
};
