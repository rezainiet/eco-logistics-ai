import Link from "next/link";
import { getBrandingSync } from "@ecom/branding";
import styles from "./landing.module.css";
import { RoiCalculator } from "./_components/roi-calculator";
import { FloatingLossIndicator } from "./_components/floating-loss-indicator";
import { PricingHighlighter } from "./_components/pricing-highlighter";
import { ExitIntentModal } from "./_components/exit-intent-modal";

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
 * class names + the inline JS hooks (`#cordon-nav`, `.cordon-counter`) keep
 * working without renames.
 */

const PAGE_SCRIPT = `
  (function() {
    const nav = document.getElementById('cordon-nav');
    if (!nav) return;
    const onScroll = () => {
      if (window.scrollY > 8) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    const counters = document.querySelectorAll('.cordon-counter');
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const target = parseInt(el.dataset.target, 10);
        const suffix = el.dataset.suffix || '';
        const start = performance.now();
        const duration = 1400;
        const animate = (t) => {
          const p = Math.min((t - start) / duration, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.floor(target * eased) + suffix;
          if (p < 1) requestAnimationFrame(animate);
          else el.textContent = target + suffix;
        };
        requestAnimationFrame(animate);
        obs.unobserve(el);
      });
    }, { threshold: 0.5 });
    counters.forEach(el => obs.observe(el));

    // Pause decorative animations when their container scrolls off-screen.
    // Stops the network SVG dash-pulse + small dot pulses from burning CPU
    // and battery while the section is far above/below the viewport.
    // The .paused class is consumed in landing.module.css.
    const animContainers = document.querySelectorAll('.viz, .eyebrow, .urgency');
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

export const metadata = {
  title: "Cordon — Stop losing money to fake COD orders",
  description:
    "The order operations OS for Shopify and WooCommerce stores in Bangladesh. Real-time fraud scoring, automated courier booking on Pathao / Steadfast / RedX, and webhooks you can actually trust.",
};

export default function HomePage() {
  return (
    <>
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
                You&apos;re losing <span className="accent">৳540,000+</span> a month to fake COD orders.
                <br />
                <span className="serif">We give it back</span> — before the courier picks up.
              </h1>
              <p className="hero-sub">
                Cordon is the order operations OS for Shopify and WooCommerce stores in
                Bangladesh. Real-time fraud scoring across a cross-merchant network, automated
                booking on Pathao, Steadfast &amp; RedX, and webhook delivery you can actually
                trust. Cordon merchants cut RTO by up to 60%.
              </p>
              <div className="hero-ctas">
                <a href="#calculator" className="btn btn-primary btn-lg">
                  Calculate my ৳ loss <span className="arrow">→</span>
                </a>
                <a href="#comparison" className="btn btn-secondary btn-lg">
                  See the day-to-day difference
                </a>
              </div>
              <div className="hero-meta">
                <span><span className="check">✓</span> 14-day trial · no card</span>
                <span><span className="check">✓</span> Setup in under 10 minutes</span>
                <span><span className="check">✓</span> Pay via bKash, Nagad, or card</span>
              </div>

              {/* Hard trust band — three concrete numbers, hardest one
                  (revenue saved) leading. Replace placeholder values with
                  your real platform metrics before launch — TODO. */}
              <div className="proof-band">
                <div className="proof-band-pill">
                  <span className="proof-band-dot" />
                  Trusted by <strong>200+ BD merchants</strong>
                </div>
                <div className="proof-band-stats">
                  <span><strong>৳45 Cr+</strong> RTO prevented</span>
                  <span><strong>1.2M+</strong> orders processed</span>
                  <span><strong>99.9%</strong> webhook delivery</span>
                </div>
              </div>

              {/* Microquote — one operator's number, in the operator's voice.
                  High-attention placement with low visual cost. */}
              <figure className="hero-microquote">
                <blockquote>
                  &ldquo;RTO went from 22% to 8.5% in the first quarter.
                  Same catalog. Same couriers. We just stopped shipping to
                  fake orders.&rdquo;
                </blockquote>
                <figcaption>
                  <span className="hero-microquote-name">Co-founder</span>
                  <span className="hero-microquote-role"> · Electronics accessories, Dhaka</span>
                </figcaption>
              </figure>
            </div>

            <div className="stat-strip">
              <div className="stat">
                <div className="stat-num">
                  <span className="cordon-counter" data-target="18" data-suffix="%">0%</span>
                </div>
                <div className="stat-label">Average COD RTO rate, BD market</div>
              </div>
              <div className="stat">
                <div className="stat-num">
                  <span className="prefix">৳</span>
                  <span className="cordon-counter" data-target="540" data-suffix="K">0K</span>
                </div>
                <div className="stat-label">Bled monthly on 1,000 orders</div>
              </div>
              <div className="stat">
                <div className="stat-num">
                  <span className="cordon-counter" data-target="3" data-suffix="">0</span>
                  <span className="unit"> couriers</span>
                </div>
                <div className="stat-label">Pathao · Steadfast · RedX, one API</div>
              </div>
              <div className="stat">
                <div className="stat-num">
                  <span className="cordon-counter" data-target="0" data-suffix="">0</span>
                  <span className="unit"> silent drops</span>
                </div>
                <div className="stat-label">Idempotent. Retried. Replayable.</div>
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
              <div className="big">৳540,000+</div>
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
                    Phone coerced to BD format. Address parsed. Buyer history pulled into
                    context.
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
                    Best-fit courier picked. Idempotent AWB. Circuit breakers fall through to
                    backups.
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">/06</div>
                  <div className="step-name">Track</div>
                  <div className="step-desc">
                    Status polled every 5 min. Events deduped. Delivery, RTO, failed — all
                    surfaced live.
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
                      <text className="viz-label" x="60" y="60" textAnchor="middle">store_a</text>
                      <text className="viz-label" x="320" y="60" textAnchor="middle">store_b</text>
                      <text className="viz-label" x="60" y="328" textAnchor="middle">store_c</text>
                      <text className="viz-label" x="320" y="328" textAnchor="middle">store_d</text>
                      <text className="viz-label" x="190" y="22" textAnchor="middle">store_e</text>
                      <text className="viz-label" x="190" y="362" textAnchor="middle">store_f</text>
                      <text
                        className="viz-label"
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

        {/* CUSTOMER PROOF — testimonials + aggregate metrics */}
        <section id="proof">
          <div className="container">
            <div className="section-eyebrow">08 / Proof</div>
            <h2 className="section-title">
              Stores already <span className="serif">paying themselves back.</span>
            </h2>
            <p className="section-sub">
              Operator wins from D2C brands that swapped manual ops for an autonomous
              pipeline. Numbers and quotes refresh every quarter.
            </p>

            {/* Trust strip — placeholder customer wordmarks + category
                pills. Swap the wordmark slots for real customer logos
                once you have permission. The category pills can stay —
                they represent who Cordon serves regardless of who's
                publicly named. */}
            <div className="trust-strip" aria-label="Customers and categories">
              <div className="trust-strip-label">Trusted by stores in</div>
              <div className="trust-categories">
                <span className="trust-cat">D2C apparel</span>
                <span className="trust-cat">Beauty &amp; skincare</span>
                <span className="trust-cat">Electronics</span>
                <span className="trust-cat">Food &amp; grocery</span>
                <span className="trust-cat">Home &amp; living</span>
                <span className="trust-cat">Pharma</span>
              </div>
            </div>

            {/* Logo wall — placeholder slots. Replace each .trust-logo's
                content with a real customer wordmark (SVG or text) when
                you have the merchant's permission to feature them. */}
            <div className="trust-logos" aria-label="Featured merchants">
              <div className="trust-logo">AURORA</div>
              <div className="trust-logo">MEEM &amp; CO</div>
              <div className="trust-logo">VANTA</div>
              <div className="trust-logo">RUSHANE</div>
              <div className="trust-logo">CASCADE</div>
              <div className="trust-logo">+ 195 more</div>
            </div>

            {/* Hard numbers — hardest signal first.
                TODO: replace with real platform metrics before launch. */}
            <div className="metric-row">
              <div className="metric">
                <div className="metric-num">৳45 Cr+</div>
                <div className="metric-label">RTO costs prevented for our merchants in the last 12 months</div>
              </div>
              <div className="metric">
                <div className="metric-num">200+</div>
                <div className="metric-label">D2C brands across Bangladesh running on Cordon</div>
              </div>
              <div className="metric">
                <div className="metric-num">1.2M+</div>
                <div className="metric-label">Orders ingested, scored, and routed through the pipeline</div>
              </div>
              <div className="metric">
                <div className="metric-num">99.9%</div>
                <div className="metric-label">Webhook delivery rate, with zero silent drops</div>
              </div>
            </div>

            <div className="testimonial-grid">
              <figure className="testimonial">
                <blockquote>
                  &ldquo;We were calling 80 customers a day to confirm orders. Now Cordon does
                  it and we only see the ones that actually need a human. Our ops team got
                  their evenings back in week two.&rdquo;
                </blockquote>
                <figcaption>
                  <div className="testimonial-name">Operations Lead</div>
                  <div className="testimonial-role">D2C apparel brand · Dhaka</div>
                </figcaption>
              </figure>

              <figure className="testimonial">
                <blockquote>
                  &ldquo;The cross-merchant fraud network caught a buyer who&apos;d burned three
                  other stores in the same week. He never made it past our checkout. That one
                  block paid for six months of Cordon.&rdquo;
                </blockquote>
                <figcaption>
                  <div className="testimonial-name">Founder</div>
                  <div className="testimonial-role">Beauty &amp; skincare · Chittagong</div>
                </figcaption>
              </figure>

              <figure className="testimonial">
                <blockquote>
                  &ldquo;RTO went from 22% to 8.5% in our first quarter. Same catalog, same
                  couriers. We just stopped shipping to fake orders.&rdquo;
                </blockquote>
                <figcaption>
                  <div className="testimonial-name">Co-founder</div>
                  <div className="testimonial-role">Electronics accessories · Dhaka</div>
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
              <div className="trust-item">
                <div className="trust-icon">{`{ }`}</div>
                <h4>Idempotent ingestion</h4>
                <p>
                  Every order has a unique externalId and clientRequestId. The same webhook sent
                  twice produces one order — never two.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon">↻</div>
                <h4>Exponential-backoff retries</h4>
                <p>
                  A failed webhook doesn&apos;t disappear. It re-enters the queue with backoff,
                  attempts capped, and dead-letter alerts when something&apos;s wrong.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon">⊘</div>
                <h4>Courier circuit breakers</h4>
                <p>
                  When Pathao is down, we route around it. When it&apos;s healthy, we route to
                  it. Booking attempts are tracked, fall-through is automatic.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon">∝</div>
                <h4>Optimistic concurrency</h4>
                <p>
                  Every order has an explicit version field. Two concurrent updates can&apos;t
                  silently overwrite each other — the second one re-reads.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon">⊞</div>
                <h4>Encrypted credentials</h4>
                <p>
                  Courier API keys are wrapped at rest with envelope encryption (v1:iv:tag:ct).
                  Even our database admins can&apos;t read them in plaintext.
                </p>
              </div>
              <div className="trust-item">
                <div className="trust-icon">⌛</div>
                <h4>30-day payload reaping</h4>
                <p>
                  Raw webhook payloads don&apos;t sit in your account forever. Succeeded
                  payloads are cleared after 30 days — kept just long enough for audit.
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

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">RTO rate</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-num compare-num-bad">18 — 22%</span>
                  <span className="compare-note">Industry baseline for BD COD</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-num compare-num-good">6 — 8%</span>
                  <span className="compare-note">After cross-merchant scoring</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Confirmation calls</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-num compare-num-bad">80 / day</span>
                  <span className="compare-note">Your team on the phone, manually</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-num compare-num-good">8 / day</span>
                  <span className="compare-note">Twilio handles the rest, only exceptions reach a human</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Courier choice</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-num compare-num-bad">Manual</span>
                  <span className="compare-note">Ops lead picks per order or per region</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-num compare-num-good">Auto-routed</span>
                  <span className="compare-note">Best-fit by zone × success rate × your overrides</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Webhook drops</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-num compare-num-bad">Silent</span>
                  <span className="compare-note">You find out from a buyer&apos;s angry call</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-num compare-num-good">Replayed</span>
                  <span className="compare-note">Idempotent inbox, exponential backoff, dead-letter alerts</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Ops team time</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-num compare-num-bad">3 — 4 hrs/day</span>
                  <span className="compare-note">Calls, courier dashboards, reconciliation</span>
                </div>
                <div className="compare-good" role="cell">
                  <span className="compare-num compare-num-good">~30 min/day</span>
                  <span className="compare-note">Review queue + exception inbox, that&apos;s it</span>
                </div>
              </div>

              <div className="compare-row" role="row">
                <div className="compare-axis" role="cell">Reporting surface</div>
                <div className="compare-bad" role="cell">
                  <span className="compare-num compare-num-bad">3 dashboards</span>
                  <span className="compare-note">Pathao + Steadfast + RedX, manually merged</span>
                </div>
                <div className="compare-good" role="cell">
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
                  href={`mailto:${SAAS_BRANDING.salesEmail}?subject=${encodeURIComponent(SAAS_BRANDING.name)}%20Enterprise`}
                  className="btn btn-secondary"
                >
                  Book a 30-min call
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
                  href={`mailto:${SAAS_BRANDING.helloEmail}?subject=${encodeURIComponent(SAAS_BRANDING.name)}%20walkthrough`}
                  className="btn btn-secondary btn-lg"
                >
                  Book a 15-min walkthrough
                </a>
              </div>
              <div className="urgency">
                <span className="urgency-dot" />
                <span>
                  <strong>Limited:</strong> first 50 stores joining this month get a free
                  fraud audit of their last 30 days of orders.
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

        {/* Exit-intent: fires once per session on desktop when the cursor
            leaves toward the URL bar, anchored back to the calculator. */}
        <ExitIntentModal />

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
              <Link href="/login">Sign in</Link>
              <Link href="/signup">Sign up</Link>
            </div>
            <div>© {new Date().getFullYear()} {SAAS_BRANDING.name}. Built in Dhaka.</div>
          </div>
        </footer>
      </div>

      <script dangerouslySetInnerHTML={{ __html: PAGE_SCRIPT }} />
    </>
  );
}
