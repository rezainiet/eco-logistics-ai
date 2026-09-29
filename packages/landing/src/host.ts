/**
 * Hostname and slug helpers — pure, dependency-free, shared by the API's
 * resolver and the public renderer's middleware so both sides agree
 * exactly on what a hostname means.
 *
 * The renderer never needs to know how DNS works. It receives a Host
 * header, normalises it here, extracts the page label, and asks the API
 * for the published page behind that label. Wildcard DNS, TLS and custom
 * domains are infrastructure that later simply makes more hostnames reach
 * the same code.
 */

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Labels no merchant may claim: infrastructure names, platform names,
 * well-known brands in our market that invite impersonation, and generic
 * trust words used in phishing.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // infrastructure
  "www", "app", "api", "admin", "administrator", "dashboard", "preview", "media",
  "cdn", "static", "assets", "img", "images", "files", "upload", "uploads",
  "status", "health", "metrics", "mail", "email", "smtp", "imap", "pop", "mx",
  "ns", "ns1", "ns2", "ns3", "dns", "ftp", "sftp", "ssh", "vpn", "git", "ci",
  "dev", "staging", "stage", "test", "testing", "qa", "demo", "sandbox", "beta",
  "internal", "local", "localhost", "root", "system", "sites", "site", "pages",
  "page", "web", "webhooks", "webhook", "track", "tracking", "auth", "oauth",
  "sso", "login", "logout", "signin", "signup", "register", "account",
  "accounts", "billing", "pay", "payment", "payments", "checkout", "invoice",
  "help", "support", "docs", "documentation", "blog", "news", "legal",
  "privacy", "terms", "security", "abuse", "postmaster", "hostmaster",
  "webmaster", "info", "contact", "about", "home", "index", "null", "undefined",
  // platform
  "confirmx", "confirm-x", "cordon", "ecom", "logistics",
  // brands / impersonation risk
  "bkash", "nagad", "rocket", "upay", "sslcommerz", "pathao", "steadfast",
  "redx", "paperfly", "ecourier", "sundarban", "daraz", "facebook", "fb",
  "meta", "instagram", "whatsapp", "messenger", "google", "gmail", "youtube",
  "tiktok", "shopify", "woocommerce", "stripe", "paypal", "apple", "microsoft",
  "amazon", "bank", "official", "verify", "verification", "secure",
]);

export type SlugCheck =
  | { ok: true; slug: string }
  | { ok: false; reason: "format" | "length" | "reserved"; message: string };

export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

export function validateSlug(input: string): SlugCheck {
  const slug = normalizeSlug(input);
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
    return { ok: false, reason: "length", message: `Use ${SLUG_MIN}–${SLUG_MAX} characters` };
  }
  // Double hyphens are refused outright: "xn--" is the punycode prefix used
  // for look-alike internationalised names.
  if (!SLUG_RE.test(slug) || slug.includes("--")) {
    return {
      ok: false,
      reason: "format",
      message: "Use lowercase letters, numbers and single hyphens; start and end with a letter or number",
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, reason: "reserved", message: "That name is reserved" };
  }
  return { ok: true, slug };
}

/**
 * Normalise a raw Host header: lowercase, strip port and trailing dot,
 * reject anything that is not a plain DNS name (IP literals, userinfo,
 * paths, whitespace, over-long labels). Returns `null` when unusable.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (!host || host.length > 260) return null;
  if (host.startsWith("[")) return null; // IPv6 literal
  const colon = host.indexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split(".");
  if (labels.some((l) => l.length === 0 || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) {
    return null;
  }
  if (/^[0-9.]+$/.test(host)) return null; // IPv4 literal
  return host;
}

/**
 * Extract the page label from a platform hostname, e.g.
 * `mybrand.pages.example` with root `pages.example` → `mybrand`.
 * Exactly one label below the root is accepted; the root itself, deeper
 * names, and invalid/reserved labels resolve to `null`.
 */
export function extractLandingLabel(host: string | null | undefined, rootDomain: string): string | null {
  const normalized = normalizeHost(host ?? null);
  const root = normalizeHost(rootDomain);
  if (!normalized || !root) return null;
  const suffix = `.${root}`;
  if (!normalized.endsWith(suffix)) return null;
  const label = normalized.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  const check = validateSlug(label);
  return check.ok ? check.slug : null;
}

/**
 * Public URL for a slug from a pattern such as `https://{slug}.pages.example`.
 * The pattern is operator configuration; the slug is validated first.
 */
export function landingPublicUrl(pattern: string | null | undefined, slug: string | null | undefined): string | null {
  if (!pattern || !slug || !validateSlug(slug).ok || !pattern.includes("{slug}")) return null;
  return pattern.replace("{slug}", slug);
}

/** Top-level names that never reach the public internet (and a few look-alike traps). */
const NON_PUBLIC_TLDS: ReadonlySet<string> = new Set(["localhost", "local", "internal", "intranet", "lan", "home", "corp", "arpa", "invalid", "onion", "test", "example"]);

/** Parent domains of the platform itself: never usable as a merchant's custom domain. */
export const PLATFORM_DOMAINS: readonly string[] = ["confirmx.ai"];

export type CustomDomainCheck =
  | { ok: true; hostname: string }
  | { ok: false; reason: "format" | "platform" | "not_public"; message: string };

/**
 * A merchant's own domain for one landing page (e.g. `shop.example.com` or
 * `example.com`). ASCII only — internationalised names must be entered in
 * their punycode (`xn--`) form. Never the platform's own domain or any name
 * under it (those are platform subdomains), never an IP, never a wildcard.
 * `opts.allowNonPublic` admits `.test`/`.localhost`-style names for local
 * development only.
 */
export function validateCustomDomain(
  raw: string | null | undefined,
  opts: { rootDomain?: string | null; allowNonPublic?: boolean } = {},
): CustomDomainCheck {
  const input = typeof raw === "string" ? raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  const bad = (message: string): CustomDomainCheck => ({ ok: false, reason: "format", message });
  if (!input) return bad("Enter a domain like shop.example.com");
  if (input.includes("*")) return bad("Wildcard domains are not supported");
  if (/[:/?#@\s]/.test(input)) return bad("Enter only the domain name — no https://, port or path");
  const host = normalizeHost(input);
  if (!host) return bad("That is not a valid domain name");
  const labels = host.split(".");
  if (labels.length < 2) return bad("Enter a full domain like shop.example.com");
  const tld = labels[labels.length - 1]!;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return bad("That is not a valid domain name");
  const platform = [...PLATFORM_DOMAINS, ...(opts.rootDomain ? [normalizeHost(opts.rootDomain)] : [])].filter((d): d is string => !!d);
  if (platform.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, reason: "platform", message: "That is a ConfirmX address — use the subdomain setting for it" };
  }
  if (!opts.allowNonPublic && NON_PUBLIC_TLDS.has(tld)) {
    return { ok: false, reason: "not_public", message: "Use a public domain you own" };
  }
  return { ok: true, hostname: host };
}
