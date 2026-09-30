import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLAN_TIERS, PLANS, listPlans } from "@ecom/types/plans";
import { PLAN_NAME, formatPlanPrice, planForMonthlyOrders, planOffers } from "./plan-pricing";
import { HomePricing } from "@/app/(marketing)/_components/home-pricing";
import { RoiCalculator } from "@/app/(marketing)/_components/roi-calculator";
import PricingPage from "@/app/pricing/page";
import { InlineLockedFeature, LockedFeature } from "@/components/billing/locked-feature";

/**
 * Audit F-01: the homepage and ROI calculator showed ৳1,990 / 4,990 / 12,990 /
 * "Custom" while billing charged from PLANS (৳999 / 2,499 / 5,999 / 14,999).
 * Every customer-facing price now renders from PLANS.
 */
const CONFIRMED = { starter: "৳999", growth: "৳2,499", scale: "৳5,999", enterprise: "৳14,999" } as const;
const OLD = ["1,990", "4,990", "12,990", "1990", "4990", "12990"];

const home = (signedIn = false) =>
  renderToStaticMarkup(<HomePricing signedIn={signedIn} brandName="ConfirmX" salesEmail="sales@example.test" />);
const pricing = () => renderToStaticMarkup(PricingPage());
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("canonical catalogue (PLANS) — the confirmed commercial prices", () => {
  it("prices are Starter ৳999, Growth ৳2,499, Pro ৳5,999, Enterprise ৳14,999", () => {
    expect(Object.fromEntries(listPlans().map((p) => [p.tier, formatPlanPrice(p.priceBDT)]))).toEqual(CONFIRMED);
  });

  it("display name → plan id → price: Starter/starter/৳999, Growth/growth/৳2,499, Pro/scale/৳5,999, Enterprise/enterprise/৳14,999", () => {
    expect(listPlans().map((p) => [p.name, p.tier, formatPlanPrice(p.priceBDT)])).toEqual([
      ["Starter", "starter", "৳999"],
      ["Growth", "growth", "৳2,499"],
      ["Pro", "scale", "৳5,999"],
      ["Enterprise", "enterprise", "৳14,999"],
    ]);
    // "Pro" is a display name only: the tier id stays `scale`; there is no `pro` plan.
    expect(PLANS.scale.name).toBe("Pro");
    expect(Object.keys(PLANS)).not.toContain("pro");
    expect(PLAN_NAME).toEqual({ starter: "Starter", growth: "Growth", scale: "Pro", enterprise: "Enterprise" });
  });

  it("plan ids/slugs and order are unchanged, and price rises with the tier", () => {
    expect(PLAN_TIERS).toEqual(["starter", "growth", "scale", "enterprise"]);
    expect(listPlans().map((p) => p.tier)).toEqual([...PLAN_TIERS]);
    expect(listPlans().map((p) => p.name)).toEqual(["Starter", "Growth", "Pro", "Enterprise"]);
    const prices = listPlans().map((p) => p.priceBDT);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it("entitlements the API enforces are unchanged (quotas, seats, integrations)", () => {
    expect(
      Object.fromEntries(
        listPlans().map((p) => [
          p.tier,
          [p.features.orderQuota, p.features.shipmentQuota, p.features.fraudReviewQuota, p.features.callMinutes, p.features.seats, p.features.courierLimit, p.features.maxIntegrations],
        ]),
      ),
    ).toEqual({
      starter: [300, 300, 0, 60, 1, 1, 1],
      growth: [1500, 1500, 500, 300, 3, 3, 1],
      scale: [6000, 6000, 2500, 1500, 10, 6, 5],
      enterprise: [50000, 50000, null, 10000, 50, 20, 50],
    });
  });
});

describe("formatPlanPrice — one currency format everywhere", () => {
  it("taka sign, no space, thousands grouped, no decimals", () => {
    expect(formatPlanPrice(999)).toBe("৳999");
    expect(formatPlanPrice(2499)).toBe("৳2,499");
    expect(formatPlanPrice(14999)).toBe("৳14,999");
  });
  it("does not depend on the visitor's locale (no Bengali digits, no lakh grouping)", () => {
    expect(formatPlanPrice(14999)).not.toMatch(/[০-৯]/);
    expect(formatPlanPrice(100000)).toBe("৳100,000");
  });
});

describe("homepage pricing cards", () => {
  it("render every canonical price, in catalogue order, with no old price", () => {
    const html = home();
    const at = listPlans().map((p) => html.indexOf(`>${formatPlanPrice(p.priceBDT)}<`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const old of OLD) expect(html).not.toContain(old);
    expect(html).not.toContain(">Custom<");
  });

  it("plan names are headings (h3 under the section's h2) and match PLANS; highlighter keys stay the plan names", () => {
    const html = home();
    expect([...html.matchAll(/<h3 class="tier">([^<·]+)/g)].map((m) => m[1]!.trim())).toEqual(["Starter", "Growth", "Pro", "Enterprise"]);
    expect([...html.matchAll(/data-plan="([^"]+)"/g)].map((m) => m[1])).toEqual(["Starter", "Growth", "Pro", "Enterprise"]);
  });

  it("order volumes quoted on the cards are the real quotas", () => {
    const t = text(home());
    for (const q of ["up to 300 orders", "up to 1,500 orders", "up to 6,000 orders", "up to 50,000 orders"]) expect(t).toContain(q);
  });

  it("CTA labels: trial for signed-out visitors, dashboard when signed in, sales for Enterprise", () => {
    const out = text(home(false));
    expect(out.match(/Start your 14-day trial/g)).toHaveLength(2);
    expect(out).toContain("Start saving today");
    expect(out).toContain("Talk to ConfirmX — Enterprise");
    const signedIn = text(home(true));
    expect(signedIn.match(/Open dashboard/g)).toHaveLength(3);
    expect(signedIn).not.toContain("Start your 14-day trial");
  });

  it("the JSON-LD offers carry the same prices, one per plan", () => {
    expect(planOffers("https://example.test/#pricing").map((o) => [o.name, o.price, o.priceCurrency])).toEqual([
      ["Starter", "999", "BDT"],
      ["Growth", "2499", "BDT"],
      ["Pro", "5999", "BDT"],
      ["Enterprise", "14999", "BDT"],
    ]);
  });
});

describe("ROI calculator — subscription price vs ROI assumptions", () => {
  it("recommends the cheapest plan whose real quota covers the volume", () => {
    expect([100, 300, 301, 1500, 1501, 6000, 6001, 50000, 60000].map((n) => planForMonthlyOrders(n).tier)).toEqual([
      "starter", "starter", "growth", "growth", "scale", "scale", "enterprise", "enterprise", "enterprise",
    ]);
  });

  it("shows the recommended plan at its canonical price (default 1,500 orders → Growth ৳2,499/mo)", () => {
    const t = text(renderToStaticMarkup(<RoiCalculator />));
    expect(t).toContain("Growth · up to 1,500 orders/mo · ৳2,499/mo");
    for (const old of OLD) expect(t).not.toContain(old);
    // 2,000 orders → the `scale` tier, displayed as Pro at ৳5,999.
    const pro = planForMonthlyOrders(2000);
    expect([pro.tier, pro.name, formatPlanPrice(pro.priceBDT)]).toEqual(["scale", "Pro", "৳5,999"]);
  });
});

describe("/pricing reads the same catalogue", () => {
  it("renders every canonical price in order with the plan slug on each CTA", () => {
    const html = pricing();
    const at = listPlans().map((p) => html.indexOf(formatPlanPrice(p.priceBDT)));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const tier of PLAN_TIERS) expect(html).toContain(`href="/signup?plan=${tier}"`);
    for (const old of OLD) expect(html).not.toContain(old);
  });

  it("shows plan names only — never the internal tier id as a label, nor 'Scale' as a name", () => {
    for (const html of [pricing(), home()]) {
      expect(html).not.toMatch(/>\s*scale\s*</i); // an element whose text is just the id (any case)
      expect(text(html)).not.toMatch(/\bScale\b/); // the old display name ("scale" as a verb in copy is fine)
    }
    expect(text(pricing())).toContain("Pro");
  });

  it("heading outline: h1, then an h2 before the plan-name h3s", () => {
    const tags = [...pricing().matchAll(/<(h[1-6])[\s>]/g)].map((m) => m[1]);
    expect(tags.slice(0, 6)).toEqual(["h1", "h2", "h3", "h3", "h3", "h3"]);
  });

  it("price-adjacent text meets AA: no faint (3.4:1) text in the plan cards; the homepage /mo unit uses text-2", () => {
    const cards = pricing().slice(pricing().indexOf('id="plans-heading"'), pricing().indexOf("What&#x27;s gated by tier"));
    expect(cards).not.toContain("text-fg-faint");
    const css = readFileSync(join(SRC, "app/(marketing)/landing.module.css"), "utf8");
    expect(css).toMatch(/:global\(\.price \.unit\) \{[^}]*color: var\(--c-text-2\)/);
  });

  it("homepage and /pricing show identical price strings for every plan", () => {
    const a = home();
    const b = pricing();
    for (const p of listPlans()) {
      expect(a).toContain(formatPlanPrice(p.priceBDT));
      expect(b).toContain(formatPlanPrice(p.priceBDT));
    }
  });
});

describe("upgrade prompts (LockedFeature / InlineLockedFeature)", () => {
  const tooltipText = (el: ReactElement) =>
    text(renderToStaticMarkup(<>{(el.props as { content: ReactElement }).content}</>));

  it("quote the required plan's canonical name and price", () => {
    for (const tier of ["growth", "scale", "enterprise"] as const) {
      const full = tooltipText(LockedFeature({ requiredTier: tier, locked: true, feature: "X", children: null }) as ReactElement);
      const inline = tooltipText(InlineLockedFeature({ requiredTier: tier, locked: true, feature: "X", children: null }) as ReactElement);
      expect(full).toContain(`X requires ${PLANS[tier].name}`);
      expect(full).toContain(`Upgrade for ${CONFIRMED[tier]} / mo`);
      expect(inline).toContain(`X · ${PLANS[tier].name}`);
      expect(inline).toContain(`Upgrade — ${CONFIRMED[tier]} / mo`);
    }
  });
});

// ── Source guard: no plan price is ever written as a literal ──────────────
const SRC = fileURLToPath(new URL("..", import.meta.url));
const CUSTOMER_FACING = [
  "app/(marketing)",
  "app/pricing",
  "app/(auth)",
  "app/payment-success",
  "app/payment-failed",
  "app/dashboard/settings/billing",
  "components/billing",
  "components/shell/cordon-auth-shell.tsx",
];
function files(p: string): string[] {
  const abs = join(SRC, p);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return /\.tsx?$/.test(abs) && !/\.test\.tsx?$/.test(abs) ? [abs] : [];
  return readdirSync(abs).flatMap((n) => files(join(p, n)));
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<![:"'`])\/\/.*$/gm, "");
const PRICE_VALUES = [...new Set([...listPlans().map((p) => p.priceBDT), 1990, 4990, 12990])];

describe("source guard — customer-facing pricing code never hard-codes a plan price", () => {
  const sources = CUSTOMER_FACING.flatMap(files).map((f) => ({
    rel: relative(SRC, f).replace(/\\/g, "/"),
    src: stripComments(readFileSync(f, "utf8")),
  }));

  it("covers the pricing surfaces", () => {
    const rels = sources.map((s) => s.rel);
    for (const f of [
      "app/(marketing)/page.tsx",
      "app/(marketing)/_components/home-pricing.tsx",
      "app/(marketing)/_components/roi-calculator.tsx",
      "app/pricing/page.tsx",
      "app/dashboard/settings/billing/page.tsx",
      "components/billing/locked-feature.tsx",
      "components/shell/cordon-auth-shell.tsx",
    ]) expect(rels).toContain(f);
  });

  it("no current or old plan price appears as a literal (e.g. 2499, 2,499, 4990)", () => {
    const offenders: string[] = [];
    for (const { rel, src } of sources) {
      for (const v of PRICE_VALUES) {
        const grouped = v.toLocaleString("en-US").replace(",", ",?");
        if (new RegExp(`(?<![\\d,.])${grouped}(?![\\d,.])`).test(src)) offenders.push(`${rel}: ${v}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no hard-coded ৳ amount per month (any value) — monthly prices come from formatPlanPrice", () => {
    const offenders = sources
      .filter(({ src }) => /৳\s?[\d,]+\s*(<[^>]*>\s*)*\/\s?(mo|month)\b/.test(src))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("plan prices go through the shared formatter (no ad-hoc priceBDT.toLocaleString())", () => {
    const offenders = sources.filter(({ src }) => /priceBDT\s*\)?\s*\.toLocaleString/.test(src)).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('no web source renders "Scale" as a plan name (tier `scale` is displayed as "Pro")', () => {
    const offenders = files("")
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => ({ rel: relative(SRC, f).split("\\").join("/"), src: stripComments(readFileSync(f, "utf8")) }))
      .filter(({ src }) => /["'`>]([^"'`<\n]*\s)?Scale\b(?!-)/.test(src))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("billing plan cards use the canonical formatter on catalogue data from the API, which returns listPlans()", () => {
    const billing = sources.find((s) => s.rel === "app/dashboard/settings/billing/page.tsx")!.src;
    expect(billing).toContain("trpc.billing.listPlans.useQuery()");
    expect(billing.match(/formatPlanPrice\((p|currentPlan)\.priceBDT\)/g)?.length).toBeGreaterThanOrEqual(3);
    // Payment history names the plan (Pro), not the stored tier id (scale).
    expect(billing).toContain("{PLAN_NAME[p.plan as PlanTier] ?? p.plan}");
    expect(billing).not.toMatch(/>\{p\.plan\}</);
    const api = readFileSync(join(SRC, "../../api/src/server/routers/billing.ts"), "utf8");
    expect(api).toMatch(/listPlans: protectedProcedure\.query\(\(\) => listPlans\(\)\)/);
  });
});
