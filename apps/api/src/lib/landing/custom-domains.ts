import { randomBytes } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { validateCustomDomain } from "@ecom/landing";
import { type CustomDomainStatus, LandingPage, LandingPageHost } from "@ecom/db";
import { env } from "../../env.js";
import { writeAudit } from "../audit.js";
import { customDomainsEnabled, invalidateCustomDomain, landingRootDomain } from "./resolve.js";
import type { Actor } from "./pages.js";

/**
 * Custom domain per landing page (V1: one domain → one published page).
 *
 * Lifecycle (LandingPageHost rows of kind "custom_domain"):
 *
 *   add ─► pending_verification ──TXT found──► verified ──DNS points here──► ssl_pending
 *                                                                                │
 *                          server helper issues the certificate + routes it ─────┤
 *                                                                                ▼
 *                                                                   live (served) / error
 *
 * - Ownership: TXT `_confirmx-verify.<hostname>` = `confirmx-verify=<token>`
 *   (token unique per claim). Nothing is served before it is proven.
 * - Routing + HTTPS are done by a tightly scoped root helper on the server
 *   (deploy/vps/custom-domains/), which PULLS the desired list from the
 *   internal endpoint below and REPORTS results back. The API never runs
 *   commands, never touches Nginx or certificates itself.
 * - Tenant isolation: every merchant call is scoped by merchantId from the
 *   session; a hostname belongs to at most one row (unique index), and an
 *   unverified claim cannot block the real owner forever (it expires).
 */

export const VERIFY_LABEL = "_confirmx-verify";
export const VERIFY_VALUE_PREFIX = "confirmx-verify=";
/** An unverified claim older than this can be taken over by someone who can prove ownership. */
export const UNVERIFIED_CLAIM_TTL_MS = 72 * 3600_000;
/** Minimum time between DNS checks of one domain. */
export const CHECK_COOLDOWN_MS = 10_000;
/**
 * Retry backoff after a failed certificate issuance (Let's Encrypt allows
 * only a few failed validations per hostname per hour): 15 min after the
 * first failure, doubling per consecutive failure, capped at 6 h. Applies
 * to the merchant's "Check DNS" retry AND to the helper (desired state says
 * `issueAllowed: false` until it passes). A success resets it.
 */
export const SSL_BACKOFF_BASE_MS = 15 * 60_000;
export const SSL_BACKOFF_MAX_MS = 6 * 3600_000;

export function sslRetryAt(cd: { sslFailures?: number | null; sslFailedAt?: Date | string | null } | null | undefined): Date | null {
  const failures = cd?.sslFailures ?? 0;
  if (!cd?.sslFailedAt || failures <= 0) return null;
  const wait = Math.min(SSL_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16), SSL_BACKOFF_MAX_MS);
  return new Date(new Date(cd.sslFailedAt).getTime() + wait);
}
export const MAX_DOMAINS_PER_MERCHANT = 20;

// ---- Injectable dependencies (DNS, targets, clock) -------------------------

export interface DnsLookup {
  txt(name: string): Promise<string[][]>;
  a(name: string): Promise<string[]>;
  cname(name: string): Promise<string[]>;
}

export interface DomainTargets {
  ipv4: string | null;
  cname: string | null;
}

const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND", "ESERVFAIL", "EREFUSED", "ETIMEOUT", "ECONNREFUSED", "ENONAME", "ENOTIMP"]);
const orEmpty = async <T>(p: Promise<T[]>): Promise<T[]> => {
  try {
    return await p;
  } catch (e) {
    if (NO_RECORDS.has((e as { code?: string }).code ?? "")) return [];
    throw e;
  }
};

const systemDns: DnsLookup = {
  txt: (n) => orEmpty(dnsPromises.resolveTxt(n)),
  a: (n) => orEmpty(dnsPromises.resolve4(n)),
  cname: (n) => orEmpty(dnsPromises.resolveCname(n)),
};

let deps: { dns: DnsLookup; targets: () => DomainTargets; now: () => Date } = {
  dns: systemDns,
  targets: () => ({
    ipv4: env.CUSTOM_DOMAIN_TARGET_IPV4 ?? null,
    cname: env.CUSTOM_DOMAIN_CNAME_TARGET ? env.CUSTOM_DOMAIN_CNAME_TARGET.toLowerCase().replace(/\.$/, "") : null,
  }),
  now: () => new Date(),
};
const defaults = { ...deps };

export function __setCustomDomainDepsForTests(patch: Partial<typeof deps> | null): void {
  deps = patch ? { ...deps, ...patch } : { ...defaults };
}

// ---- Views ------------------------------------------------------------------

type HostRow = {
  _id: Types.ObjectId;
  hostname: string;
  pageId: Types.ObjectId;
  merchantId: Types.ObjectId;
  status: string;
  createdAt?: Date;
  customDomain?: {
    verificationToken: string;
    verifiedAt?: Date | null;
    lastCheckedAt?: Date | null;
    dnsPointsHere?: boolean | null;
    sslRequestedAt?: Date | null;
    sslAttempts?: number | null;
    sslFailures?: number | null;
    sslFailedAt?: Date | null;
    liveAt?: Date | null;
    certExpiresAt?: Date | null;
    lastError?: string | null;
  } | null;
};

/** The DNS records the merchant adds at their DNS provider. */
export function dnsRecordsFor(hostname: string, token: string, targets: DomainTargets = deps.targets()) {
  const apex = hostname.split(".").length === 2;
  const records: Array<{ type: "TXT" | "A" | "CNAME"; name: string; value: string; purpose: "ownership" | "routing"; note?: string }> = [
    { type: "TXT", name: `${VERIFY_LABEL}.${hostname}`, value: `${VERIFY_VALUE_PREFIX}${token}`, purpose: "ownership" },
  ];
  if (targets.cname && !apex) {
    records.push({ type: "CNAME", name: hostname, value: targets.cname, purpose: "routing" });
    if (targets.ipv4) records.push({ type: "A", name: hostname, value: targets.ipv4, purpose: "routing", note: "Only if your DNS provider can't add the CNAME above." });
  } else if (targets.ipv4) {
    records.push({ type: "A", name: hostname, value: targets.ipv4, purpose: "routing" });
  }
  return records;
}

export function domainView(row: HostRow) {
  const cd = row.customDomain ?? { verificationToken: "" };
  return {
    id: String(row._id),
    hostname: row.hostname,
    pageId: String(row.pageId),
    status: row.status as CustomDomainStatus,
    url: row.status === "live" ? `https://${row.hostname}` : null,
    records: dnsRecordsFor(row.hostname, cd.verificationToken),
    routingConfigured: !!(deps.targets().ipv4 || deps.targets().cname),
    verifiedAt: cd.verifiedAt ?? null,
    dnsPointsHere: cd.dnsPointsHere ?? null,
    lastCheckedAt: cd.lastCheckedAt ?? null,
    liveAt: cd.liveAt ?? null,
    certExpiresAt: cd.certExpiresAt ?? null,
    lastError: cd.lastError ?? null,
    /** When a new certificate attempt is allowed again (null = now). */
    sslRetryAt: (() => {
      const at = sslRetryAt(cd);
      return at && at.getTime() > deps.now().getTime() ? at : null;
    })(),
    createdAt: row.createdAt ?? null,
  };
}
export type CustomDomainView = ReturnType<typeof domainView>;

function audit(actor: Actor, action: "landing.domain_added" | "landing.domain_verified" | "landing.domain_removed", pageId: Types.ObjectId, meta: Record<string, unknown>) {
  return writeAudit({
    merchantId: actor.merchantId,
    actorId: actor.actorId,
    actorEmail: actor.email,
    actorType: "merchant",
    action,
    subjectType: "landing_page",
    subjectId: pageId,
    meta,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
}

function assertEnabled() {
  if (!customDomainsEnabled()) throw new TRPCError({ code: "FORBIDDEN", message: "Custom domains are not available yet." });
}

const oid = (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
  return new Types.ObjectId(id);
};

const CUSTOM = { kind: "custom_domain" } as const;

// ---- Merchant operations ----------------------------------------------------

export async function listPageDomains(merchantId: Types.ObjectId, pageId: string) {
  const rows = await LandingPageHost.find({ merchantId, pageId: oid(pageId), ...CUSTOM }).sort({ createdAt: 1 }).lean();
  return { enabled: customDomainsEnabled(), domains: rows.map((r) => domainView(r as HostRow)) };
}

export async function addPageDomain(actor: Actor, pageId: string, rawHostname: string) {
  assertEnabled();
  const check = validateCustomDomain(rawHostname, { rootDomain: landingRootDomain(), allowNonPublic: env.NODE_ENV !== "production" });
  if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.message });
  const hostname = check.hostname;

  const page = await LandingPage.findOne({ _id: oid(pageId), merchantId: actor.merchantId }).select("status").lean();
  if (!page) throw new TRPCError({ code: "NOT_FOUND", message: "Page not found" });
  if (page.status === "archived") throw new TRPCError({ code: "BAD_REQUEST", message: "This page is archived." });

  const existing = await LandingPageHost.findOne({ hostname }).lean();
  if (existing) {
    const mine = String(existing.merchantId) === String(actor.merchantId);
    if (mine && String(existing.pageId) === String(page._id)) return domainView(existing as HostRow); // idempotent
    if (mine) throw new TRPCError({ code: "CONFLICT", message: "This domain is connected to another of your pages. Remove it there first." });
    const stale =
      existing.kind === "custom_domain" &&
      existing.status === "pending_verification" &&
      (existing.createdAt?.getTime() ?? 0) < deps.now().getTime() - UNVERIFIED_CLAIM_TTL_MS;
    if (!stale) throw new TRPCError({ code: "CONFLICT", message: "This domain is already connected to another account." });
    // An abandoned, never-verified claim: free the name (only if still exactly that).
    await LandingPageHost.deleteOne({ _id: existing._id, status: "pending_verification", "customDomain.verificationToken": existing.customDomain?.verificationToken });
  }

  // V1: one custom domain per page.
  if (await LandingPageHost.exists({ pageId: page._id, merchantId: actor.merchantId, ...CUSTOM })) {
    throw new TRPCError({ code: "CONFLICT", message: "This page already has a custom domain. Remove it to connect another." });
  }
  if ((await LandingPageHost.countDocuments({ merchantId: actor.merchantId, ...CUSTOM })) >= MAX_DOMAINS_PER_MERCHANT) {
    throw new TRPCError({ code: "FORBIDDEN", message: `You can connect up to ${MAX_DOMAINS_PER_MERCHANT} custom domains.` });
  }

  let row;
  try {
    row = await LandingPageHost.create({
      hostname,
      kind: "custom_domain",
      merchantId: actor.merchantId,
      pageId: page._id,
      status: "pending_verification",
      customDomain: { verificationToken: randomBytes(16).toString("hex"), sslAttempts: 0 },
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new TRPCError({ code: "CONFLICT", message: "This domain is already connected to another account." });
    throw e;
  }
  await audit(actor, "landing.domain_added", page._id, { hostname });
  return domainView(row.toObject() as HostRow);
}

/**
 * Merchant-triggered check: ownership TXT, then whether the domain points
 * at the platform. Moves the domain forward; never backwards (a verified
 * domain stays verified if the TXT record is later removed).
 */
export async function checkPageDomain(actor: Actor, domainId: string) {
  assertEnabled();
  const row = (await LandingPageHost.findOne({ _id: oid(domainId), merchantId: actor.merchantId, ...CUSTOM }).lean()) as HostRow | null;
  if (!row || !row.customDomain) throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });
  const now = deps.now();
  const cd = row.customDomain;
  if (cd.lastCheckedAt && now.getTime() - new Date(cd.lastCheckedAt).getTime() < CHECK_COOLDOWN_MS) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Checked a moment ago — try again in a few seconds." });
  }

  const hostname = row.hostname;
  let owned = !!cd.verifiedAt;
  let pointsHere = false;
  let dnsError: string | null = null;
  try {
    if (!owned) {
      const txt = await deps.dns.txt(`${VERIFY_LABEL}.${hostname}`);
      owned = txt.some((chunks) => chunks.join("").trim() === `${VERIFY_VALUE_PREFIX}${cd.verificationToken}`);
    }
    if (owned) {
      const t = deps.targets();
      const [a, cname] = await Promise.all([t.ipv4 ? deps.dns.a(hostname) : Promise.resolve([]), t.cname ? deps.dns.cname(hostname) : Promise.resolve([])]);
      pointsHere = (!!t.ipv4 && a.includes(t.ipv4)) || (!!t.cname && cname.some((c) => c.toLowerCase().replace(/\.$/, "") === t.cname));
    }
  } catch {
    dnsError = "We couldn't reach DNS for this domain right now. Try again in a minute.";
  }

  const set: Record<string, unknown> = { "customDomain.lastCheckedAt": now };
  let next: CustomDomainStatus = row.status as CustomDomainStatus;
  let message: string | null = dnsError;
  if (!dnsError) {
    if (!owned) {
      message = "The TXT record was not found yet. DNS changes can take up to a few hours.";
    } else {
      if (!cd.verifiedAt) set["customDomain.verifiedAt"] = now;
      set["customDomain.dnsPointsHere"] = pointsHere;
      if (row.status === "pending_verification") next = "verified";
      if (pointsHere && (next === "verified" || row.status === "error")) {
        const retryAt = sslRetryAt(cd);
        if (row.status === "error" && retryAt && now.getTime() < retryAt.getTime()) {
          const mins = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));
          message = `The last certificate attempt failed. You can retry in about ${mins} minute${mins === 1 ? "" : "s"}.`;
        } else {
          next = "ssl_pending";
          set["customDomain.sslRequestedAt"] = now;
        }
      } else if (!pointsHere && row.status !== "live") {
        message = deps.targets().ipv4 || deps.targets().cname ? "Ownership verified. Now point the domain to ConfirmX with the record below." : "Ownership verified. Routing details will be available soon.";
      } else if (!pointsHere && row.status === "live") {
        message = "Your domain no longer points to ConfirmX — visitors may not reach your page.";
      }
    }
  }
  set.status = next;
  if (message && next !== "ssl_pending") set["customDomain.lastError"] = message;
  const update: Record<string, unknown> = { $set: set };
  if (!message || next === "ssl_pending") update.$unset = { "customDomain.lastError": "" };
  if (next === "ssl_pending" && row.status !== "ssl_pending") update.$inc = { "customDomain.sslAttempts": 1 };

  // CAS on the status we read: a concurrent helper report or check wins.
  const updated = await LandingPageHost.findOneAndUpdate({ _id: row._id, merchantId: actor.merchantId, status: row.status }, update, { new: true }).lean();
  if (!updated) throw new TRPCError({ code: "CONFLICT", message: "The domain changed meanwhile — refresh and try again." });
  if (!cd.verifiedAt && owned) await audit(actor, "landing.domain_verified", row.pageId, { hostname });
  return { domain: domainView(updated as HostRow), message };
}

export async function removePageDomain(actor: Actor, domainId: string) {
  const row = await LandingPageHost.findOneAndDelete({ _id: oid(domainId), merchantId: actor.merchantId, ...CUSTOM }).lean();
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });
  await invalidateCustomDomain(row.hostname);
  await audit(actor, "landing.domain_removed", row.pageId, { hostname: row.hostname, status: row.status });
  return { removed: true as const };
}

// ---- Server helper contract (internal, token-authenticated) -----------------

/**
 * What the server should have. `issue`: obtain a certificate, then serve;
 * `serve`: keep serving (certificate exists, renewals by certbot.timer);
 * `hold`: known domain, not served — keep an existing certificate but no
 * routing. Domains absent from the list are removed by the helper (routing
 * and the certificates it manages).
 */
export async function desiredDomains() {
  const rows = await LandingPageHost.find({ ...CUSTOM }).select("hostname status customDomain.sslFailures customDomain.sslFailedAt").sort({ hostname: 1 }).lean();
  const now = deps.now().getTime();
  return {
    enabled: customDomainsEnabled(),
    domains: rows
      .filter((r) => validateCustomDomain(r.hostname, { rootDomain: landingRootDomain(), allowNonPublic: env.NODE_ENV !== "production" }).ok)
      .map((r) => {
        const retryAt = sslRetryAt(r.customDomain);
        const waiting = !!retryAt && retryAt.getTime() > now;
        return {
          hostname: r.hostname,
          action: (r.status === "ssl_pending" ? "issue" : r.status === "live" ? "serve" : "hold") as "issue" | "serve" | "hold",
          // Backoff after failed issuance: the helper must not call certbot yet.
          issueAllowed: !waiting,
          ...(waiting ? { retryAfter: retryAt!.toISOString() } : {}),
        };
      }),
  };
}

export interface HelperResult {
  hostname: string;
  outcome: "live" | "failed";
  error?: string;
  certExpiresAt?: string;
}

const SAFE_ERROR = /^[\w .,:;'()/@+=-]{1,300}$/;

/** Applies the helper's results. Only moves ssl_pending → live/error; a live domain stays live. */
export async function applyHelperReport(results: unknown): Promise<{ applied: number; ignored: number }> {
  if (!Array.isArray(results)) return { applied: 0, ignored: 0 };
  let applied = 0;
  let ignored = 0;
  const now = deps.now();
  for (const r of results.slice(0, 1000) as Array<Partial<HelperResult>>) {
    const check = validateCustomDomain(typeof r?.hostname === "string" ? r.hostname : "", { rootDomain: landingRootDomain(), allowNonPublic: env.NODE_ENV !== "production" });
    if (!check.ok || (r.outcome !== "live" && r.outcome !== "failed")) {
      ignored++;
      continue;
    }
    const expires = typeof r.certExpiresAt === "string" && !Number.isNaN(Date.parse(r.certExpiresAt)) ? new Date(r.certExpiresAt) : null;
    const error = typeof r.error === "string" && SAFE_ERROR.test(r.error) ? r.error : "The certificate could not be issued. Check the DNS records and try again.";
    let res;
    if (r.outcome === "live") {
      res = await LandingPageHost.updateOne(
        { hostname: check.hostname, ...CUSTOM, status: { $in: ["ssl_pending", "live"] } },
        [
          {
            $set: {
              status: "live",
              "customDomain.liveAt": { $ifNull: ["$customDomain.liveAt", now] },
              "customDomain.helperReportedAt": now,
              "customDomain.sslFailures": 0,
              ...(expires ? { "customDomain.certExpiresAt": expires } : {}),
            },
          },
          { $unset: ["customDomain.lastError", "customDomain.sslFailedAt"] },
        ],
      );
    } else {
      // Every failure starts / extends the backoff (see sslRetryAt).
      const failed = { $set: { "customDomain.lastError": error, "customDomain.helperReportedAt": now, "customDomain.sslFailedAt": now }, $inc: { "customDomain.sslFailures": 1 } };
      res = await LandingPageHost.updateOne({ hostname: check.hostname, ...CUSTOM, status: "ssl_pending" }, { ...failed, $set: { ...failed.$set, status: "error" } });
      if (!res.matchedCount) {
        // A live domain whose re-issue failed keeps serving its current certificate; just surface it.
        res = await LandingPageHost.updateOne({ hostname: check.hostname, ...CUSTOM, status: "live" }, failed);
      }
    }
    if (res.matchedCount) {
      applied++;
      await invalidateCustomDomain(check.hostname);
    } else {
      ignored++;
    }
  }
  return { applied, ignored };
}
