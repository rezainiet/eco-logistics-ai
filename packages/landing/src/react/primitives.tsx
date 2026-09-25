import type { ReactNode } from "react";
import { ctaHref, hasCta } from "../cta.js";
import type { CtaValue, ImageValue } from "../fields.js";
import { ASSET_ID_RE, parseRichText } from "../safe.js";
import type { IconName } from "../sections.js";

/**
 * Trusted rendering primitives. Components never interpolate merchant
 * values into markup strings, `dangerouslySetInnerHTML`, event handlers,
 * `style` values (other than pre-validated colour tokens set once on the
 * renderer root), or URLs that did not come out of `ctaHref`/`assetUrl`.
 */

export interface RenderEnv {
  /** Maps a validated asset id to an image URL. Returns null if unavailable. */
  assetUrl: (assetId: string) => string | null;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

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
};

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-6xl px-5 sm:px-8", className)}>{children}</div>;
}

export function CtaButton({
  value,
  variant = "primary",
  size = "md",
}: {
  value: CtaValue | null;
  variant?: "primary" | "secondary" | "inverse" | "outline-inverse" | "ghost";
  size?: "sm" | "md" | "lg";
}) {
  if (!value) return null;
  const target = ctaHref(value.action);
  const cls = cx(
    "inline-flex items-center justify-center gap-2 font-semibold transition-opacity hover:opacity-90 rounded-[var(--lp-radius)]",
    size === "sm" && "px-4 py-2 text-sm",
    size === "md" && "px-6 py-3 text-base",
    size === "lg" && "px-8 py-4 text-lg",
    variant === "primary" && "bg-[var(--lp-primary)] text-[color:var(--lp-on-primary)] shadow-sm",
    variant === "secondary" && "border border-current text-[color:var(--lp-primary)] bg-transparent",
    variant === "inverse" && "bg-[var(--lp-on-primary)] text-[color:var(--lp-primary)] shadow-sm",
    variant === "outline-inverse" && "border border-current text-[color:var(--lp-on-primary)] bg-transparent",
    variant === "ghost" && "text-[color:var(--lp-primary)] underline-offset-4 hover:underline",
  );
  if (!target) {
    // No safe destination (e.g. an unfinished draft): show the button so
    // the layout is honest, but it goes nowhere.
    return (
      <span className={cls} aria-disabled="true" data-cta-unlinked="">
        {value.label}
      </span>
    );
  }
  return (
    <a
      href={target.href}
      className={cls}
      {...(target.external ? { target: "_blank", rel: "noopener noreferrer nofollow ugc" } : {})}
    >
      {value.label}
    </a>
  );
}

export function RichText({ value, className }: { value: string; className?: string }) {
  const blocks = parseRichText(value);
  if (!blocks.length) return null;
  return (
    <div className={cx("space-y-4 leading-relaxed", className)}>
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
}: {
  value: ImageValue | null;
  env: RenderEnv;
  className?: string;
  placeholder?: "gradient" | "none";
}) {
  const src = value ? env.assetUrl(value.assetId) : null;
  if (!src) {
    if (placeholder === "none") return null;
    return (
      <div
        aria-hidden="true"
        className={cx(
          "flex items-center justify-center bg-gradient-to-br from-[var(--lp-primary)] to-[var(--lp-accent)] opacity-90",
          className,
        )}
      >
        <Icon name="sparkles" className="h-12 w-12 text-[color:var(--lp-on-primary)] opacity-70" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={value?.alt ?? ""} loading="lazy" decoding="async" className={cx("object-cover", className)} />;
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

export function SectionHeading({ title, intro, align = "center" }: { title: string; intro?: string; align?: "center" | "left" }) {
  if (!title && !intro) return null;
  return (
    <div className={cx("mb-10 max-w-2xl", align === "center" && "mx-auto text-center")}>
      {title ? <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2> : null}
      {intro ? <p className="mt-4 text-lg text-[color:var(--lp-muted)]">{intro}</p> : null}
    </div>
  );
}
