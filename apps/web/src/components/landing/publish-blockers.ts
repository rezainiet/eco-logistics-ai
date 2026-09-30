import {
  type ContentIssue,
  type EffectiveSection,
  type FieldDef,
  type Locale,
  type TemplateSpec,
  LOCALE_LABELS,
  effectiveSections,
  isLocale,
} from "@ecom/landing";

/**
 * Turns the output of the shared validator (`validateLocalizedContent`, the
 * same function the server runs on publish) into things the editor can show
 * and jump to. It never decides what is valid — it only labels and locates
 * the issues the validator already produced.
 */

export interface PublishBlocker {
  /** Stable key: `<locale>.<fieldPath>` (or the raw issue path when unmappable). */
  key: string;
  locale: Locale | null;
  /** Editor field path inside the locale — `order.cta`, `products.items.1.name` — or null when not a field. */
  fieldPath: string | null;
  sectionId: string | null;
  sectionLabel: string | null;
  /** Human field label: "Button", "Product 2 → Name". Never an internal key. */
  fieldLabel: string;
  /** The validator's own message ("Headline is required"). */
  message: string;
  /** true = a required value is missing (publish-only issue); false = a value is invalid. */
  missing: boolean;
}

const INDEX_RE = /^\d+$/;

/**
 * Deepest editable field an issue path points at, plus its label crumbs.
 * `order.cta.action.url` → field `order.cta` (zod sub-paths inside a value
 * collapse onto the field); `products.items.1.name` → the repeater item field.
 */
function locateField(sections: EffectiveSection[], path: string): { fieldPath: string; section: EffectiveSection; crumbs: string[] } | null {
  const [sectionId, key, ...tail] = path.split(".");
  const section = sections.find((s) => s.id === sectionId);
  if (!section || !key) return null;
  const top = section.fields.find((f) => f.key === key && f.editable);
  if (!top) return null;
  const crumbs = [top.label];
  const segments = [section.id, key];
  let field: FieldDef = top;
  for (let i = 0; i + 1 < tail.length && field.type === "repeater"; i += 2) {
    const idx = tail[i]!;
    const subKey = tail[i + 1]!;
    if (!INDEX_RE.test(idx)) break;
    const sub: FieldDef | undefined = field.itemFields.find((f) => f.key === subKey);
    if (!sub) break;
    crumbs.push(`${field.itemLabel} ${Number(idx) + 1}`, sub.label);
    segments.push(idx, subKey);
    field = sub;
  }
  return { fieldPath: segments.join("."), section, crumbs };
}

/**
 * Label every publish-blocking issue. `draftIssues` is the same validator in
 * draft mode: an issue present only in publish mode is a missing required
 * value; one present in both is an invalid value.
 */
export function describePublishBlockers(
  spec: TemplateSpec,
  publishIssues: readonly ContentIssue[],
  draftIssues: readonly ContentIssue[] = [],
): PublishBlocker[] {
  const draftPaths = new Set(draftIssues.map((i) => `${i.path}\u0000${i.message}`));
  const sectionsByLocale = new Map<Locale, EffectiveSection[]>();
  const out: PublishBlocker[] = [];
  const seen = new Set<string>();
  for (const issue of publishIssues) {
    const [loc, ...rest] = issue.path.split(".");
    const missing = !draftPaths.has(`${issue.path}\u0000${issue.message}`);
    if (loc && isLocale(loc) && rest.length) {
      if (!sectionsByLocale.has(loc)) sectionsByLocale.set(loc, effectiveSections(spec, loc));
      const hit = locateField(sectionsByLocale.get(loc)!, rest.join("."));
      if (hit) {
        const key = `${loc}.${hit.fieldPath}`;
        if (seen.has(key)) continue; // one entry per field, first message wins
        seen.add(key);
        out.push({
          key,
          locale: loc,
          fieldPath: hit.fieldPath,
          sectionId: hit.section.id,
          sectionLabel: hit.section.label,
          fieldLabel: hit.crumbs.join(" → "),
          message: issue.message,
          missing,
        });
        continue;
      }
    }
    const key = issue.path || issue.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      locale: loc && isLocale(loc) ? loc : null,
      fieldPath: null,
      sectionId: null,
      sectionLabel: null,
      fieldLabel: issue.message,
      message: issue.message,
      missing,
    });
  }
  return out;
}

/** Heading for the blocked-publish dialog. */
export function blockerHeadline(blockers: readonly PublishBlocker[]): string {
  const n = blockers.length;
  const missing = blockers.filter((b) => b.missing).length;
  if (missing === n) return n === 1 ? "1 required field is missing" : `${n} required fields are missing`;
  if (missing === 0) return n === 1 ? "1 field needs fixing" : `${n} fields need fixing`;
  return `${n} fields need attention`;
}

/** "Order call to action · বাংলা" — where the field lives (language only when the page has several). */
export function blockerWhere(b: PublishBlocker, multiLocale: boolean): string {
  return [b.sectionLabel, multiLocale && b.locale ? LOCALE_LABELS[b.locale].native : null].filter(Boolean).join(" · ");
}

/**
 * Issues to show on the fields of one language: publish issues (after a
 * blocked publish attempt) plus server-reported issues, locale prefix removed,
 * de-duplicated against the draft issues already shown.
 */
export function fieldIssuesForLocale(
  locale: Locale,
  draftIssues: readonly ContentIssue[],
  publishIssues: readonly ContentIssue[],
  showPublish: boolean,
): ContentIssue[] {
  const prefix = `${locale}.`;
  const seen = new Set<string>();
  const out: ContentIssue[] = [];
  for (const i of [...draftIssues, ...(showPublish ? publishIssues : [])]) {
    if (!i.path.startsWith(prefix)) continue;
    const path = i.path.slice(prefix.length);
    const k = `${path}\u0000${i.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ path, message: i.message });
  }
  return out;
}

/**
 * The server reports publish validation as a single message produced by
 * `issuesError` ("Page not published — bn.order.cta: Button needs …; …").
 * Recover the issues so they can be shown on their fields. Returns [] for any
 * other error.
 */
export function parseServerPublishIssues(message: string): ContentIssue[] {
  const sep = message.indexOf(" — ");
  if (sep < 0 || !message.startsWith("Page not published")) return [];
  const body = message.slice(sep + 3).replace(/ \(\+\d+ more\)$/, "");
  const out: ContentIssue[] = [];
  for (const part of body.split("; ")) {
    const m = /^([a-z]{2}(?:\.[A-Za-z0-9_-]+)*): (.+)$/.exec(part.trim());
    if (m) out.push({ path: m[1]!, message: m[2]! });
    else if (part.trim()) out.push({ path: "", message: part.trim() });
  }
  return out;
}
