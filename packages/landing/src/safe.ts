/**
 * Safety primitives for merchant-supplied landing-page content.
 *
 * Trust boundary: section components are trusted application code; every
 * value a merchant typed is untrusted data. Everything that turns untrusted
 * data into something the browser acts on (an href, a CSS custom property,
 * an image src) goes through a function in this file, and every function
 * here is deny-by-default — anything it does not positively recognise
 * comes back as `null`, and the caller renders nothing.
 *
 * No HTML is ever produced from merchant input. Rich text is a tiny,
 * line-oriented markup (see `parseRichText`) that becomes React elements,
 * never markup strings.
 */

/** C0/C1 control characters other than tab/newline/carriage return. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Bidi overrides and zero-width joiners used for spoofing. */
const SPOOF_CHARS = /[​-‏‪-‮⁦-⁩﻿]/g;

/** Strip characters that have no business in page copy. */
export function cleanText(value: string, opts: { multiline?: boolean } = {}): string {
  let out = value.replace(CONTROL_CHARS, "").replace(SPOOF_CHARS, "");
  out = out.replace(/\r\n?/g, "\n");
  if (!opts.multiline) out = out.replace(/\s*\n\s*/g, " ");
  return out;
}

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function safeColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value.toLowerCase() : null;
}

/** MongoDB ObjectId hex — the only shape an asset reference may take. */
export const ASSET_ID_RE = /^[a-f0-9]{24}$/;

export const PHONE_RE = /^\+?[0-9][0-9 ()-]{4,22}$/;
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-zA-Z0-9.-]{1,190}\.[a-zA-Z]{2,24}$/;
/** In-page anchor targets are section ids, which the template spec constrains the same way. */
export const SECTION_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "mailto:", "tel:"]);
const MAX_URL_LENGTH = 2000;

/**
 * Validate a merchant-supplied URL. Returns the normalised href or `null`.
 *
 * Accepts absolute http(s)/mailto/tel URLs and same-page `#section-id`
 * anchors. Rejects `javascript:`, `data:`, `vbscript:`, `file:`, protocol-
 * relative `//host`, embedded credentials, whitespace/control characters,
 * and anything the WHATWG URL parser will not parse.
 */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  // Any whitespace or control char inside a URL is either a mistake or an
  // obfuscation attempt ("java\tscript:"). Refuse rather than repair.
  if (/[\s\u0000-\u001F\u007F-\u009F]/.test(raw)) return null;
  if (raw.startsWith("#")) {
    return SECTION_ID_RE.test(raw.slice(1)) ? raw : null;
  }
  if (raw.startsWith("//") || raw.startsWith("\\")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (!url.hostname || url.username || url.password) return null;
  }
  return url.href;
}

export function isExternalHref(href: string): boolean {
  return href.startsWith("http:") || href.startsWith("https:");
}

export function phoneDigits(value: string): string {
  return value.replace(/[^0-9+]/g, "");
}

// ── Rich text ───────────────────────────────────────────────────────────────

export type RichInline = { text: string; bold?: boolean; italic?: boolean };
export type RichBlock =
  | { type: "paragraph"; children: RichInline[] }
  | { type: "list"; items: RichInline[][] };

/**
 * Parse the restricted rich-text format into a small AST.
 *
 *   - Blank lines separate paragraphs.
 *   - Lines starting with "- " or "* " form a bullet list.
 *   - **bold** and _italic_ inline marks. Nothing else.
 *
 * There are no links, headings, images or HTML in this format by design.
 * The output is data; the React layer maps it to elements, so a stored
 * "<script>" is rendered as the literal text "<script>".
 */
export function parseRichText(input: string, maxBlocks = 60): RichBlock[] {
  const text = cleanText(input, { multiline: true });
  const blocks: RichBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: "list", items: list.map(parseInline) });
      list = [];
    }
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!line) {
      flushParagraph();
      flushList();
    } else if (bullet) {
      flushParagraph();
      list.push(bullet[1] ?? "");
    } else {
      flushList();
      paragraph.push(line);
    }
    if (blocks.length >= maxBlocks) break;
  }
  flushParagraph();
  flushList();
  return blocks.slice(0, maxBlocks);
}

function parseInline(line: string): RichInline[] {
  const out: RichInline[] = [];
  const re = /\*\*([^*]+)\*\*|_([^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], italic: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}
