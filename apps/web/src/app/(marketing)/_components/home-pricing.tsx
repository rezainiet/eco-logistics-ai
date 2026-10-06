import Link from "next/link";
import { PLANS, listPlans, type PlanTier } from "@ecom/types/plans";
import { formatPlanPrice, formatPlanQuantity } from "@/lib/plan-pricing";

/**
 * Homepage pricing cards. Name, price, order quota and card order all come
 * from the canonical catalogue (PLANS — the same one the API bills from);
 * this file only holds presentation copy. Never put a price in COPY.
 */
const COPY: Record<PlanTier, { desc: (quota: string) => string; features: string[] }> = {
  starter: {
    desc: (q) => `For new stores still finding their footing — up to ${q} orders a month.`,
    features: ["Shopify or CSV import", "Manual + Semi-auto modes", "1 courier integration", "Email support"],
  },
  growth: {
    desc: (q) => `The default for stores doing up to ${q} orders a month with a real ops bleed.`,
    features: [
      "All Starter features",
      "Full-auto mode + auto-book",
      "WooCommerce connection",
      "3 couriers (Pathao + Steadfast + RedX)",
      "Cross-merchant signal network",
      "Cart recovery worker",
    ],
  },
  scale: {
    desc: (q) => `For up to ${q} orders a month, more live integrations, and finer-grained automation control.`,
    features: ["All Growth features", "Up to 5 live integrations + Custom API", "Custom verification rules + tuning", "Priority queue + Slack support"],
  },
  enterprise: {
    desc: (q) => `For up to ${q} orders a month, dedicated infrastructure, custom courier integrations.`,
    features: [`Everything in ${PLANS.scale.name}`, "SLA + dedicated support", "Custom courier adapters", "Volume pricing"],
  },
};

const FEATURED: PlanTier = "growth";

export function HomePricing({
  signedIn,
  brandName,
  salesEmail,
}: {
  signedIn: boolean;
  brandName: string;
  salesEmail: string;
}) {
  return (
    <div className="pricing-grid">
      {listPlans().map((plan) => {
        const featured = plan.tier === FEATURED;
        const copy = COPY[plan.tier];
        return (
          <div key={plan.tier} className={featured ? "price-card featured" : "price-card"} data-plan={plan.name}>
            <h3 className="tier">
              {plan.name}
              {featured ? " · most popular" : null}
            </h3>
            <div className="price">
              {formatPlanPrice(plan.priceBDT)}
              <span className="unit">/mo</span>
            </div>
            <div className="price-desc">{copy.desc(formatPlanQuantity(plan.features.orderQuota))}</div>
            <ul className="price-features">
              {copy.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {plan.tier === "enterprise" ? (
              <a
                href={`mailto:${salesEmail}?subject=${encodeURIComponent(`${brandName} Enterprise — sales conversation`)}&body=${encodeURIComponent(
                  "Hi ConfirmX,\n\nI run a Bangladesh ecommerce store and I'd like to talk about Enterprise.\n\nMonthly order volume:\nCouriers we use:\nPlatform (Shopify / WooCommerce / custom):\nTimezone for the call:\n\nThanks,",
                )}`}
                className="btn btn-secondary"
              >
                Talk to ConfirmX — Enterprise
              </a>
            ) : signedIn ? (
              <Link href="/dashboard" className={featured ? "btn btn-primary" : "btn btn-secondary"}>
                Open dashboard{featured ? <> <span className="arrow">→</span></> : null}
              </Link>
            ) : featured ? (
              <Link href="/signup" className="btn btn-primary">
                Start saving today <span className="arrow">→</span>
              </Link>
            ) : (
              <Link href="/signup" className="btn btn-secondary">
                Start your 14-day trial
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
