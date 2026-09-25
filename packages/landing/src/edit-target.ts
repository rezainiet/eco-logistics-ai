import type { FieldDef } from "./fields.js";
import type { Locale } from "./locales.js";
import { SECTION_ID_RE } from "./safe.js";
import { FIELD_KEY_RE, type TemplateSpec, effectiveSections } from "./spec.js";

/**
 * Click-to-edit targets.
 *
 * The editor preview tags rendered elements with the schema path of the
 * field they show — "<sectionId>" or "<sectionId>.<fieldKey>[.<index>.<key>]",
 * e.g. "hero.headline", "products.items.2.price". A click reports that path;
 * this module decides, from the template schema alone, what it may open.
 * The DOM is never trusted: a path that does not name an editable field of
 * the current template (or names a locked one) opens nothing.
 */

const MAX_DEPTH = 5;
const INDEX_RE = /^(0|[1-9][0-9]{0,2})$/;

export type EditTarget =
  | {
      kind: "field";
      /** Full path, sectionId first — the editor's field anchor. */
      path: string;
      sectionId: string;
      /** Human breadcrumb, e.g. "Products → Product 3 → Price". */
      label: string;
    }
  | { kind: "section"; path: string; sectionId: string; label: string }
  /** Exists in the template but is fixed by it (not editable, or not a visual section). */
  | { kind: "locked"; path: string; label: string }
  | { kind: "invalid" };

/** Syntactic check only — cheap to run on untrusted input before resolving. */
export function isEditPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 200) return false;
  const [section, ...rest] = path.split(".");
  if (!section || !SECTION_ID_RE.test(section) || rest.length > MAX_DEPTH) return false;
  return rest.every((seg) => FIELD_KEY_RE.test(seg) || INDEX_RE.test(seg));
}

export function resolveEditTarget(spec: TemplateSpec, locale: Locale, path: unknown): EditTarget {
  if (!isEditPath(path)) return { kind: "invalid" };
  const [sectionId, ...rest] = path.split(".");
  const section = effectiveSections(spec, locale).find((s) => s.id === sectionId);
  if (!section) return { kind: "invalid" };
  const crumbs = [section.label];
  // "Products → Products → Product 3": skip a crumb that repeats the previous one.
  const push = (label: string) => {
    if (crumbs[crumbs.length - 1] !== label) crumbs.push(label);
  };
  if (!section.visual) return { kind: "locked", path, label: section.label };
  if (rest.length === 0) {
    return section.fields.some((f) => f.editable)
      ? { kind: "section", path, sectionId: section.id, label: section.label }
      : { kind: "locked", path, label: section.label };
  }

  const [key, ...tail] = rest;
  const top = section.fields.find((f) => f.key === key);
  if (!top) return { kind: "invalid" };
  push(top.label);
  if (!top.editable) return { kind: "locked", path, label: crumbs.join(" → ") };

  // Walk into repeaters: <index>.<subKey>, repeated.
  let field: FieldDef = top;
  for (let i = 0; i < tail.length; i++) {
    const seg = tail[i]!;
    if (field.type !== "repeater") return { kind: "invalid" };
    if (!INDEX_RE.test(seg) || Number(seg) >= field.maxItems) return { kind: "invalid" };
    push(`${field.itemLabel} ${Number(seg) + 1}`);
    const subKey = tail[i + 1];
    if (subKey === undefined) break;
    const sub: FieldDef | undefined = field.itemFields.find((f) => f.key === subKey);
    if (!sub) return { kind: "invalid" };
    push(sub.label);
    field = sub;
    i++;
  }
  return { kind: "field", path, sectionId: section.id, label: crumbs.join(" → ") };
}
