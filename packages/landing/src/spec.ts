import { z } from "zod";
import {
  type FieldDef,
  emptyValueFor,
  isEmptyValue,
  valueSchemaFor,
} from "./fields.js";
import { SECTION_ID_RE } from "./safe.js";
import { type SectionTypeDef, getSectionType } from "./sections.js";

/**
 * Template spec — what an admin authors and a template version stores.
 *
 * A spec is an ordered list of sections. Each entry names a registered
 * section type (`type@typeVersion`) and may override that type's fields:
 * lock them (`editable: false`, value fixed to `default`), require them,
 * give them a template-specific default, or relabel them. That is the whole
 * vocabulary — a spec cannot introduce markup, styles or components.
 *
 * Page content is keyed by section id then field key and stores ONLY the
 * editable fields. Locked values come from the pinned template version at
 * render time, so a merchant cannot override them by editing stored JSON.
 */

export const SPEC_VERSION = 1 as const;

export const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

const fieldOverrideSchema = z
  .object({
    editable: z.boolean().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    label: z.string().trim().min(1).max(80).optional(),
    help: z.string().trim().max(200).optional(),
  })
  .strict();

const specSectionSchema = z
  .object({
    id: z.string().regex(SECTION_ID_RE, "Section id must be lowercase letters, digits and dashes"),
    type: z.string().min(1).max(40),
    typeVersion: z.number().int().positive(),
    label: z.string().trim().min(1).max(80).optional(),
    fields: z.record(z.string().regex(FIELD_KEY_RE), fieldOverrideSchema).optional(),
  })
  .strict();

const specShapeSchema = z
  .object({
    specVersion: z.literal(SPEC_VERSION),
    sections: z.array(specSectionSchema).min(3).max(30),
  })
  .strict();

export type FieldOverride = z.infer<typeof fieldOverrideSchema>;
export type TemplateSpecSection = z.infer<typeof specSectionSchema>;
export type TemplateSpec = z.infer<typeof specShapeSchema>;

export type EffectiveField = FieldDef & { editable: boolean };

export interface EffectiveSection {
  id: string;
  type: string;
  typeVersion: number;
  label: string;
  visual: boolean;
  fields: EffectiveField[];
}

export interface ContentIssue {
  path: string;
  message: string;
}

export type SectionContent = Record<string, unknown>;
export type PageContent = Record<string, SectionContent>;

function merge(field: FieldDef, override: FieldOverride | undefined): EffectiveField {
  const out = { ...field, editable: override?.editable ?? true } as EffectiveField;
  if (override?.required !== undefined) out.required = override.required;
  if (override?.default !== undefined) out.default = override.default;
  if (override?.label !== undefined) out.label = override.label;
  if (override?.help !== undefined) out.help = override.help;
  return out;
}

/**
 * Validate an admin-authored spec. Beyond shape, checks that every section
 * type is registered, every overridden field exists on that type, every
 * default is a valid value for its field, and locked required fields carry
 * a value (otherwise a page could never satisfy them).
 */
export function parseTemplateSpec(
  input: unknown,
): { ok: true; spec: TemplateSpec } | { ok: false; issues: ContentIssue[] } {
  const parsed = specShapeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const spec = parsed.data;
  const issues: ContentIssue[] = [];
  const ids = new Set<string>();
  const counts = new Map<string, number>();

  spec.sections.forEach((section, idx) => {
    const at = `sections.${idx}`;
    if (ids.has(section.id)) issues.push({ path: `${at}.id`, message: `Duplicate section id "${section.id}"` });
    ids.add(section.id);
    counts.set(section.type, (counts.get(section.type) ?? 0) + 1);
    const def = getSectionType(section.type, section.typeVersion);
    if (!def) {
      issues.push({ path: `${at}.type`, message: `Unknown section type ${section.type}@${section.typeVersion}` });
      return;
    }
    for (const [key, override] of Object.entries(section.fields ?? {})) {
      const field = def.fields.find((f) => f.key === key);
      if (!field) {
        issues.push({ path: `${at}.fields.${key}`, message: `Section type "${def.type}" has no field "${key}"` });
        continue;
      }
      const eff = merge(field, override);
      if (override.default !== undefined) {
        const r = valueSchemaFor(field).safeParse(override.default);
        if (!r.success) {
          issues.push({
            path: `${at}.fields.${key}.default`,
            message: r.error.issues[0]?.message ?? "Invalid default value",
          });
        }
      }
      if (!eff.editable && eff.required && isEmptyValue(field, eff.default ?? emptyValueFor(field))) {
        issues.push({ path: `${at}.fields.${key}`, message: "A locked required field needs a default value" });
      }
    }
  });

  for (const singleton of ["theme", "seo"]) {
    const n = counts.get(singleton) ?? 0;
    if (n !== 1) issues.push({ path: "sections", message: `A template needs exactly one "${singleton}" section (found ${n})` });
  }
  if (!spec.sections.some((s) => getSectionType(s.type, s.typeVersion)?.visual)) {
    issues.push({ path: "sections", message: "A template needs at least one visible section" });
  }
  return issues.length ? { ok: false, issues } : { ok: true, spec };
}

export function effectiveSections(spec: TemplateSpec): EffectiveSection[] {
  const out: EffectiveSection[] = [];
  for (const section of spec.sections) {
    const def: SectionTypeDef | undefined = getSectionType(section.type, section.typeVersion);
    if (!def) continue;
    out.push({
      id: section.id,
      type: def.type,
      typeVersion: def.version,
      label: section.label ?? def.label,
      visual: def.visual,
      fields: def.fields.map((f) => merge(f, section.fields?.[f.key])),
    });
  }
  return out;
}

function defaultFor(field: FieldDef): unknown {
  const value = field.default !== undefined ? field.default : emptyValueFor(field);
  // Defaults are validated when the spec is saved; parse again so callers
  // always receive the normalised form (and a clone, never a shared ref).
  const r = valueSchemaFor(field).safeParse(value);
  return r.success ? r.data : emptyValueFor(field);
}

/** Initial content for a new page: every editable field at its default. */
export function defaultContent(spec: TemplateSpec): PageContent {
  const content: PageContent = {};
  for (const section of effectiveSections(spec)) {
    const values: SectionContent = {};
    for (const field of section.fields) {
      if (field.editable) values[field.key] = defaultFor(field);
    }
    content[section.id] = values;
  }
  return content;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requiredIssues(field: FieldDef, value: unknown, path: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  if (field.required && isEmptyValue(field, value)) {
    issues.push({ path, message: `${field.label} is required` });
  }
  if (field.type === "repeater" && Array.isArray(value)) {
    if (field.minItems && value.length < field.minItems) {
      issues.push({ path, message: `${field.label} needs at least ${field.minItems} item(s)` });
    }
    value.forEach((item, idx) => {
      for (const sub of field.itemFields) {
        issues.push(...requiredIssues(sub, (item as Record<string, unknown>)[sub.key], `${path}.${idx}.${sub.key}`));
      }
    });
  }
  return issues;
}

/**
 * Server-authoritative validation of merchant content against a template.
 *
 * - Unknown sections/fields are rejected (no smuggled keys).
 * - Locked fields may not be supplied at all.
 * - Every value must pass its field schema (unsafe URLs, bad colours,
 *   oversized text, forged asset ids all fail here).
 * - `mode: "publish"` additionally enforces required fields and minimums.
 *   `mode: "draft"` lets a merchant save unfinished work.
 *
 * Returns normalised content containing only editable fields; missing
 * editable fields are filled from defaults.
 */
export function validateContent(
  spec: TemplateSpec,
  raw: unknown,
  mode: "draft" | "publish",
): { ok: boolean; content: PageContent; issues: ContentIssue[] } {
  const issues: ContentIssue[] = [];
  const content: PageContent = {};
  const input = isPlainObject(raw) ? raw : {};
  if (!isPlainObject(raw)) issues.push({ path: "", message: "Content must be an object" });

  const sections = effectiveSections(spec);
  const known = new Set(sections.map((s) => s.id));
  for (const id of Object.keys(input)) {
    if (!known.has(id)) issues.push({ path: id, message: `Unknown section "${id}"` });
  }

  for (const section of sections) {
    const rawSection = input[section.id];
    if (rawSection !== undefined && !isPlainObject(rawSection)) {
      issues.push({ path: section.id, message: "Section content must be an object" });
    }
    const values = isPlainObject(rawSection) ? rawSection : {};
    const byKey = new Map(section.fields.map((f) => [f.key, f]));
    for (const key of Object.keys(values)) {
      const f = byKey.get(key);
      if (!f) issues.push({ path: `${section.id}.${key}`, message: `Unknown field "${key}"` });
      else if (!f.editable) issues.push({ path: `${section.id}.${key}`, message: `${f.label} is locked by the template` });
    }
    const out: SectionContent = {};
    for (const field of section.fields) {
      if (!field.editable) continue;
      const path = `${section.id}.${field.key}`;
      const value = field.key in values ? values[field.key] : defaultFor(field);
      const r = valueSchemaFor(field).safeParse(value);
      if (!r.success) {
        for (const i of r.error.issues) {
          issues.push({ path: [path, ...i.path].join("."), message: i.message });
        }
        continue;
      }
      out[field.key] = r.data;
      if (mode === "publish") issues.push(...requiredIssues(field, r.data, path));
    }
    content[section.id] = out;
  }
  return { ok: issues.length === 0, content, issues };
}

function coerceField(field: FieldDef, value: unknown): unknown {
  if (value === undefined) return defaultFor(field);
  const r = valueSchemaFor(field).safeParse(value);
  if (r.success) return r.data;
  if (field.type === "repeater" && Array.isArray(value)) {
    // Salvage the valid items rather than dropping the whole list.
    const items: unknown[] = [];
    for (const item of value.slice(0, field.maxItems)) {
      const one = valueSchemaFor({ ...field, maxItems: 1 }).safeParse([item]);
      if (one.success) items.push((one.data as unknown[])[0]);
    }
    return items;
  }
  return defaultFor(field);
}

/**
 * Never-throwing counterpart of `validateContent` for migration: keeps
 * every editable value that is still valid under `spec` and replaces the
 * rest with defaults. Used when a page moves to a newer template version.
 */
export function coerceContent(spec: TemplateSpec, raw: unknown): PageContent {
  const input = isPlainObject(raw) ? raw : {};
  const content: PageContent = {};
  for (const section of effectiveSections(spec)) {
    const values = isPlainObject(input[section.id]) ? (input[section.id] as Record<string, unknown>) : {};
    const out: SectionContent = {};
    for (const field of section.fields) {
      if (field.editable) out[field.key] = coerceField(field, values[field.key]);
    }
    content[section.id] = out;
  }
  return content;
}

/**
 * Render-time resolution: the complete value set every component reads,
 * locked fields included. Defensive by construction — content is
 * re-validated here even though the API validated it on write, so a
 * tampered database row still cannot reach a component unvalidated.
 */
export function resolveContent(spec: TemplateSpec, raw: unknown): PageContent {
  const input = isPlainObject(raw) ? raw : {};
  const content: PageContent = {};
  for (const section of effectiveSections(spec)) {
    const values = isPlainObject(input[section.id]) ? (input[section.id] as Record<string, unknown>) : {};
    const out: SectionContent = {};
    for (const field of section.fields) {
      out[field.key] = field.editable ? coerceField(field, values[field.key]) : defaultFor(field);
    }
    content[section.id] = out;
  }
  return content;
}

/** Stable JSON (sorted keys) — used to detect spec changes and compare values. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}
