import { AlertTriangle } from "lucide-react";
import {
  type CatalogProduct,
  type Locale,
  type LocalizedContent,
  type TemplateSpec,
  effectiveSections,
  spotlightProduct,
} from "@ecom/landing";

/**
 * Things worth knowing before publishing that are not errors: the page can
 * still be published (unlike publish blockers, which come from the shared
 * validator). Shown inside the existing publish confirmation.
 *
 * - A page with a Product spotlight whose product can't be bought: its
 *   Order now buttons won't open checkout.
 * - Text still holding a template's bracketed prompt ("[Customer name]") —
 *   templates use these where only the merchant can supply real content.
 */

export interface PublishWarning {
  key: "no-product" | "product-unavailable" | "placeholders";
  message: string;
}

/** A whole value that is a template prompt to replace, e.g. "[Customer name]". */
const PLACEHOLDER_RE = /^\s*\[[^[\]]+\]\s*$/;

function hasPlaceholder(v: unknown, depth = 0): boolean {
  if (typeof v === "string") return PLACEHOLDER_RE.test(v);
  // Section values are shallow (field → repeater item → field); stop well before anything deep.
  if (depth > 4 || v === null || typeof v !== "object") return false;
  return (Array.isArray(v) ? v : Object.values(v)).some((x) => hasPlaceholder(x, depth + 1));
}

/** Sections (in page order) whose content still holds a bracketed prompt in any enabled language. */
export function placeholderSections(
  spec: TemplateSpec,
  content: LocalizedContent,
  locales: ReadonlyArray<Locale>,
): Array<{ id: string; type: string; label: string }> {
  const found = new Map<string, { id: string; type: string; label: string }>();
  for (const locale of locales) {
    for (const s of effectiveSections(spec, locale)) {
      if (!s.visual || found.has(s.id)) continue;
      if (hasPlaceholder(content[locale]?.[s.id])) found.set(s.id, { id: s.id, type: s.type, label: s.label });
    }
  }
  const order = spec.sections.map((s) => s.id);
  return [...found.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/**
 * Warnings for the publish confirmation. `catalog` is the page's linked
 * products as the editor loaded them (the draft selection publishing will
 * use); null while unknown, which never warns.
 */
export function publishWarnings(input: {
  spec: TemplateSpec;
  content: LocalizedContent;
  locales: ReadonlyArray<Locale>;
  catalog: ReadonlyArray<CatalogProduct> | null | undefined;
}): PublishWarning[] {
  const out: PublishWarning[] = [];
  if (input.catalog && input.spec.sections.some((s) => s.type === "productSpotlight")) {
    const product = spotlightProduct(input.catalog);
    if (!product) {
      out.push({
        key: "no-product",
        message: "This page has no product to sell yet — its Order now buttons won’t open checkout. Link a product on the Products tab.",
      });
    } else if (!product.available) {
      out.push({
        key: "product-unavailable",
        message: `“${product.name}” can’t be ordered right now (out of stock or inactive) — the page’s Order now buttons won’t open checkout. Check it on the Products tab.`,
      });
    }
  }
  const sections = placeholderSections(input.spec, input.content, input.locales);
  if (sections.length) {
    const reviewsOnly = sections.every((s) => s.type === "testimonials");
    out.push({
      key: "placeholders",
      message: `Some text in ${sections.map((s) => s.label).join(", ")} still contains placeholders in [square brackets]. ${
        reviewsOnly ? "Replace it with real customer reviews before publishing." : "Replace it with your own text before publishing."
      }`,
    });
  }
  return out;
}

/** Shown in the publish confirmation; nothing when there is nothing to say. Never blocks publishing. */
export function PublishWarnings({ warnings }: { warnings: ReadonlyArray<PublishWarning> }) {
  if (!warnings.length) return null;
  return (
    <ul className="space-y-2" aria-label="Before you publish" data-publish-warnings="">
      {warnings.map((w) => (
        <li key={w.key} className="flex gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning" data-warning={w.key}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{w.message}</span>
        </li>
      ))}
    </ul>
  );
}
