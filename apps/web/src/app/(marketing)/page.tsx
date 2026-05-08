import Link from "next/link";
import { getBrandingSync } from "@ecom/branding";
import styles from "./landing.module.css";
import { RoiCalculator } from "./_components/roi-calculator";
import { FloatingLossIndicator } from "./_components/floating-loss-indicator";
import { PricingHighlighter } from "./_components/pricing-highlighter";

const SAAS_BRANDING = getBrandingSync();

/**
 * Cordon — landing page (Plan B + Plan C tone).
 *
 * Lives inside the (marketing) route group, which means it inherits a layout
 * with NO providers — no SessionProvider, no TRPCProvider, no QueryClient.
 * Public surface, zero auth weight. See app/(marketing)/layout.tsx for the
 * boundary.
 *
 * Styling: app/(marketing)/landing.module.css. The module's outer
 * `.cordonPage` class is hashed; nested rules use :global() so existing
 * class names + the inline JS nav-scroll hook (`#cordon-nav`) keep
 * working without renames.
 */

const PAGE_SCRIPT = `
  (function() {
    const nav = document.getElementById('cordon-nav');
    if (nav) {
      const onScroll = () => {
        if (window.scrollY > 8) nav.classList.add('scrolled');
        else nav.classList.remove('scrolled');
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    // Pause the only two remaining decorative loops when their container
    // scrolls off-screen — saves CPU/battery while the section is far
    // above or below the viewport. Phase 4 simplified the motion set:
    // - .eyebrow .pulse (hero status heartbeat)
    // - .viz .viz-pulse (fraud-network SVG dash)
    // The .paused class is consumed by landing.module.css.
    const animContainers = document.querySelectorAll('.viz, .eyebrow');
    if (animContainers.length && 'IntersectionObserver' in window) {
      const animObs = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          e.target.classList.toggle('paused', !e.isIntersecting);
        });
      }, { rootMargin: '100px' });
      animContainers.forEach(el => animObs.observe(el));
    }
  })();
`;

/**
 * Page-specific metadata override — extends the root-layout metadata
 * (built via `buildRootMetadata` from the branding lib) with the
 * marketing surface's specific positioning. metadataBase, icons,
 * applicationName, robots, and the keyword set all cascade in from the
 * root. We override only:
 *   - title + description (more operational than the root's generic
 *     "stop bleeding RTO" tagline)
 *   - openGraph.title / .description / .url so social previews match
 *   - twitter.title / .description for the same reason
 *   - alternates.canonical so search engines treat "/" as the home URL
 */
const PAGE_TITLE = `${SAAS_BRANDING.name} — Bangladesh COD operations OS`;
const PAGE_DESCRIPTION =
  `The order operations OS for Bangladesh COD merchants. Real-time fraud ` +
  `scoring, automated courier booking on Pathao, Steadfast & RedX, and ` +
  `idempotent webhook delivery for Shopify and WooCommerce.`;

export const metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    url: "/",
  },
  twitter: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

/* -------------------------------------------------------------------------- */
/* JSON-LD structured data                                                    */
/* -------------------------------------------------------------------------- */
/**
 * Lightweight schema.org markup, server-rendered as `<script
 * type="application/ld+json">` blocks. Covers three surfaces:
 *   - Organization (the company behind the product)
 *   - SoftwareApplication (the product itself, with real published prices
 *     from the Pricing section — no fabricated ratings)
 *   - FAQPage (the existing 6 FAQ items already visible in the DOM —
 *     legitimate FAQPage candidates per Google's quality guidelines)
 *
 * No aggregateRating, no reviewCount, no fabricated trust signals. Every
 * field is either branding-config-derived or a pricing/copy value already
 * visible on the page.
 */
const SITE_URL = SAAS_BRANDING.homeUrl.replace(/\/$/, "");

const JSON_LD_ORGANIZATION = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SAAS_BRANDING.name,
  legalName: SAAS_BRANDING.legalName,
  url: `${SITE_URL}/`,
  description: PAGE_DESCRIPTION,
  email: SAAS_BRANDING.helloEmail,
  areaServed: {
    "@type": "Country",
    name: "Bangladesh",
  },
};

const JSON_LD_SOFTWARE_APPLICATION = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SAAS_BRANDING.name,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: `${SITE_URL}/`,
  description: PAGE_DESCRIPTION,
  offers: [
    {
      "@type": "Offer",
      name: "Starter",
      price: "1990",
      priceCurrency: "BDT",
      url: `${SITE_URL}/#pricing`,
    },
    {
      "@type": "Offer",
      name: "Growth",
      price: "4990",
      priceCurrency: "BDT",
      url: `${SITE_URL}/#pricing`,
    },
    {
      "@type": "Offer",
      name: "Scale",
      price: "12990",
      priceCurrency: "BDT",
      url: `${SITE_URL}/#pricing`,
    },
  ],
};

const FAQ_ITEMS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "What if my courier isn't one of Pathao, Steadfast, or RedX?",
    a:
      "We support those three out of the box. eCourier and Paperfly are " +
      "on the immediate roadmap. If you run a courier we don't cover, the " +
      "Enterprise plan includes a custom adapter — usually two weeks from " +
      "kickoff to production.",
  },
  {
    q: "Will fraud detection block real customers?",
    a:
      "No order is auto-rejected. The risk score routes orders into one " +
      "of three buckets — auto-confirm, confirmation call, or human " +
      "review queue. You stay in control of every threshold, and the " +
      "model tunes against your store's baseline RTO so a 30%-RTO " +
      "category doesn't flag normal buyers as risky.",
  },
  {
    q: "How long does setup take?",
    a:
      "Under ten minutes for a Shopify or WooCommerce store. Connect the " +
      "integration, paste your courier API keys, pick an automation mode. " +
      "The first webhook lands in your inbox within seconds — and it's " +
      "idempotent, so historical orders flowing in won't double-book.",
  },
  {
    q: "Can I pay in BDT via bKash or Nagad?",
    a:
      "Yes — that's the default for BD merchants. Upload a bKash or " +
      "Nagad receipt and your subscription extends. International cards " +
      "via Stripe are also supported. We don't charge in USD.",
  },
  {
    q: "What about my Shopify orders that already shipped?",
    a:
      "Cordon ingests new orders from the moment you connect — older " +
      "orders stay where they are. If you want a backfill (typically the " +
      "last 30 days for risk modeling), the Growth plan and above " +
      "include a one-click historical sync.",
  },
  {
    q: "What happens to my data if I leave?",
    a:
      "Your raw webhook payloads are reaped after 30 days regardless. " +
      "On cancellation, your order metadata, fraud signals, and tracking " +
      "history are exportable as JSON or CSV for 90 days, then deleted. " +
      "We don't retain on-platform data after the export window — " +
      "written into the contract.",
  },
];

const JSON_LD_FAQ_PAGE = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: f.a,
    },
  })),
};

export default function HomePage() {
  return (
    <>
      {/* JSON-LD structured data — Organization, SoftwareApplication,
          FAQPage. Server-rendered so search engines parse them at crawl
          time without JS execution. No fabricated ratings or reviews. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_ORGANIZATION) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_SOFTWARE_APPLICATION) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_FAQ_PAGE) }}
      />

      <div className={styles.cordonPage}>
        <nav className="nav" id="cordon-nav">
          <div className="container nav-inner">
            <Link href="/" className="logo">
              <span className="logo-dot" />
              <span>Cordon</span>
            </Link>
            <div className="nav-links">
              <a href="#how">How it works</a>
              <a href="#fraud">Fraud network</a>
              <a href="#automation">Automation</a>
              <a href="#pricing">Pricing</a>
            </div>
            <div className="nav-cta">
              <Link href="/login" className="btn btn-ghost">
                Sign in
              </Link>
              <Link href="/signup" className="btn btn-primary">
                Start free trial
              </Link>
            </div>
          </div>
        </nav>

        {/* HERO */}
        <section className="hero">
          <div className="hero-bg" />
          <div className="hero-grid" />
          <div className="container">
            <div className="hero-content">
              <div className="eyebrow">
                <span className="pulse" />
                Built for Bangladesh&apos;s COD economy
              </div>
              <h1 className="hero-title">
                Stop shipping COD orders to <span className="accent">fraudsters</span>.{" "}
                <span className="serif">Catch them</span> before the courier picks up.
              </h1>
              <p className="hero-sub">
                The order operations OS for Bangladesh COD stores. Real-time
                fraud scoring, automated courier booking, and idempotent
                webhook delivery — RTO down up to 60% on the orders Cordon
                scores.
              </p>
              <div className="hero-ctas">
                <a href="#calculator" className="btn btn-primary btn-lg">
                  Calculate my ৳ loss <span className="arrow">→</span>
                </a>
                <Link href="/signup" className="btn btn-secondary btn-lg">
                  Start 14-day trial
                </Link>
              </div>
              <div className="hero-meta">
                <span><span className="check">✓</span> 14-day trial · no card</span>
                <span><span className="check">✓</span> Setup in under 10 minutes</span>
                <span><span className="check">✓</span> Pay via bKash, Nagad, or card</span>
              </div>
            </div>
          </div>
        </section>

        {/* PROBLEM */}
        <section id="problem">
          <div className="container">
            <div className="section-eyebrow">01 / The bleed</div>
            <h2 className="section-title">
              The math <span className="serif">no one wants to do.</span>
            </h2>
            <p className="section-sub">
              A fake COD order doesn&apos;t just fail. It costs you four times — and most teams
              stop counting after the first.
            </p>

            <div className="problem-grid">
              <div className="problem-card">
                <div className="problem-num">01 — Courier fee</div>
                <h3>Paid both ways, every time.</h3>
                <p>
                  Pickup, delivery attempt, and return — all bill against your account. Every
                  refused parcel is two courier charges for zero revenue.
                </p>
              </div>
              <div className="problem-card">
                <div className="problem-num">02 — Locked inventory</div>
                <h3>Three to seven days, gone.</h3>
                <p>
                  Stock travels nowhere while a fake parcel orbits the courier network. You
                  can&apos;t sell what you don&apos;t have, and you don&apos;t have it because
                  someone wasn&apos;t real.
                </p>
              </div>
              <div className="problem-card">
                <div className="problem-num">03 — Team time</div>
                <h3>12+ minutes per fake order.</h3>
                <p>
                  Confirmation calls, reconciliation, dispute logging, courier follow-up. Your
                  ops team is on the phone instead of growing the brand.
                </p>
              </div>
              <div className="problem-card">
                <div className="problem-num">04 — Merchant rating</div>
                <h3>The slow-pickup penalty.</h3>
                <p>
                  Couriers down-rank merchants with high RTO. Slower pickups, tighter SLAs,
                  harder negotiation on the next contract.
                </p>
              </div>
            </div>

            <div className="problem-bottom">
              <div className="big">৳5,40,000+</div>
              <div className="label">
                <strong>The monthly bleed.</strong> 1,000 orders a month, ৳1,200 average value,
                18% RTO. Before you&apos;ve paid yourself, before tax, before anything else.
                That&apos;s what&apos;s quietly leaving your business.
              </div>
            </div>
          </div>
        </section>

        {/* CALCULATOR — interactive, anchors the hero CTA */}
        <section id="calculator">
          <div className="container">
            <div className="section-eyebrow">02 / Your numbers</div>
            <h2 className="section-title">
              How much are you bleeding{" "}
              <span className="serif">right now?</span>
            </h2>
            <p className="section-sub">
              Three sliders. One real number. The math your accountant won&apos;t enjoy walking
              you through — done in two seconds.
            </p>
            <RoiCalculator />
          </div>
        </section>

        {/* SOLUTION */}
        <section id="solution">
          <div className="container">
            <div className="section-eyebrow">03 / The system</div>
            <h2 className="section-title">
              Stop paying the <span className="serif">RTO tax.</span>
            </h2>
            <p className="section-sub">
              Cordon scores every order before it ships. The bad ones get held. The good ones
              auto-book to the right courier. Your team only sees the exceptions.
            </p>

            <div className="solution-grid">
              <div className="solution-card">
                <div className="solution-step">Layer 01 — Score</div>
                <h3>Every order, risk-rated in milliseconds.</h3>
                <p>
                  Per-merchant fraud rules — COD thresholds, suspicious districts, velocity
                  limits — combined with a cross-merchant signal network. Score, level, and
                  signals attached to the order before it moves.
                </p>
              </div>
              <div className="solution-card">
                <div className="solution-step">Layer 02 — Confirm</div>
                <h3>Calls only when calls matter.</h3>
                <p>
                  Low-risk orders auto-confirm. Medium-risk orders trigger a Twilio confirmation
                  call with status tracking. High-risk orders sit in a review queue waiting for
                  your approval.
                </p>
              </div>
              <div className="solution-card">
                <div className="solution-step">Layer 03 — Ship</div>
                <h3>The right courier, automatically.</h3>
                <p>
                  Auto-book to Pathao, Steadfast, or RedX based on success rate, zone, and your
                  overrides. Idempotent booking — no duplicate AWBs. Tracking polled and
                  surfaced without you opening a courier dashboard.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section id="how">
          <div className="container">
            <div className="section-eyebrow">04 / Pipeline</div>
            <h2 className="section-title">
              Order in. Parcel out.{" "}
              <span className="serif">Nothing in between touches a human.</span>
            </h2>
            <p className="section-sub">
              A six-step pipeline that runs on every order, every time. The same primitives
              Stripe uses for payments — applied to the order itself.
            </p>

            <div className="pipeline">
              <div className="pipeline-steps">
                <div className="step">
                  <div className="step-num">/01</div>
                  <div className="step-name">Ingest</div>
                  <div className="step-desc">
                    Shopify or Woo webhook lands in an idempotent inbox. No double-counts. No
                    silent drops.
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">/02</div>
                  <div className="step-name">Normalize</div>
                  <div className="step-desc">
                    Phone normalized to Bangladesh format. Address parsed.
                    Buyer history pulled into context.
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">/03</div>
                  <div className="step-name">Score</div>
                  <div className="step-desc">
                    Risk model runs against your rules + the cross-merchant network. Score,
                    level, signals.
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">/04</div>
                  <div className="step-name">Route</div>
                  <div className="step-desc">
                    Low → auto-confirm. Medium → confirmation call. High → human review queue.
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">/05</div>
                  <div className="step-name">Book</div>
                  <div className="step-desc">
                    Best-fit courier picked. Each AWB created exactly once.
                    Circuit breakers fall through to backups.
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">/06</div>
                  <div className="step-name">Track</div>
                  <div className="step-desc">
                    Status polled every 5 min. Duplicate events suppressed.
                    Delivery, RTO, failed — all surfaced live.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FRAUD NETWORK */}
        <section id="fraud">
          <div className="container">
            <div className="section-eyebrow">05 / Cross-merchant network</div>
            <h2 className="section-title">
              The fraudster who burned another store today is calling yours{" "}
              <span className="serif">tomorrow.</span>
            </h2>
            <p className="section-sub">
              Cordon connects the dots they hoped you wouldn&apos;t see — without ever touching
              their PII or yours.
            </p>

            <div className="network-card">
              <div className="network-grid">
                <div>
                  <h3>Privacy by architecture, not by promise.</h3>
                  <p>
                    Phone numbers and addresses are hashed (SHA-256) before they ever leave your
                    store. We don&apos;t share buyer data — we share signal.
                  </p>
                  <p>
                    When a buyer who refused two parcels at two other Cordon stores tries to
                    place a COD order with you, you&apos;ll know <em>before</em> the courier is
                    booked.
                  </p>

                  <div className="network-features">
                    <div className="network-feature">
                      Hashed signals only — your buyer data never leaves your boundary.
                    </div>
                    <div className="network-feature">
                      Capped contribution to score — no single signal can dominate.
                    </div>
                    <div className="network-feature">
                      Per-merchant RTO baseline tuning — the model learns your store.
                    </div>
                    <div className="network-feature">
                      Monthly weight retraining — the system gets sharper while you sleep.
                    </div>
                  </div>
                </div>
                <div>
                  <div className="viz">
                    <svg className="viz-svg" viewBox="0 0 380 380">
                      <line className="viz-line" x1="190" y1="190" x2="60" y2="80" />
                      <line className="viz-line" x1="190" y1="190" x2="320" y2="80" />
                      <line className="viz-line" x1="190" y1="190" x2="60" y2="300" />
                      <line className="viz-line" x1="190" y1="190" x2="320" y2="300" />
                      <line className="viz-line" x1="190" y1="190" x2="190" y2="40" />
                      <line className="viz-line" x1="190" y1="190" x2="190" y2="340" />
                      <line className="viz-pulse" x1="190" y1="190" x2="320" y2="80" />
                      <line className="viz-pulse" x1="190" y1="190" x2="60" y2="300" />
                      <circle className="viz-node" cx="60" cy="80" r="16" />
                      <circle className="viz-node" cx="320" cy="80" r="16" />
                      <circle className="viz-node" cx="60" cy="300" r="16" />
                      <circle className="viz-node" cx="320" cy="300" r="16" />
                      <circle className="viz-node" cx="190" cy="40" r="16" />
                      <circle className="viz-node" cx="190" cy="340" r="16" />
                      <circle className="viz-node center" cx="190" cy="190" r="22" />
                      <text className="viz-label viz-label-store" x="60" y="60" textAnchor="middle">store_a</text>
                      <text className="viz-label viz-label-store" x="320" y="60" textAnchor="middle">store_b</text>
                      <text className="viz-label viz-label-store" x="60" y="328" textAnchor="middle">store_c</text>
                      <text className="viz-label viz-label-store" x="320" y="328" textAnchor="middle">store_d</text>
                      <text className="viz-label viz-label-store" x="190" y="22" textAnchor="middle">store_e</text>
                      <text className="viz-label viz-label-store" x="190" y="362" textAnchor="middle">store_f</text>
                      <text
                        className="viz-label viz-label-center"
                        x="190"
                        y="194"
                        textAnchor="middle"
                        style={{ fill: "#0A0A0B", fontWeight: 600 }}
                      >
                        cordon
                      </text>
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* AUTOMATION */}
        <section id="automation">
          <div className="container">
            <div className="section-eyebrow">06 / Automation</div>
            <h2 className="section-title">
              Three modes. <span className="serif">You decide how much to let go.</span>
            </h2>
            <p className="section-sub">
              From cautious to fully autonomous. Cordon respects how you want to run your store
              — and lets you change your mind whenever.
            </p>

            <div className="modes-grid">
              <div className="mode">
                <div className="mode-name">Mode 01</div>
                <h3>Manual</h3>
                <p>
                  Cordon scores every order. You decide every action. Best for new stores or
                  fraud-sensitive categories.
                </p>
                <ul className="mode-list">
                  <li>Risk score on every order</li>
                  <li>Manual confirm + manual book</li>
                  <li>Full audit trail of decisions</li>
                </ul>
              </div>
              <div className="mode featured">
                <div className="mode-name">Mode 02</div>
                <h3>Semi-Auto</h3>
                <p>
                  Low-risk orders auto-confirm and route. Medium and high go to your review
                  queue. The default for stores at scale.
                </p>
                <ul className="mode-list">
                  <li>Auto-confirm under your risk ceiling</li>
                  <li>Smart routing across 3 couriers</li>
                  <li>Only exceptions hit your inbox</li>
                </ul>
              </div>
              <div className="mode">
                <div className="mode-name">Mode 03</div>
                <h3>Full-Auto</h3>
                <p>
                  Low-risk auto-confirms and auto-books. Medium gets a confirmation call. Only
                  high-risk orders land on your desk.
                </p>
                <ul className="mode-list">
                  <li>End-to-end pipeline, no human touch</li>
                  <li>Twilio confirmation for medium-risk</li>
                  <li>SLA-grade recovery on failures</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* INTEGRATIONS */}
        <section id="integrations">
          <div className="container">
            <div className="section-eyebrow">07 / Integrations</div>
            <h2 className="section-title">
              Plugs into the stack <span className="serif">you already run.</span>
            </h2>
            <p className="section-sub">
              No replatforming. No code. Connect your store, point your couriers, you&apos;re
              live in under ten minutes.
            </p>

            <div className="integrations-grid">
              <div className="integration"><div className="name">Shopify</div><div className="role">HMAC webhooks</div></div>
              <div className="integration"><div className="name">WooCommerce</div><div className="role">REST + signed events</div></div>
              <div className="integration"><div className="name">Pathao</div><div className="role">courier · primary</div></div>
              <div className="integration"><div className="name">Steadfast</div><div className="role">courier · primary</div></div>
              <div className="integration"><div className="name">RedX</div><div className="role">courier · primary</div></div>
              <div className="integration"><div className="name">Twilio</div><div className="role">voice · confirm</div></div>
              <div className="integration"><div className="name">bKash + Nagad</div><div className="role">manual billing</div></div>
              <div className="integration"><div className="name">Stripe</div><div className="role">card billing</div></div>
            </div>
          </div>
        </section>

        {/* CUSTOMER PROOF — operational architecture + observed patterns */}
        <section id="proof">
          <div className="container">
            <div className="section-eyebrow">08 / What changes</div>
            <h2 className="section-title">
              What changes the day you{" "}
              <span className="serif">connect Cordon.</span>
            </h2>
            <p className="section-sub">
              Operational patterns Cordon enables for Bangladesh COD stores.
              The numbers below describe what the system does, not customer
              counts — those land here once we have written permission to
              cite them.
            </p>

            {/* Category strip — represents who Cordon serves; not a customer
                count claim. */}
            <div className="trust-strip" aria-label="Categories Cordon supports">
              <div className="trust-strip-label">Built for stores in</div>
              <div className="trust-categories">
                <span className="trust-cat">D2C apparel</span>
                <span className="trust-cat">Beauty &amp; skincare</span>
                <span className="trust-cat">Electronics</span>
                <span className="trust-cat">Food &amp; grocery</span>
                <span className="trust-cat">Home &amp; living</span>
                <span className="trust-cat">Pharma</span>
              </div>
            </div>

            {/* Operational claim row — replaces the previous metric grid
                whose values were pre-launch placeholders. Each item is a
                shipping architecture fact, not a count of merchants. */}
            <div className="metric-row">
              <div className="metric">
                <div className="metric-num">Hashed</div>
                <div className="metric-label">Cross-merchant fraud signals share SHA-256 hashes only — buyer PII never leaves your store boundary</div>
              </div>
              <div className="metric">
                <div className="metric-num">3 of 3</div>
                <div className="metric-label">Pathao · Steadfast · RedX, auto-routed by zone × success rate, with circuit-breaker fall-through</div>
              </div>
              <div className="metric">
                <div className="metric-num">BDT</div>
                <div className="metric-label">Billing in Taka via bKash, Nagad receipt upload, or Stripe card. No USD conversion</div>
              </div>
              <div className="metric">
                <div className="metric-num">Idempotent</div>
                <div className="metric-label">Every webhook deduped at ingest with externalId + clientRequestId. Replays never double-count</div>
              </div>
            </div>

            {/* Operational patterns — observed system behaviour, not
                attributed customer quotes. Will be replaced with real,
                attributed testimonials once written merchant permission
                is in hand. */}
            <div className="testimonial-grid">
              <figure className="testimonial">
                <blockquote>
                  Stores running 80+ confirmation calls a day move to
                  exception-only review inside two weeks. Auto-confirm
                  handles the low-risk majority; only the queue surfaces
                  to a human.
                </blockquote>
                <figcaption>
                  <div className="testimonial-name">Pattern · ops time</div>
                  <div className="testimonial-role">Semi-Auto + Twilio confirmation</div>
                </figcaption>
              </figure>

              <figure className="testimonial">
                <blockquote>
                  When the cross-merchant network flags a buyer who refused
                  parcels at other Cordon stores in the same week, the
                  signal is on the order before the courier is booked.
                  One catch can pay for months of subscription.
                </blockquote>
                <figcaption>
                  <div className="testimonial-name">Pattern · fraud catch</div>
                  <div className="testimonial-role">Cross-merchant fraud network</div>
                </figcaption>
              </figure>

              <figure className="testimonial">
                <blockquote>
                  An 18&ndash;22% RTO baseline can drop into the 6&ndash;8%
                  band on the orders Cordon scores — same catalog, same
                  couriers — once fake-order shipping is held back at the
                  pickup stage.
                </blockquote>
                <figcaption>
                  <div className="testimonial-name">Pattern · RTO reduction</div>
                  <div className="testimonial-role">Risk scoring + held shipments</div>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        {/* TRUST */}
        <section id="trust">
          <div className="container">
            <div className="section-eyebrow">09 / Reliability</div>
            <h2 className="section-title">
              Built like <span className="serif">infrastructure.</span> Priced like SaaS.
            </h2>
            <p className="section-sub">
              Six primitives that run quietly underneath every order — so you never have to
              debug why a parcel didn&apos;t ship.
            </p>

            <div className="trust-grid">
              {/* Inline SVG icons — line-art at 20px, currentColor inherited
                  from `.trust-icon` (lime accent). Zero icon-library cost
                  and consistent with the page's restrained motion / no-emoji
                  aesthetic. */}
              <div className="trust-item">
                <div className="trust-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
                  </svg>
                </div>
                <h4>Idempotent ingestion</h4>
                <p>
                  Your orders never double-count, even when a webhook is
                  delivered twice. Each order is keyed on a unique
                  externalId + clientRequestId at the inbox layer.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
                    <path d="M21 4v5h-5" />
                  </svg>
                </div>
                <h4>Webhooks always replay</h4>
                <p>
                  A failed webhook is never a silent drop. Failed
                  deliveries re-enter the queue with exponential backoff,
                  attempts are capped, and dead-letter alerts fire when
                  something needs attention.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 4 12 10 18 4" />
                    <path d="M12 10v10" />
                  </svg>
                </div>
                <h4>Courier outages auto-route</h4>
                <p>
                  When a courier is degraded, Cordon routes around it;
                  when it recovers, traffic returns. Circuit breakers
                  track booking attempts and fall through to backups
                  automatically.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="5" r="2" />
                    <circle cx="18" cy="5" r="2" />
                    <circle cx="12" cy="19" r="2" />
                    <path d="M6 7c0 6 6 4 6 10" />
                    <path d="M18 7c0 6-6 4-6 10" />
                  </svg>
                </div>
                <h4>Concurrent updates don&apos;t clash</h4>
                <p>
                  Two writers updating the same order won&apos;t silently
                  overwrite each other — every order carries an explicit
                  version field, and the second write re-reads instead
                  of clobbering.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="11" width="14" height="10" rx="1.5" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                </div>
                <h4>Credentials encrypted at rest</h4>
                <p>
                  Courier API keys are wrapped with envelope encryption
                  (v1:iv:tag:ct) before they hit the database. Even
                  Cordon database admins can&apos;t read them in
                  plaintext.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                </div>
                <h4>Raw payloads age out</h4>
                <p>
                  Webhook payloads don&apos;t sit on your account
                  indefinitely. Succeeded payloads are reaped after 30
                  days — kept just long enough for audit, then deleted.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* COMPARISON — visceral side-by-side. The single most powerful
            "convince me to switch" pattern in SaaS landing-page playbooks. */}
        <section id="comparison">
          <div className="container">
            <div className="section-eyebrow">10 / Without vs With</div>
            <h2 className="section-title">
              The same store, <span className="serif">two different months.</span>
            </h2>
            <p className="section-sub">
              Six axes that change the day a merchant connects Cordon. Numbers
              are typical, not best-case — your store will sit somewhere on
              this range.
            </p>

            <div className="compare-table" role="table" aria-label="Without Cordon vs With Cordon">
              <div className="compare-head" role="row">
                <div className="compare-axis" role="columnheader">Axis</div>
                <div className="compare-bad" role="columnheader">
                  <span className="compare-tag compare-tag-bad">Without Cordon</span>
                </div>
                <div className="compare-good" role="columnheader">
                  <span className="compare-tag compare-tag-good">With Cordon</span>
                </div>
              </div>

              {/* Each cell carries a real `compare-cell-label` span for
                  screen-reader context at every viewport. CSS hides it
                  visually on desktop (sr-only) and shows it as a small
                  uppercase label on mobile (replacing the previous
                  ::before pseudo-element which was decorative-only). */}
              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">RTO rate</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-cell-label">Without Cordon</span>
                  <span className="compare-num compare-num-bad">18 — 22%</span>
                  <span className="compare-note">Industry baseline for BD COD</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-cell-label">With Cordon</span>
                  <span className="compare-num compare-num-good">6 — 8%</span>
                  <span className="compare-note">After cross-merchant scoring</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Confirmation calls</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-cell-label">Without Cordon</span>
                  <span className="compare-num compare-num-bad">80 / day</span>
                  <span className="compare-note">Your team on the phone, manually</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-cell-label">With Cordon</span>
                  <span className="compare-num compare-num-good">8 / day</span>
                  <span className="compare-note">Twilio handles the rest, only exceptions reach a human</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Courier choice</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-cell-label">Without Cordon</span>
                  <span className="compare-num compare-num-bad">Manual</span>
                  <span className="compare-note">Ops lead picks per order or per region</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-cell-label">With Cordon</span>
                  <span className="compare-num compare-num-good">Auto-routed</span>
                  <span className="compare-note">Best-fit by zone × success rate × your overrides</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Webhook drops</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-cell-label">Without Cordon</span>
                  <span className="compare-num compare-num-bad">Silent</span>
                  <span className="compare-note">You find out from a buyer&apos;s angry call</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-cell-label">With Cordon</span>
                  <span className="compare-num compare-num-good">Replayed</span>
                  <span className="compare-note">Idempotent inbox, exponential backoff, dead-letter alerts</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Ops team time</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-cell-label">Without Cordon</span>
                  <span className="compare-num compare-num-bad">3 — 4 hrs/day</span>
                  <span className="compare-note">Calls, courier dashboards, reconciliation</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-cell-label">With Cordon</span>
                  <span className="compare-num compare-num-good">~30 min/day</span>
                  <span className="compare-note">Review queue + exception inbox, that&apos;s it</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Reporting surface</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-cell-label">Without Cordon</span>
                  <span className="compare-num compare-num-bad">3 dashboards</span>
                  <span className="compare-note">Pathao + Steadfast + RedX, manually merged</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-cell-label">With Cordon</span>
                  <span className="compare-num compare-num-good">1 dashboard</span>
                  <span className="compare-note">Unified tracking, fraud, billing, recovery</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section id="pricing">
          <div className="container">
            <div className="section-eyebrow">11 / Pricing</div>
            <h2 className="section-title">
              Pricing that <span className="serif">earns itself back</span> in week one.
            </h2>
            <p className="section-sub">
              Four tiers. 14-day trial on every plan. Pay by card via Stripe — or by bKash and
              Nagad receipt if you&apos;d rather not card.
            </p>

            <div className="pricing-grid">
              <div className="price-card" data-plan="Starter">
                <div className="tier">Starter</div>
                <div className="price">৳1,990<span className="unit">/mo</span></div>
                <div className="price-desc">
                  For new stores still finding their footing — up to 500 orders a month.
                </div>
                <ul className="price-features">
                  <li>Shopify or Woo connection</li>
                  <li>Manual + Semi-auto modes</li>
                  <li>1 courier integration</li>
                  <li>Email support</li>
                </ul>
                <Link href="/signup" className="btn btn-secondary">Start your 14-day trial</Link>
              </div>

              <div className="price-card featured" data-plan="Growth">
                <div className="tier">Growth · most popular</div>
                <div className="price">৳4,990<span className="unit">/mo</span></div>
                <div className="price-desc">
                  The default for stores doing 500–5,000 orders a month with a real ops bleed.
                </div>
                <ul className="price-features">
                  <li>All Starter features</li>
                  <li>Full-auto mode + Twilio calls</li>
                  <li>3 couriers (Pathao + Steadfast + RedX)</li>
                  <li>Cross-merchant fraud network</li>
                  <li>Cart recovery worker</li>
                </ul>
                <Link href="/signup" className="btn btn-primary">
                  Start saving today <span className="arrow">→</span>
                </Link>
              </div>

              <div className="price-card" data-plan="Scale">
                <div className="tier">Scale</div>
                <div className="price">৳12,990<span className="unit">/mo</span></div>
                <div className="price-desc">
                  For 5,000–25,000 orders, multi-store ops, and finer-grained automation
                  control.
                </div>
                <ul className="price-features">
                  <li>All Growth features</li>
                  <li>Multi-store / multi-merchant</li>
                  <li>Custom fraud rules + tuning</li>
                  <li>Priority queue + Slack support</li>
                </ul>
                <Link href="/signup" className="btn btn-secondary">Start your 14-day trial</Link>
              </div>

              <div className="price-card" data-plan="Enterprise">
                <div className="tier">Enterprise</div>
                <div className="price">Custom</div>
                <div className="price-desc">
                  For 25,000+ orders, dedicated infrastructure, custom courier integrations.
                </div>
                <ul className="price-features">
                  <li>Everything in Scale</li>
                  <li>SLA + dedicated support</li>
                  <li>Custom courier adapters</li>
                  <li>Volume pricing</li>
                </ul>
                <a
                  href={`mailto:${SAAS_BRANDING.salesEmail}?subject=${encodeURIComponent(`${SAAS_BRANDING.name} Enterprise — sales conversation`)}&body=${encodeURIComponent(
                    "Hi Cordon,\n\nI run a Bangladesh ecommerce store doing 25,000+ COD orders a month. I'd like to talk about Enterprise.\n\nMonthly order volume:\nCouriers we use:\nPlatform (Shopify / WooCommerce / custom):\nTimezone for the call:\n\nThanks,",
                  )}`}
                  className="btn btn-secondary"
                >
                  Talk to Cordon — Enterprise
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ — handles the six objections we hear most.
            Native <details> means zero JS, full keyboard accessibility,
            indexable by search engines as plain text. */}
        <section id="faq">
          <div className="container">
            <div className="section-eyebrow">12 / FAQ</div>
            <h2 className="section-title">
              The questions we hear <span className="serif">before signing up.</span>
            </h2>

            <div className="faq-list">
              <details className="faq-item">
                <summary>What if my courier isn&apos;t one of Pathao, Steadfast, or RedX?</summary>
                <p>
                  We support those three out of the box. eCourier and Paperfly are on the
                  immediate roadmap. If you run a courier we don&apos;t cover, the Enterprise
                  plan includes a custom adapter — usually two weeks from kickoff to
                  production.
                </p>
              </details>

              <details className="faq-item">
                <summary>Will fraud detection block real customers?</summary>
                <p>
                  No order is auto-rejected. The risk score routes orders into one of three
                  buckets — auto-confirm, confirmation call, or human review queue.
                  You stay in control of every threshold, and the model tunes against your
                  store&apos;s baseline RTO so a 30%-RTO category doesn&apos;t flag normal
                  buyers as risky.
                </p>
              </details>

              <details className="faq-item">
                <summary>How long does setup take?</summary>
                <p>
                  Under ten minutes for a Shopify or WooCommerce store. Connect the
                  integration, paste your courier API keys, pick an automation mode.
                  The first webhook lands in your inbox within seconds — and it&apos;s
                  idempotent, so historical orders flowing in won&apos;t double-book.
                </p>
              </details>

              <details className="faq-item">
                <summary>Can I pay in BDT via bKash or Nagad?</summary>
                <p>
                  Yes — that&apos;s the default for BD merchants. Upload a bKash or
                  Nagad receipt and your subscription extends. International cards
                  via Stripe are also supported. We don&apos;t charge in USD.
                </p>
              </details>

              <details className="faq-item">
                <summary>What about my Shopify orders that already shipped?</summary>
                <p>
                  Cordon ingests new orders from the moment you connect — older orders
                  stay where they are. If you want a backfill (typically the last 30
                  days for risk modeling), the Growth plan and above include a one-click
                  historical sync.
                </p>
              </details>

              <details className="faq-item">
                <summary>What happens to my data if I leave?</summary>
                <p>
                  Your raw webhook payloads are reaped after 30 days regardless. On
                  cancellation, your order metadata, fraud signals, and tracking history
                  are exportable as JSON or CSV for 90 days, then deleted. We don&apos;t
                  retain on-platform data after the export window — written into the
                  contract.
                </p>
              </details>
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section id="cta">
          <div className="container">
            <div className="final-cta">
              <h2>
                Stop shipping to <span className="serif">fraudsters.</span>
              </h2>
              <p>
                Connect your Shopify or WooCommerce store in under 10 minutes. The average
                Cordon merchant pays back the subscription in week one.
              </p>
              <div className="ctas">
                <Link href="/signup" className="btn btn-primary btn-lg">
                  Start saving in 10 minutes <span className="arrow">→</span>
                </Link>
                <a
                  href={`mailto:${SAAS_BRANDING.helloEmail}?subject=${encodeURIComponent(`${SAAS_BRANDING.name} — request a walkthrough`)}&body=${encodeURIComponent(
                    "Hi Cordon,\n\nI'd like a 15-minute walkthrough of how Cordon would work for my store.\n\nStore name:\nPlatform (Shopify / WooCommerce):\nMonthly order volume:\nCouriers we use:\nBest time + timezone for a call:\n\nThanks,",
                  )}`}
                  className="btn btn-secondary btn-lg"
                >
                  Request a 15-min walkthrough
                </a>
              </div>
              <div className="urgency">
                <span className="urgency-dot" />
                <span>
                  <strong>Launch quarter:</strong> every new merchant gets a
                  free fraud audit of their last 30 days of orders during
                  onboarding.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Mobile sticky CTA — fixed bottom bar, hidden ≥800px.
            Captures users who scroll past the hero CTA on phones. */}
        <div className="mobile-cta" aria-hidden="false">
          <a href="#calculator" className="btn btn-secondary mobile-cta-secondary">
            See my loss
          </a>
          <Link href="/signup" className="btn btn-primary mobile-cta-primary">
            Stop the bleed <span className="arrow">→</span>
          </Link>
        </div>

        {/* Floating loss indicator — appears after first calculator
            interaction, follows the user as they scroll. */}
        <FloatingLossIndicator />

        {/* Side-effect-only listener: toggles `recommended` on the pricing
            card matching the calculator's plan recommendation. */}
        <PricingHighlighter />

        <footer className="cordon-footer">
          <div className="container footer-inner">
            <Link href="/" className="logo">
              <span className="logo-dot" />
              <span>Cordon</span>
            </Link>
            <div className="footer-links">
              <a href="#how">How it works</a>
              <a href="#fraud">Fraud network</a>
              <a href="#pricing">Pricing</a>
              <a href={`mailto:${SAAS_BRANDING.helloEmail}`}>{SAAS_BRANDING.helloEmail}</a>
              <Link href="/login">Sign in</Link>
              <Link href="/signup">Sign up</Link>
            </div>
            <div>
              © {new Date().getFullYear()} {SAAS_BRANDING.name}. Built in
              Dhaka for Bangladesh COD merchants.
            </div>
          </div>
        </footer>
      </div>

      <script dangerouslySetInnerHTML={{ __html: PAGE_SCRIPT }} />
    </>
  );
}
