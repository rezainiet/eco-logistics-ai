import {
  type CatalogProduct,
  type ContentIssue,
  type EffectiveSection,
  type Locale,
  type LocalizedContent,
  type TemplateSpec,
  defaultContent,
  effectiveSections,
} from "@ecom/landing";
import { hasPlaceholder, spotlightReadiness } from "./publish-warnings";

/**
 * Editor-only "landing page setup" model: for every visible section of a
 * page, how important it is, what it is for, and whether it is ready.
 *
 * Presentation metadata only — it lives here, not in templates, so it never
 * changes a template's content, hash or version. Readiness is derived from
 * what the editor already knows (the shared validator's issues, the linked
 * products, the template's own defaults); it never blocks publishing and is
 * not a second publish validation.
 *
 *   section type → importance + description (+ readiness resolver)
 *   template key → per-template overrides (by section id or type)
 */

export type SectionImportance = "required" | "recommended" | "optional";
/** null = still checking (e.g. the linked products are loading). */
export type SectionReadiness = "ready" | "needs-editing" | "check-defaults";

export interface SectionUx {
  importance: SectionImportance;
  description: string;
}

interface ReadinessContext {
  section: EffectiveSection;
  spec: TemplateSpec;
  content: LocalizedContent;
  locales: ReadonlyArray<Locale>;
  catalog: ReadonlyArray<CatalogProduct> | null | undefined;
}

/** A type-specific status, or undefined to fall through to the generic checks. */
type ReadinessResolver = (ctx: ReadinessContext) => { readiness: SectionReadiness | null; detail: string | null } | undefined;

/** Defaults for every section type; templates without their own mapping use these. */
export const SECTION_UX: Readonly<Record<string, SectionUx>> = {
  announcement: { importance: "recommended", description: "Offer message and campaign announcement" },
  header: { importance: "recommended", description: "Logo, brand name and top button" },
  shopHeader: { importance: "recommended", description: "Logo, menu and order button" },
  hero: { importance: "recommended", description: "Main headline and introduction" },
  promoHero: { importance: "recommended", description: "Main headline and product introduction" },
  editorialHero: { importance: "recommended", description: "Main headline and brand introduction" },
  productSpotlight: { importance: "required", description: "Product, price, variants and Buy Now" },
  productGrid: { importance: "recommended", description: "Products with prices and order buttons" },
  categoryGrid: { importance: "optional", description: "Shop categories" },
  offerBanner: { importance: "optional", description: "Limited-time offer or flash sale" },
  benefits: { importance: "recommended", description: "Why the product is worth buying" },
  features: { importance: "recommended", description: "Key features in short points" },
  trustFeatures: { importance: "recommended", description: "Reasons to trust your shop" },
  services: { importance: "recommended", description: "Services and prices" },
  about: { importance: "optional", description: "Your story and key numbers" },
  testimonials: { importance: "optional", description: "Customer reviews" },
  faq: { importance: "optional", description: "Answers to common questions" },
  deliveryInfo: { importance: "required", description: "Delivery areas, charges and payment method" },
  contact: { importance: "recommended", description: "How customers reach you" },
  cta: { importance: "recommended", description: "Call to action" },
  mobileActionBar: { importance: "required", description: "Order button fixed to the bottom of phones" },
  footer: { importance: "optional", description: "Links and copyright" },
  shopFooter: { importance: "optional", description: "Contact and store information" },
};

const FALLBACK_UX: SectionUx = { importance: "recommended", description: "" };

/** Per-template overrides, keyed by section id or section type. */
export const TEMPLATE_SECTION_UX: Readonly<Record<string, Readonly<Record<string, Partial<SectionUx>>>>> = {
  "bd-single-product": {
    productSpotlight: { importance: "required" },
    deliveryInfo: { importance: "required", description: "Delivery areas and payment method" },
    mobileActionBar: { importance: "required" },
    announcement: { importance: "recommended" },
    promoHero: { importance: "recommended" },
    benefits: { importance: "recommended" },
    trustFeatures: { importance: "recommended" },
    features: { importance: "recommended", description: "The steps to order" },
    offerBanner: { importance: "optional" },
    testimonials: { importance: "optional" },
    faq: { importance: "optional" },
    shopFooter: { importance: "optional" },
  },
};

export function sectionUx(templateKey: string | null | undefined, section: Pick<EffectiveSection, "id" | "type">): SectionUx {
  const base = SECTION_UX[section.type] ?? FALLBACK_UX;
  const overrides = templateKey ? TEMPLATE_SECTION_UX[templateKey] : undefined;
  return { ...base, ...(overrides?.[section.type] ?? {}), ...(overrides?.[section.id] ?? {}) };
}

// ─── Readiness ──────────────────────────────────────────────────────────────

const money = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? `৳${n.toLocaleString("en-US")}` : null);

const READINESS: Readonly<Record<string, ReadinessResolver>> = {
  // The same truth as the publish warning: the product the spotlight shows must be buyable.
  productSpotlight: ({ catalog }) => {
    const spot = spotlightReadiness(catalog);
    if (spot.state === "unknown") return { readiness: null, detail: "Checking linked products…" };
    if (spot.state === "none") return { readiness: "needs-editing", detail: "Link a product on the Products tab" };
    if (spot.state === "unavailable") return { readiness: "needs-editing", detail: `“${spot.product.name}” can’t be ordered right now` };
    return undefined;
  },
  // The zones are the checkout's delivery options; the template's sample charges are valid but worth a look.
  deliveryInfo: ({ section, spec, content, locales }) => {
    // Compared by value (area, time, charge) — never by object key order.
    const shape = (zones: unknown) =>
      JSON.stringify(Array.isArray(zones) ? zones.map((z: Record<string, unknown> | null) => [z?.area ?? "", z?.time ?? "", z?.charge ?? null]) : null);
    const unchanged = locales.every((l) => {
      const defaults = defaultContent(spec, l)[section.id]?.zones;
      return Array.isArray(defaults) && defaults.length > 0 && shape(content[l]?.[section.id]?.zones) === shape(defaults);
    });
    if (!unchanged || !locales.length) return undefined;
    const zones = content[locales[0]!]?.[section.id]?.zones as Array<{ charge?: unknown }>;
    const charges = zones.map((z) => money(z.charge)).filter((c): c is string => c !== null);
    return {
      readiness: "check-defaults",
      detail: charges.length ? `Review ${charges.join(" / ")} delivery charges` : "Review the template’s delivery areas",
    };
  },
};

/** How many entries (repeater items, else fields) still hold a template's bracketed prompt. */
function placeholderCount(values: Record<string, unknown> | undefined): number {
  if (!values) return 0;
  let n = 0;
  for (const v of Object.values(values)) {
    if (Array.isArray(v)) n += v.filter((item) => hasPlaceholder(item)).length;
    else if (hasPlaceholder(v)) n += 1;
  }
  return n;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function readinessOf(ctx: ReadinessContext, issues: ReadonlyArray<ContentIssue>): { readiness: SectionReadiness | null; detail: string | null } {
  const specific = READINESS[ctx.section.type]?.(ctx);
  if (specific && specific.readiness !== "check-defaults") return specific;
  // The shared validator's own issues for this section, in any enabled language.
  const own = issues.filter((i) => ctx.locales.some((l) => i.path === `${l}.${ctx.section.id}` || i.path.startsWith(`${l}.${ctx.section.id}.`)));
  if (own.length) {
    return { readiness: "needs-editing", detail: own.length === 1 ? own[0]!.message : `${own.length} fields need attention` };
  }
  const placeholders = Math.max(0, ...ctx.locales.map((l) => placeholderCount(ctx.content[l]?.[ctx.section.id])));
  if (placeholders) {
    return {
      readiness: "needs-editing",
      detail:
        ctx.section.type === "testimonials"
          ? `Replace ${plural(placeholders, "placeholder review", "placeholder reviews")}`
          : `Replace ${plural(placeholders, "placeholder", "placeholders")}`,
    };
  }
  return specific ?? { readiness: "ready", detail: null };
}

// ─── Page model ─────────────────────────────────────────────────────────────

export interface SectionSetup {
  id: string;
  type: string;
  label: string;
  /** 1-based position among the page's visible sections. */
  number: number;
  importance: SectionImportance;
  description: string;
  readiness: SectionReadiness | null;
  detail: string | null;
}

export interface LandingSetup {
  /** The visible landing sections, in page order. */
  sections: SectionSetup[];
  /** Page-wide settings (theme, SEO…) — not sections of the page, never counted. */
  pageSettings: EffectiveSection[];
  counts: { total: number; ready: number; needsEditing: number; checkDefaults: number; checking: number };
  /** Sections that are not ready, in page order. */
  attention: SectionSetup[];
}

export function landingSetup(input: {
  templateKey: string | null | undefined;
  spec: TemplateSpec;
  content: LocalizedContent;
  /** The page's enabled languages. */
  locales: ReadonlyArray<Locale>;
  /** Linked products as the editor loaded them; null/undefined while loading. */
  catalog: ReadonlyArray<CatalogProduct> | null | undefined;
  /** Issues from the shared validator (validateLocalizedContent, publish mode). */
  issues: ReadonlyArray<ContentIssue>;
}): LandingSetup {
  const all = effectiveSections(input.spec, input.locales[0]);
  const visual = all.filter((s) => s.visual);
  const sections = visual.map((section, i): SectionSetup => {
    const ux = sectionUx(input.templateKey, section);
    const r = readinessOf({ section, spec: input.spec, content: input.content, locales: input.locales, catalog: input.catalog }, input.issues);
    return { id: section.id, type: section.type, label: section.label, number: i + 1, importance: ux.importance, description: ux.description, ...r };
  });
  const count = (r: SectionReadiness | null) => sections.filter((s) => s.readiness === r).length;
  return {
    sections,
    pageSettings: all.filter((s) => !s.visual),
    counts: {
      total: sections.length,
      ready: count("ready"),
      needsEditing: count("needs-editing"),
      checkDefaults: count("check-defaults"),
      checking: count(null),
    },
    attention: sections.filter((s) => s.readiness === "needs-editing" || s.readiness === "check-defaults"),
  };
}
