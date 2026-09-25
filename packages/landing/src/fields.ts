import { z } from "zod";
import {
  ASSET_ID_RE,
  EMAIL_RE,
  PHONE_RE,
  SECTION_ID_RE,
  cleanText,
  safeColor,
  safeUrl,
} from "./safe.js";

/**
 * Field definitions — the vocabulary a section type uses to declare what a
 * merchant may edit. Each field type has exactly one value schema (below),
 * shared by the dashboard editor, the API, and the public renderer.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "richtext",
  "color",
  "select",
  "toggle",
  "url",
  "image",
  "price",
  "cta",
  "repeater",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

interface FieldBase {
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  default?: unknown;
}

export type FieldDef =
  | (FieldBase & { type: "text"; maxLength?: number; placeholder?: string })
  | (FieldBase & { type: "textarea"; maxLength?: number; placeholder?: string })
  | (FieldBase & { type: "richtext"; maxLength?: number })
  | (FieldBase & { type: "color" })
  | (FieldBase & { type: "select"; options: ReadonlyArray<{ value: string; label: string }> })
  | (FieldBase & { type: "toggle" })
  | (FieldBase & { type: "url" })
  | (FieldBase & { type: "image" })
  /** A BDT amount (number). Rendered with the page's numeral setting via formatBDT. */
  | (FieldBase & { type: "price" })
  | (FieldBase & { type: "cta" })
  | (FieldBase & {
      type: "repeater";
      itemLabel: string;
      itemFields: ReadonlyArray<FieldDef>;
      minItems?: number;
      maxItems: number;
    });

// ── Value shapes ────────────────────────────────────────────────────────────

export interface ImageValue {
  assetId: string;
  alt: string;
}

/**
 * Call-to-action. The action is a closed, typed union — never a free-form
 * script or handler. Future kinds (contact form, callback request, click-to-
 * call through ConfirmX calling) extend this union; nothing else changes.
 */
export type CtaAction =
  | { kind: "none" }
  | { kind: "link"; url: string }
  | { kind: "phone"; phone: string }
  | { kind: "whatsapp"; phone: string; message?: string }
  | { kind: "email"; email: string }
  | { kind: "section"; sectionId: string };

export const CTA_ACTION_KINDS = ["none", "link", "phone", "whatsapp", "email", "section"] as const;

export interface CtaValue {
  label: string;
  action: CtaAction;
}

const DEFAULT_MAX: Record<"text" | "textarea" | "richtext", number> = {
  text: 160,
  textarea: 1200,
  richtext: 6000,
};

const singleLine = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((v) => cleanText(v).trim())
    .pipe(z.string().max(max, `Must be ${max} characters or fewer`));

const multiLine = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((v) => cleanText(v, { multiline: true }).trim())
    .pipe(z.string().max(max, `Must be ${max} characters or fewer`));

const urlValue = z
  .string()
  .max(2000)
  .transform((v) => v.trim())
  .refine((v) => v === "" || safeUrl(v) !== null, {
    message: "Must be an https://, http://, mailto: or tel: link, or a #section anchor",
  })
  .transform((v) => (v === "" ? "" : (safeUrl(v) as string)));

export const imageValueSchema = z
  .object({
    assetId: z.string().regex(ASSET_ID_RE, "Invalid image reference"),
    alt: singleLine(200).default(""),
  })
  .strict();

const phoneValue = z
  .string()
  .max(40)
  .transform((v) => v.trim())
  .refine((v) => PHONE_RE.test(v), "Enter a valid phone number");

export const ctaActionSchema: z.ZodType<CtaAction, z.ZodTypeDef, unknown> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("none") }).strict(),
    z
      .object({
        kind: z.literal("link"),
        url: z
          .string()
          .max(2000)
          .refine((v) => safeUrl(v) !== null, "Unsafe or invalid link")
          .transform((v) => safeUrl(v) as string),
      })
      .strict(),
    z.object({ kind: z.literal("phone"), phone: phoneValue }).strict(),
    z
      .object({
        kind: z.literal("whatsapp"),
        phone: phoneValue,
        message: singleLine(300).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("email"),
        email: z
          .string()
          .max(254)
          .transform((v) => v.trim())
          .refine((v) => EMAIL_RE.test(v), "Enter a valid email address"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("section"),
        sectionId: z.string().regex(SECTION_ID_RE, "Invalid section"),
      })
      .strict(),
  ],
) as unknown as z.ZodType<CtaAction, z.ZodTypeDef, unknown>;

export const ctaValueSchema = z
  .object({
    label: singleLine(60).default(""),
    action: ctaActionSchema,
  })
  .strict();

/**
 * Zod schema for a single field's value. `null`/`""`/`[]` are the "empty"
 * representations; `required` is enforced separately (see `isEmptyValue`)
 * so a draft may be saved half-finished while publish stays strict.
 */
export function valueSchemaFor(field: FieldDef): z.ZodTypeAny {
  switch (field.type) {
    case "text":
      return singleLine(field.maxLength ?? DEFAULT_MAX.text);
    case "textarea":
      return multiLine(field.maxLength ?? DEFAULT_MAX.textarea);
    case "richtext":
      return multiLine(field.maxLength ?? DEFAULT_MAX.richtext);
    case "color":
      return z
        .string()
        .refine((v) => safeColor(v) !== null, "Must be a #rrggbb colour")
        .transform((v) => (safeColor(v) as string));
    case "select": {
      const values = field.options.map((o) => o.value);
      return z.string().refine((v) => values.includes(v), "Not an allowed option");
    }
    case "toggle":
      return z.boolean();
    case "url":
      return urlValue;
    case "image":
      return imageValueSchema.nullable();
    case "price":
      return z
        .number({ invalid_type_error: "Enter a number" })
        .finite()
        .min(0, "Price cannot be negative")
        .max(100_000_000, "Price is too large")
        .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, "At most 2 decimal places")
        .nullable();
    case "cta":
      return ctaValueSchema;
    case "repeater": {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const f of field.itemFields) shape[f.key] = valueSchemaFor(f);
      return z.array(z.object(shape).strict()).max(field.maxItems, `At most ${field.maxItems} items`);
    }
  }
}

/** Empty value for a field type — what a new, blank field holds. */
export function emptyValueFor(field: FieldDef): unknown {
  switch (field.type) {
    case "text":
    case "textarea":
    case "richtext":
    case "url":
      return "";
    case "color":
      return "#000000";
    case "select":
      return field.options[0]?.value ?? "";
    case "toggle":
      return false;
    case "image":
    case "price":
      return null;
    case "cta":
      return { label: "", action: { kind: "none" } } satisfies CtaValue;
    case "repeater":
      return [];
  }
}

export function isEmptyValue(field: FieldDef, value: unknown): boolean {
  switch (field.type) {
    case "text":
    case "textarea":
    case "richtext":
    case "url":
      return typeof value !== "string" || value.trim() === "";
    case "image":
    case "price":
      return value == null;
    case "cta": {
      const v = value as CtaValue | undefined;
      return !v || !v.label?.trim() || v.action?.kind === "none";
    }
    case "repeater":
      return !Array.isArray(value) || value.length === 0;
    case "color":
    case "select":
    case "toggle":
      return value === undefined || value === null;
  }
}

/** Build a blank repeater item from its item fields' defaults. */
export function newRepeaterItem(field: Extract<FieldDef, { type: "repeater" }>): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const f of field.itemFields) item[f.key] = f.default !== undefined ? f.default : emptyValueFor(f);
  return item;
}
