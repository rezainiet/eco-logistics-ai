import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { InventoryMovement, LandingPageHost, Order, Product } from "@ecom/db";
import { env } from "../src/env.js";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { placeLandingOrder } from "../src/lib/commerce/landing-orders.js";
import { UNVERIFIED_CLAIM_TTL_MS, __setCustomDomainDepsForTests, applyHelperReport, desiredDomains, type DnsLookup } from "../src/lib/landing/custom-domains.js";
import { customDomainsInternalRouter, helperRequestAllowed } from "../src/server/custom-domains-internal.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Custom domain per landing page: add → DNS ownership (TXT) → routing →
 * certificate by the server helper → live. Tenant isolation, duplicate
 * prevention, resolution only when live, and the helper's internal API.
 */

const TOKEN = "t".repeat(48);
const IPV4 = "203.0.113.10";
const mutableEnv = env as unknown as Record<string, unknown>;

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), LandingPageHost.syncIndexes()]);
});
afterAll(disconnectDb);

/** Fake DNS: a zone map the tests edit. */
let zone: { txt: Record<string, string[][]>; a: Record<string, string[]>; cname: Record<string, string[]>; fail?: boolean };
const fakeDns: DnsLookup = {
  txt: async (n) => {
    if (zone.fail) throw Object.assign(new Error("boom"), { code: "EUNKNOWN" });
    return zone.txt[n] ?? [];
  },
  a: async (n) => zone.a[n] ?? [],
  cname: async (n) => zone.cname[n] ?? [],
};
let clock = new Date("2026-09-29T10:00:00Z");
const tick = (ms = 11_000) => (clock = new Date(clock.getTime() + ms));

beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
  zone = { txt: {}, a: {}, cname: {} };
  clock = new Date("2026-09-29T10:00:00Z");
  __setCustomDomainDepsForTests({ dns: fakeDns, targets: () => ({ ipv4: IPV4, cname: "domains.confirmx.ai" }), now: () => clock });
  mutableEnv.LANDING_CUSTOM_DOMAINS = "on";
  mutableEnv.CUSTOM_DOMAIN_HELPER_TOKEN = TOKEN;
});
afterEach(() => {
  __setCustomDomainDepsForTests(null);
  delete mutableEnv.LANDING_CUSTOM_DOMAINS;
  delete mutableEnv.CUSTOM_DOMAIN_HELPER_TOKEN;
});

async function shop(slug: string) {
  await ensureSystemTemplates();
  const merchant = await createMerchant({ email: `${slug}@shop.test` });
  const caller = callerFor(authUserFor(merchant));
  const shirt = await caller.products.create({ name: "Shirt", price: 1000, initialStock: 10 });
  const tpl = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
  const page = await caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
  const got = await caller.landingPages.get({ id: page.id });
  const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
  bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
  const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
  const linked = await caller.landingPages.setProducts({ id: page.id, expectedRevision: saved.page.draftRevision, products: [{ productId: shirt.id }] });
  await caller.landingPages.setSlug({ id: page.id, slug });
  await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
  return { merchant, caller, page, shirt };
}

/** Publishes the ownership TXT (and optionally the A record) for a domain. */
function publishDns(d: { hostname: string; records: Array<{ type: string; name: string; value: string }> }, opts: { routing?: boolean } = {}) {
  const txt = d.records.find((r) => r.type === "TXT")!;
  zone.txt[txt.name] = [[txt.value]];
  if (opts.routing) zone.a[d.hostname] = [IPV4];
}

const resolve = (host: string) => resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });

/** Walks a domain to live the way production does: check → helper report. */
async function goLive(s: Awaited<ReturnType<typeof shop>>, hostname: string) {
  const d = await s.caller.landingPages.addDomain({ id: s.page.id, hostname });
  publishDns(d, { routing: true });
  const c = await s.caller.landingPages.checkDomain({ domainId: d.id });
  expect(c.domain.status).toBe("ssl_pending");
  await applyHelperReport([{ hostname, outcome: "live", certExpiresAt: "2026-12-28T10:00:00Z" }]);
  return d;
}

async function internal(method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown, prefix = "/internal/custom-domains") {
  const app = express();
  app.use(express.json());
  app.use("/internal/custom-domains", customDomainsInternalRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((ok) => {
    const srv = app.listen(0, "127.0.0.1", () => ok(srv));
  });
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${prefix}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("custom domains — merchant flow", () => {
  it("adds a domain with DNS instructions (TXT ownership + routing record) and normalizes the name", async () => {
    const s = await shop("cd-add");
    const d = await s.caller.landingPages.addDomain({ id: s.page.id, hostname: "  https://Shop.Example.com/ " });
    expect(d).toMatchObject({ hostname: "shop.example.com", status: "pending_verification", url: null });
    const txt = d.records.find((r) => r.type === "TXT")!;
    expect(txt.name).toBe("_confirmx-verify.shop.example.com");
    expect(txt.value).toMatch(/^confirmx-verify=[0-9a-f]{32}$/);
    expect(d.records).toContainEqual(expect.objectContaining({ type: "CNAME", name: "shop.example.com", value: "domains.confirmx.ai" }));
    // An apex domain can't CNAME: A record instead.
    const s2 = await shop("cd-add-apex");
    const apex = await s2.caller.landingPages.addDomain({ id: s2.page.id, hostname: "example.org" });
    expect(apex.records.filter((r) => r.purpose === "routing")).toEqual([expect.objectContaining({ type: "A", value: IPV4 })]);
    const listed = await s.caller.landingPages.domains({ id: s.page.id });
    expect(listed).toMatchObject({ enabled: true, domains: [expect.objectContaining({ id: d.id })] });
  });

  it("refuses invalid, platform, IP and wildcard names", async () => {
    const s = await shop("cd-invalid");
    for (const bad of ["", "shop", "shop..com", "*.example.com", "127.0.0.1", "shop.example.com:8080", "shop.example.com/path", "confirmx.ai", "x.confirmx.ai", "mybrand.localhost", "-bad.example.com", "ex_ample.com", "шоп.рф"]) {
      await expect(s.caller.landingPages.addDomain({ id: s.page.id, hostname: bad }), bad).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await LandingPageHost.countDocuments({ kind: "custom_domain" })).toBe(0);
  });

  it("prevents duplicates: idempotent for the same page, refused elsewhere; one domain per page", async () => {
    const a = await shop("cd-dup-a");
    const b = await shop("cd-dup-b");
    const d = await a.caller.landingPages.addDomain({ id: a.page.id, hostname: "shop.example.com" });
    expect((await a.caller.landingPages.addDomain({ id: a.page.id, hostname: "SHOP.example.com" })).id).toBe(d.id);
    await expect(b.caller.landingPages.addDomain({ id: b.page.id, hostname: "shop.example.com" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(a.caller.landingPages.addDomain({ id: a.page.id, hostname: "other.example.com" })).rejects.toMatchObject({ code: "CONFLICT" });
    const page2 = await a.caller.landingPages.create({ templateId: (await a.caller.landingPages.templates())[0]!.id, name: "Second" });
    await expect(a.caller.landingPages.addDomain({ id: page2.id, hostname: "shop.example.com" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await LandingPageHost.countDocuments({ kind: "custom_domain" })).toBe(1);
  });

  it("an abandoned unverified claim can't block the real owner forever; a verified one can't be taken", async () => {
    const squatter = await shop("cd-squat");
    const owner = await shop("cd-owner");
    await squatter.caller.landingPages.addDomain({ id: squatter.page.id, hostname: "brand.example.com" });
    await expect(owner.caller.landingPages.addDomain({ id: owner.page.id, hostname: "brand.example.com" })).rejects.toMatchObject({ code: "CONFLICT" });
    await LandingPageHost.collection.updateOne({ hostname: "brand.example.com" }, { $set: { createdAt: new Date(clock.getTime() - UNVERIFIED_CLAIM_TTL_MS - 1000) } });
    const mine = await owner.caller.landingPages.addDomain({ id: owner.page.id, hostname: "brand.example.com" });
    expect(mine.status).toBe("pending_verification");
    expect((await squatter.caller.landingPages.domains({ id: squatter.page.id })).domains).toEqual([]);

    // Verified → never taken over, however old.
    publishDns(mine);
    await owner.caller.landingPages.checkDomain({ domainId: mine.id });
    await LandingPageHost.collection.updateOne({ hostname: "brand.example.com" }, { $set: { createdAt: new Date(0) } });
    await expect(squatter.caller.landingPages.addDomain({ id: squatter.page.id, hostname: "brand.example.com" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("verification: TXT missing → still required; wrong token → still required; TXT ok → verified; pointing here → SSL pending", async () => {
    const s = await shop("cd-verify");
    const d = await s.caller.landingPages.addDomain({ id: s.page.id, hostname: "shop.example.com" });

    let c = await s.caller.landingPages.checkDomain({ domainId: d.id });
    expect(c.domain.status).toBe("pending_verification");
    expect(c.message).toMatch(/TXT record was not found/);

    tick();
    zone.txt["_confirmx-verify.shop.example.com"] = [["confirmx-verify=not-the-token"]];
    c = await s.caller.landingPages.checkDomain({ domainId: d.id });
    expect(c.domain.status).toBe("pending_verification");

    // Checks are rate limited.
    await expect(s.caller.landingPages.checkDomain({ domainId: d.id })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    tick();
    publishDns(d);
    c = await s.caller.landingPages.checkDomain({ domainId: d.id });
    expect(c.domain).toMatchObject({ status: "verified", dnsPointsHere: false });
    expect(c.domain.verifiedAt).toBeTruthy();
    expect(c.message).toMatch(/point the domain/);

    tick();
    delete zone.txt["_confirmx-verify.shop.example.com"]; // TXT may be removed after verification
    zone.cname["shop.example.com"] = ["Domains.ConfirmX.ai."];
    c = await s.caller.landingPages.checkDomain({ domainId: d.id });
    expect(c.domain).toMatchObject({ status: "ssl_pending", dnsPointsHere: true, lastError: null });
  });

  it("DNS failures are reported without changing the status", async () => {
    const s = await shop("cd-dnsfail");
    const d = await s.caller.landingPages.addDomain({ id: s.page.id, hostname: "shop.example.com" });
    zone.fail = true;
    const c = await s.caller.landingPages.checkDomain({ domainId: d.id });
    expect(c.domain.status).toBe("pending_verification");
    expect(c.message).toMatch(/couldn't reach DNS/);
  });

  it("merchant isolation: another merchant can't see, check or remove the domain", async () => {
    const a = await shop("cd-iso-a");
    const b = await shop("cd-iso-b");
    const d = await a.caller.landingPages.addDomain({ id: a.page.id, hostname: "shop.example.com" });
    await expect(b.caller.landingPages.domains({ id: a.page.id })).resolves.toMatchObject({ domains: [] });
    await expect(b.caller.landingPages.checkDomain({ domainId: d.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.caller.landingPages.removeDomain({ domainId: d.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.caller.landingPages.addDomain({ id: a.page.id, hostname: "other.example.com" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await LandingPageHost.countDocuments({ kind: "custom_domain" })).toBe(1);
  });
});

describe("custom domains — routing", () => {
  it("serves the page only once live; the platform subdomain keeps working; checkout works on the custom host", async () => {
    const s = await shop("cd-route");
    const d = await s.caller.landingPages.addDomain({ id: s.page.id, hostname: "shop.example.com" });
    expect(await resolve("shop.example.com")).toEqual({ kind: "not_found" }); // pending
    publishDns(d, { routing: true });
    await s.caller.landingPages.checkDomain({ domainId: d.id });
    expect(await resolve("shop.example.com")).toEqual({ kind: "not_found" }); // ssl pending

    await applyHelperReport([{ hostname: "shop.example.com", outcome: "live", certExpiresAt: "2026-12-28T10:00:00Z" }]);
    const live = await resolve("shop.example.com");
    expect(live).toMatchObject({ kind: "ok", slug: "cd-route" });
    expect((await s.caller.landingPages.domains({ id: s.page.id })).domains[0]).toMatchObject({ status: "live", url: "https://shop.example.com" });
    expect(await resolve("cd-route.localhost")).toMatchObject({ kind: "ok", slug: "cd-route" });

    const r = await placeLandingOrder({
      host: "shop.example.com",
      locale: null,
      idempotencyKey: `cd-order-${Date.now()}-abcdef`,
      items: [{ productId: s.shirt.id, quantity: 1 }],
      customer: { name: "Rahim", phone: "01712345678", address: "House 1, Road 2", district: "Dhaka" },
      deliveryOptionId: live.kind === "ok" ? live.commerce!.delivery[0]!.id : null,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(String((await Order.findById(r.orderId).lean())!.merchantId)).toBe(String(s.merchant._id));
  });

  it("unpublish, removal, archive and the feature switch all take the custom host down", async () => {
    const s = await shop("cd-down");
    await goLive(s, "shop.example.com");
    expect(await resolve("shop.example.com")).toMatchObject({ kind: "ok" });

    mutableEnv.LANDING_CUSTOM_DOMAINS = "off";
    expect(await resolve("shop.example.com")).toEqual({ kind: "not_found" });
    expect(await resolve("cd-down.localhost")).toMatchObject({ kind: "ok" }); // platform host unaffected
    await expect(s.caller.landingPages.addDomain({ id: s.page.id, hostname: "x.example.com" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    mutableEnv.LANDING_CUSTOM_DOMAINS = "on";

    await s.caller.landingPages.unpublish({ id: s.page.id });
    expect(await resolve("shop.example.com")).toEqual({ kind: "not_found" });

    const [d] = (await s.caller.landingPages.domains({ id: s.page.id })).domains;
    await s.caller.landingPages.removeDomain({ domainId: d!.id });
    expect(await LandingPageHost.countDocuments({ kind: "custom_domain" })).toBe(0);
    expect((await desiredDomains()).domains).toEqual([]);

    const t = await shop("cd-archive");
    await goLive(t, "archive.example.com");
    await t.caller.landingPages.archive({ id: t.page.id });
    expect(await LandingPageHost.countDocuments({ hostname: "archive.example.com" })).toBe(0);
    expect(await resolve("archive.example.com")).toEqual({ kind: "not_found" });
  });

  it("a live domain of one merchant never resolves to another merchant's page", async () => {
    const a = await shop("cd-own-a");
    const b = await shop("cd-own-b");
    await goLive(a, "a-shop.example.com");
    await goLive(b, "b-shop.example.com");
    expect(await resolve("a-shop.example.com")).toMatchObject({ kind: "ok", slug: "cd-own-a" });
    expect(await resolve("b-shop.example.com")).toMatchObject({ kind: "ok", slug: "cd-own-b" });
  });
});

describe("custom domains — server helper contract", () => {
  it("desired list: issue for SSL pending, serve for live, hold otherwise", async () => {
    const s = await shop("cd-desired");
    await goLive(s, "live.example.com");
    const t = await shop("cd-desired-2");
    const p = await t.caller.landingPages.addDomain({ id: t.page.id, hostname: "pending.example.com" });
    const u = await shop("cd-desired-3");
    const q = await u.caller.landingPages.addDomain({ id: u.page.id, hostname: "issue.example.com" });
    publishDns(q, { routing: true });
    await u.caller.landingPages.checkDomain({ domainId: q.id });
    expect(p.status).toBe("pending_verification");
    expect(await desiredDomains()).toEqual({
      enabled: true,
      domains: [
        { hostname: "issue.example.com", action: "issue", issueAllowed: true },
        { hostname: "live.example.com", action: "serve", issueAllowed: true },
        { hostname: "pending.example.com", action: "hold", issueAllowed: true },
      ],
    });
  });

  it("reports: failure → Error with a safe message; retry after cooldown; a live domain stays live on renewal failure", async () => {
    const s = await shop("cd-report");
    const d = await s.caller.landingPages.addDomain({ id: s.page.id, hostname: "shop.example.com" });
    publishDns(d, { routing: true });
    await s.caller.landingPages.checkDomain({ domainId: d.id });
    const out = await applyHelperReport([
      { hostname: "shop.example.com", outcome: "failed", error: "rm -rf / $(evil) `x`" },
      { hostname: "not a host", outcome: "live" },
      { hostname: "unknown.example.com", outcome: "live" },
    ]);
    expect(out).toEqual({ applied: 1, ignored: 2 });
    let [row] = (await s.caller.landingPages.domains({ id: s.page.id })).domains;
    expect(row).toMatchObject({ status: "error", lastError: "The certificate could not be issued. Check the DNS records and try again." });

    tick();
    const early = await s.caller.landingPages.checkDomain({ domainId: d.id });
    expect(early.domain.status).toBe("error");
    expect(early.message).toMatch(/retry in about 15 minutes/);
    tick(16 * 60_000);
    expect((await s.caller.landingPages.checkDomain({ domainId: d.id })).domain.status).toBe("ssl_pending");

    await applyHelperReport([{ hostname: "shop.example.com", outcome: "live", certExpiresAt: "2026-12-28T10:00:00Z" }]);
    await applyHelperReport([{ hostname: "shop.example.com", outcome: "failed", error: "Certificate limit reached for this domain. Try again later." }]);
    [row] = (await s.caller.landingPages.domains({ id: s.page.id })).domains;
    expect(row).toMatchObject({ status: "live", lastError: "Certificate limit reached for this domain. Try again later." });
    expect(await resolve("shop.example.com")).toMatchObject({ kind: "ok" });
  });

  it("failed issuance backs off: no certbot per timer tick; retry after the cooldown; success clears the failure state", async () => {
    const s = await shop("cd-backoff");
    const d = await s.caller.landingPages.addDomain({ id: s.page.id, hostname: "shop.example.com" });
    publishDns(d, { routing: true });
    await s.caller.landingPages.checkDomain({ domainId: d.id });
    const entry = async () => (await desiredDomains()).domains.find((x) => x.hostname === "shop.example.com")!;
    expect(await entry()).toEqual({ hostname: "shop.example.com", action: "issue", issueAllowed: true });

    // First failure → Error, failure state persisted, helper told not to retry.
    await applyHelperReport([{ hostname: "shop.example.com", outcome: "failed", error: "Certificate limit reached for this domain. Try again later." }]);
    let row = (await LandingPageHost.findOne({ hostname: "shop.example.com" }).lean())!;
    expect(row.status).toBe("error");
    expect(row.customDomain).toMatchObject({ sslFailures: 1, sslFailedAt: clock });
    expect(await entry()).toMatchObject({ action: "hold", issueAllowed: false, retryAfter: new Date(clock.getTime() + 15 * 60_000).toISOString() });

    // Timer ticks during the cooldown: still not allowed; the merchant can't force it either.
    for (let i = 0; i < 5; i++) {
      tick(2 * 60_000);
      expect((await entry()).issueAllowed).toBe(false);
    }
    const early = await s.caller.landingPages.checkDomain({ domainId: d.id });
    expect(early.domain).toMatchObject({ status: "error" });
    expect(early.domain.sslRetryAt).not.toBeNull();

    // After the cooldown: the merchant's retry re-queues it and issuance is allowed.
    tick(6 * 60_000);
    expect((await s.caller.landingPages.checkDomain({ domainId: d.id })).domain.status).toBe("ssl_pending");
    expect(await entry()).toEqual({ hostname: "shop.example.com", action: "issue", issueAllowed: true });

    // Second consecutive failure → the wait doubles (30 min).
    const failedAt = clock;
    await applyHelperReport([{ hostname: "shop.example.com", outcome: "failed" }]);
    expect(await entry()).toMatchObject({ issueAllowed: false, retryAfter: new Date(failedAt.getTime() + 30 * 60_000).toISOString() });
    tick(31 * 60_000);
    expect((await s.caller.landingPages.checkDomain({ domainId: d.id })).domain.status).toBe("ssl_pending");

    // Success clears the failure state.
    await applyHelperReport([{ hostname: "shop.example.com", outcome: "live", certExpiresAt: "2026-12-28T10:00:00Z" }]);
    row = (await LandingPageHost.findOne({ hostname: "shop.example.com" }).lean())!;
    expect(row.status).toBe("live");
    expect(row.customDomain?.sslFailures).toBe(0);
    expect(row.customDomain?.sslFailedAt).toBeUndefined();
    expect(await entry()).toEqual({ hostname: "shop.example.com", action: "serve", issueAllowed: true });

    // A live domain whose re-issue fails keeps serving, but the helper backs off too.
    await applyHelperReport([{ hostname: "shop.example.com", outcome: "failed" }]);
    expect(await entry()).toMatchObject({ action: "serve", issueAllowed: false });
    expect(await resolve("shop.example.com")).toMatchObject({ kind: "ok" });

    // A "live" report DURING that backoff (an older certificate is still valid) must not reset it (Phase 3 L1).
    const before = (await LandingPageHost.findOne({ hostname: "shop.example.com" }).lean())!.customDomain!;
    const retryBefore = (await entry()).retryAfter;
    expect(before.sslFailures).toBe(1);
    for (let i = 0; i < 3; i++) {
      tick(2 * 60_000);
      await applyHelperReport([{ hostname: "shop.example.com", outcome: "live", certExpiresAt: "2026-12-28T10:00:00Z" }]);
    }
    const during = (await LandingPageHost.findOne({ hostname: "shop.example.com" }).lean())!;
    expect(during.status).toBe("live");
    expect(during.customDomain).toMatchObject({ sslFailures: 1, sslFailedAt: before.sslFailedAt });
    expect(during.customDomain?.lastError).toBeTruthy();
    expect(await entry()).toMatchObject({ action: "serve", issueAllowed: false, retryAfter: retryBefore });

    // Once the backoff is over, a live report is a success again and clears the failure state.
    tick(10 * 60_000);
    await applyHelperReport([{ hostname: "shop.example.com", outcome: "live", certExpiresAt: "2026-12-28T10:00:00Z" }]);
    const after = (await LandingPageHost.findOne({ hostname: "shop.example.com" }).lean())!.customDomain!;
    expect(after.sslFailures).toBe(0);
    expect(after.sslFailedAt).toBeUndefined();
    expect(after.lastError).toBeUndefined();
    expect(await entry()).toEqual({ hostname: "shop.example.com", action: "serve", issueAllowed: true });
  });

  it("internal endpoints: 404 without the token, through a proxy, or when unconfigured", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await internal("GET", "/desired", {})).status).toBe(404);
    expect((await internal("GET", "/desired", { authorization: `Bearer ${"x".repeat(48)}` })).status).toBe(404);
    expect((await internal("GET", "/desired", { ...auth, "x-forwarded-for": "198.51.100.7" })).status).toBe(404);
    expect((await internal("GET", "/desired", { ...auth, "x-real-ip": "198.51.100.7" })).status).toBe(404);
    const ok = await internal("GET", "/desired", auth);
    expect(ok).toMatchObject({ status: 200, body: { ok: true, enabled: true, domains: [] } });
    // Any other letter case is refused by the API too (Express mount paths are case-insensitive) — Phase 3 M2.
    for (const prefix of ["/INTERNAL/custom-domains", "/Internal/custom-domains", "/internal/Custom-Domains", "/iNtErNaL/custom-domains"]) {
      const r = await internal("GET", "/desired", auth, undefined, prefix);
      expect(r.status, prefix).toBe(404);
    }

    const s = await shop("cd-internal");
    const d = await s.caller.landingPages.addDomain({ id: s.page.id, hostname: "shop.example.com" });
    publishDns(d, { routing: true });
    await s.caller.landingPages.checkDomain({ domainId: d.id });
    const rep = await internal("POST", "/report", auth, { results: [{ hostname: "shop.example.com", outcome: "live" }] });
    expect(rep).toMatchObject({ status: 200, body: { ok: true, applied: 1 } });
    expect(await resolve("shop.example.com")).toMatchObject({ kind: "ok" });

    delete mutableEnv.CUSTOM_DOMAIN_HELPER_TOKEN;
    expect((await internal("GET", "/desired", auth)).status).toBe(404);
    // Non-loopback peers are refused even with the token.
    expect(helperRequestAllowed({ headers: auth, socket: { remoteAddress: "198.51.100.7" } } as never, TOKEN)).toBe(false);
    expect(helperRequestAllowed({ headers: auth, socket: { remoteAddress: "127.0.0.1" } } as never, TOKEN)).toBe(true);
  });
});
