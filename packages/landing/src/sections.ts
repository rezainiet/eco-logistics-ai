import type { FieldDef } from "./fields.js";
import { NUMERAL_MODES } from "./format.js";
import { COMMERCE_SECTIONS } from "./sections-commerce.js";
import { FONT_OPTIONS, ICON_OPTIONS, SOCIAL_NETWORKS, cta, heading } from "./vocab.js";

/**
 * Section types — the building blocks a template composes.
 *
 * A section type is a trusted React component (see `react/sections/*`)
 * plus the field list below, which is the MAXIMUM set of values that
 * component reads. A template may lock, relabel, re-default or require
 * these fields, but it can never add a field a component does not know
 * about, and a merchant can never add a section type.
 *
 * `version` is the renderer contract. Changing what a component reads in a
 * backwards-incompatible way means registering `version: 2` alongside
 * version 1 — never editing version 1 — because published template
 * versions (and the pages pinned to them) reference `type@version`.
 */
export interface SectionTypeDef {
  type: string;
  version: number;
  label: string;
  description: string;
  /** Non-visual sections (theme, seo) render nothing themselves. */
  visual: boolean;
  fields: ReadonlyArray<FieldDef>;
}

export {
  ICON_NAMES,
  FONT_STACKS,
  FONT_KEYS,
  SOCIAL_NETWORKS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_OPTIONS,
  fontStack,
} from "./vocab.js";
export type { IconName, FontKey, PaymentMethod } from "./vocab.js";

const SECTION_LIST: SectionTypeDef[] = [
  {
    type: "theme",
    version: 1,
    label: "Colours & font",
    description: "Page-wide colours and typography.",
    visual: false,
    fields: [
      { key: "primary", type: "color", label: "Primary colour", default: "#4f46e5", required: true },
      { key: "onPrimary", type: "color", label: "Text on primary", default: "#ffffff", required: true },
      { key: "accent", type: "color", label: "Accent colour", default: "#f59e0b", required: true },
      { key: "background", type: "color", label: "Page background", default: "#ffffff", required: true },
      { key: "surface", type: "color", label: "Card background", default: "#f8fafc", required: true },
      { key: "text", type: "color", label: "Body text", default: "#0f172a", required: true },
      { key: "muted", type: "color", label: "Secondary text", default: "#475569", required: true },
      { key: "font", type: "select", label: "Font", options: FONT_OPTIONS, default: "system", required: true },
      {
        key: "radius",
        type: "select",
        label: "Corner style",
        options: [
          { value: "sharp", label: "Sharp" },
          { value: "soft", label: "Soft" },
          { value: "round", label: "Round" },
        ],
        default: "soft",
        required: true,
      },
      {
        key: "numerals",
        type: "select",
        label: "Numbers",
        help: "How prices and numbers are written. Auto uses Bangla digits (১২৩) on Bangla pages and 123 on English pages.",
        options: NUMERAL_MODES.map((m) => ({ value: m, label: m === "auto" ? "Auto (match language)" : m === "latin" ? "123" : "১২৩" })),
        default: "auto",
      },
    ],
  },
  {
    type: "seo",
    version: 1,
    label: "Search & sharing",
    description: "How the page appears in search results and when shared.",
    visual: false,
    fields: [
      { key: "title", type: "text", label: "Page title", maxLength: 70, help: "Shown in the browser tab and search results." },
      { key: "description", type: "textarea", label: "Meta description", maxLength: 160 },
      { key: "ogTitle", type: "text", label: "Social share title", maxLength: 90 },
      { key: "ogDescription", type: "textarea", label: "Social share description", maxLength: 200 },
      { key: "ogImage", type: "image", label: "Social share image" },
      { key: "favicon", type: "image", label: "Favicon" },
      { key: "noindex", type: "toggle", label: "Hide this page from search engines", default: false },
    ],
  },
  {
    type: "header",
    version: 1,
    label: "Header",
    description: "Top bar with logo, brand name and a call to action.",
    visual: true,
    fields: [
      { key: "logo", type: "image", label: "Logo" },
      { key: "brandName", type: "text", label: "Brand name", maxLength: 60, default: "Your Brand" },
      cta("cta", "Header button"),
      {
        key: "style",
        type: "select",
        label: "Style",
        options: [
          { value: "light", label: "Light" },
          { value: "transparent", label: "Transparent" },
          { value: "solid", label: "Solid primary" },
        ],
        default: "light",
      },
    ],
  },
  {
    type: "hero",
    version: 1,
    label: "Hero",
    description: "The first thing visitors see.",
    visual: true,
    fields: [
      {
        key: "variant",
        type: "select",
        label: "Layout",
        options: [
          { value: "centered", label: "Centered" },
          { value: "split", label: "Text + image" },
          { value: "banner", label: "Full-width image banner" },
        ],
        default: "centered",
      },
      { key: "eyebrow", type: "text", label: "Small label above the headline", maxLength: 60 },
      { key: "headline", type: "text", label: "Headline", maxLength: 120, required: true, default: "A headline that says what you offer" },
      { key: "subheadline", type: "textarea", label: "Supporting text", maxLength: 400 },
      cta("primaryCta", "Primary button"),
      cta("secondaryCta", "Secondary button"),
      { key: "image", type: "image", label: "Image" },
      {
        key: "badges",
        type: "repeater",
        label: "Trust badges",
        itemLabel: "Badge",
        maxItems: 4,
        itemFields: [
          { key: "icon", type: "select", label: "Icon", options: ICON_OPTIONS, default: "check" },
          { key: "text", type: "text", label: "Text", maxLength: 40, required: true },
        ],
      },
    ],
  },
  {
    type: "features",
    version: 1,
    label: "Features",
    description: "A grid of features, each with an icon.",
    visual: true,
    fields: [
      heading("Why customers choose us"),
      { key: "intro", type: "textarea", label: "Intro", maxLength: 400 },
      {
        key: "columns",
        type: "select",
        label: "Columns",
        options: [
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "4", label: "4" },
        ],
        default: "3",
      },
      {
        key: "style",
        type: "select",
        label: "Style",
        options: [
          { value: "cards", label: "Cards" },
          { value: "minimal", label: "Minimal" },
        ],
        default: "cards",
      },
      {
        key: "items",
        type: "repeater",
        label: "Features",
        itemLabel: "Feature",
        minItems: 1,
        maxItems: 12,
        itemFields: [
          { key: "icon", type: "select", label: "Icon", options: ICON_OPTIONS, default: "check" },
          { key: "title", type: "text", label: "Title", maxLength: 80, required: true },
          { key: "text", type: "textarea", label: "Description", maxLength: 300 },
        ],
      },
    ],
  },
  {
    type: "benefits",
    version: 1,
    label: "Benefits",
    description: "A checklist of benefits beside an image.",
    visual: true,
    fields: [
      heading("Made for everyday life"),
      { key: "body", type: "richtext", label: "Body", maxLength: 2000 },
      { key: "image", type: "image", label: "Image" },
      {
        key: "imageSide",
        type: "select",
        label: "Image position",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
        default: "right",
      },
      {
        key: "items",
        type: "repeater",
        label: "Benefits",
        itemLabel: "Benefit",
        maxItems: 10,
        itemFields: [
          { key: "title", type: "text", label: "Benefit", maxLength: 100, required: true },
          { key: "text", type: "text", label: "Detail", maxLength: 200 },
        ],
      },
      cta("cta", "Button"),
    ],
  },
  {
    type: "testimonials",
    version: 1,
    label: "Testimonials",
    description: "Customer quotes with optional star ratings.",
    visual: true,
    fields: [
      heading("What our customers say"),
      {
        key: "items",
        type: "repeater",
        label: "Testimonials",
        itemLabel: "Testimonial",
        minItems: 1,
        maxItems: 9,
        itemFields: [
          { key: "quote", type: "textarea", label: "Quote", maxLength: 500, required: true },
          { key: "name", type: "text", label: "Name", maxLength: 80, required: true },
          { key: "role", type: "text", label: "Location or role", maxLength: 80 },
          { key: "avatar", type: "image", label: "Photo" },
          {
            key: "rating",
            type: "select",
            label: "Rating",
            options: [
              { value: "5", label: "5 stars" },
              { value: "4", label: "4 stars" },
              { value: "3", label: "3 stars" },
              { value: "0", label: "No rating" },
            ],
            default: "5",
          },
        ],
      },
    ],
  },
  {
    type: "services",
    version: 1,
    label: "Services",
    description: "Service cards with optional price and image.",
    visual: true,
    fields: [
      heading("Our services"),
      { key: "intro", type: "textarea", label: "Intro", maxLength: 400 },
      {
        key: "items",
        type: "repeater",
        label: "Services",
        itemLabel: "Service",
        minItems: 1,
        maxItems: 12,
        itemFields: [
          { key: "title", type: "text", label: "Service", maxLength: 80, required: true },
          { key: "text", type: "textarea", label: "Description", maxLength: 300 },
          { key: "price", type: "text", label: "Price (optional)", maxLength: 40 },
          { key: "image", type: "image", label: "Image" },
        ],
      },
    ],
  },
  {
    type: "about",
    version: 1,
    label: "About",
    description: "Your story, with an image and headline numbers.",
    visual: true,
    fields: [
      heading("About us"),
      { key: "body", type: "richtext", label: "Story", maxLength: 3000 },
      { key: "image", type: "image", label: "Image" },
      {
        key: "stats",
        type: "repeater",
        label: "Numbers",
        itemLabel: "Number",
        maxItems: 4,
        itemFields: [
          { key: "value", type: "text", label: "Value", maxLength: 16, required: true },
          { key: "label", type: "text", label: "Label", maxLength: 40, required: true },
        ],
      },
    ],
  },
  {
    type: "faq",
    version: 1,
    label: "FAQ",
    description: "Questions and answers.",
    visual: true,
    fields: [
      heading("Frequently asked questions"),
      {
        key: "items",
        type: "repeater",
        label: "Questions",
        itemLabel: "Question",
        minItems: 1,
        maxItems: 15,
        itemFields: [
          { key: "question", type: "text", label: "Question", maxLength: 160, required: true },
          { key: "answer", type: "richtext", label: "Answer", maxLength: 1500, required: true },
        ],
      },
    ],
  },
  {
    type: "contact",
    version: 1,
    label: "Contact",
    description: "How to reach you: phone, WhatsApp, email, address, hours.",
    visual: true,
    fields: [
      heading("Get in touch"),
      { key: "text", type: "textarea", label: "Intro", maxLength: 400 },
      { key: "phone", type: "text", label: "Phone", maxLength: 30 },
      { key: "whatsapp", type: "text", label: "WhatsApp number", maxLength: 30 },
      { key: "email", type: "text", label: "Email", maxLength: 120 },
      { key: "address", type: "textarea", label: "Address", maxLength: 300 },
      { key: "hours", type: "textarea", label: "Opening hours", maxLength: 300 },
      cta("cta", "Button"),
    ],
  },
  {
    type: "cta",
    version: 1,
    label: "Call to action",
    description: "A focused prompt with one button.",
    visual: true,
    fields: [
      heading("Ready to get started?"),
      { key: "text", type: "textarea", label: "Text", maxLength: 300 },
      cta("cta", "Button"),
      {
        key: "style",
        type: "select",
        label: "Style",
        options: [
          { value: "band", label: "Full-width band" },
          { value: "card", label: "Card" },
        ],
        default: "band",
      },
    ],
  },
  {
    type: "footer",
    version: 1,
    label: "Footer",
    description: "Brand, links, social profiles and copyright.",
    visual: true,
    fields: [
      { key: "brandName", type: "text", label: "Brand name", maxLength: 60, default: "Your Brand" },
      { key: "tagline", type: "text", label: "Tagline", maxLength: 140 },
      {
        key: "links",
        type: "repeater",
        label: "Links",
        itemLabel: "Link",
        maxItems: 8,
        itemFields: [
          { key: "label", type: "text", label: "Label", maxLength: 40, required: true },
          { key: "url", type: "url", label: "URL", required: true },
        ],
      },
      {
        key: "socials",
        type: "repeater",
        label: "Social profiles",
        itemLabel: "Profile",
        maxItems: 7,
        itemFields: [
          { key: "network", type: "select", label: "Network", options: SOCIAL_NETWORKS, default: "facebook" },
          { key: "url", type: "url", label: "Profile URL", required: true },
        ],
      },
      { key: "copyright", type: "text", label: "Copyright line", maxLength: 120 },
    ],
  },
  ...COMMERCE_SECTIONS,
];

export const SECTION_TYPES: ReadonlyMap<string, SectionTypeDef> = new Map(
  SECTION_LIST.map((s) => [sectionTypeKey(s.type, s.version), s]),
);

export function sectionTypeKey(type: string, version: number): string {
  return `${type}@${version}`;
}

export function getSectionType(type: string, version: number): SectionTypeDef | undefined {
  return SECTION_TYPES.get(sectionTypeKey(type, version));
}

export function listSectionTypes(): SectionTypeDef[] {
  return [...SECTION_TYPES.values()];
}
