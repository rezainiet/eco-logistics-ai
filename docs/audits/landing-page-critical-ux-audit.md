# Landing Page — Critical UX/UI Audit

**Live URL:** https://confirmx.ai/
**Source:** `apps/web/src/app/(marketing)/page.tsx` (1,057 LOC) + `landing.module.css` (1,487 LOC) + 4 client components
**Date:** 2026-05-08
**Posture:** **audit only.** No code changes proposed in this report. Recommendations are recorded for a follow-up redesign phase.

---

## 1. Executive summary

The landing page is well-engineered, copy-rich, and clearly the work of a careful operator. It carries 14 sections, three tiers of social proof, an interactive ROI calculator, three sticky/floating CTA surfaces, and a comprehensive FAQ. The visual system (charcoal background, lime accent `#C6F84F`, Inter + serif italic + mono monospace) is cohesive and on-brand for an "operations OS." Replay-safety, additive-only architecture, and reduced-motion handling are all in place at the code level.

**The strongest concerns are not visual, they are credibility.** The page asserts specific, hard numbers (`200+ BD merchants`, `৳45 Cr+ RTO prevented`, `1.2M+ orders`, `99.9% webhook delivery`) and renders five customer wordmarks (`AURORA`, `MEEM & CO`, `VANTA`, `RUSHANE`, `CASCADE`) with `+ 195 more`. **Every one of these is documented as a placeholder in the source code** ("TODO: replace with real platform metrics before launch"). Two operator quotes (one in the hero microquote, one in the testimonial grid) are byte-identical — same operator, same words, both labelled "Co-founder · Electronics accessories, Dhaka" — which a careful reader will spot. Once spotted, every other claim on the page is suspect. Before any redesign work, this credibility surface needs honest replacement.

**The second-strongest concern is hero overload.** The hero stacks NINE distinct content blocks (eyebrow, h1, sub, two CTAs, hero-meta, proof-band pill, proof-band stats, microquote, stat-strip). No single message lands. A merchant with 90 seconds will leave with a vague impression of "lots of numbers, lots of dark theme" rather than "this stops fake COD orders." The information is good, the order is wrong, and the density obscures the message.

**The third concern is mobile/responsiveness.** Most breakpoints are handled, but several specific surfaces degrade poorly: the hero `<br/>` forces awkward line breaks at narrow widths, the stat-strip's 4→2 column flip happens at 768px (still cramped at 540–767px), and three competing sticky/floating layers (mobile CTA bar, floating loss indicator, exit-intent modal) collectively claim significant viewport on small screens.

**Recommendation:** the page is structurally sound. A surgical fix-pass — credibility cleanup, hero compaction, mobile rhythm — buys 80% of the conversion lift without a redesign. A redesign should be deferred until real metrics + a real customer cohort can replace the placeholders.

---

## 2. Critical issues (P0 — block production confidence)

### C1. Placeholder metrics shown as real data

**Where:** Hero proof-band (`page.tsx:145-155`), Proof section metric-row (`page.tsx:597-614`).

The four headline numbers are TODO'd in the source:

```js
// page.tsx:142-144
{/* Hard trust band — three concrete numbers, hardest one
    (revenue saved) leading. Replace placeholder values with
    your real platform metrics before launch — TODO. */}
```

```js
// page.tsx:595-596
{/* Hard numbers — hardest signal first.
    TODO: replace with real platform metrics before launch. */}
```

The placeholder values in production:

- "Trusted by **200+ BD merchants**"
- "**৳45 Cr+** RTO prevented"
- "**1.2M+** orders processed"
- "**99.9%** webhook delivery"

Three of these appear **twice** on the same page (hero proof-band + Proof metric-row). The repetition makes them the strongest claims on the page. If they are not real, the page is misleading, not aspirational. **Severity: cannot ship to a press release or paid-ads campaign without correcting.**

### C2. Placeholder customer wordmarks shown as logo wall

**Where:** Proof section (`page.tsx:586-593`).

```jsx
<div className="trust-logo">AURORA</div>
<div className="trust-logo">MEEM &amp; CO</div>
<div className="trust-logo">VANTA</div>
<div className="trust-logo">RUSHANE</div>
<div className="trust-logo">CASCADE</div>
<div className="trust-logo">+ 195 more</div>
```

```js
// page.tsx:583-586
{/* Logo wall — placeholder slots. Replace each .trust-logo's
    content with a real customer wordmark (SVG or text) when
    you have the merchant's permission to feature them. */}
```

Five fictional brand names rendered as a logo wall implies real customer endorsements. The "+ 195 more" treatment makes them feel like sampled tip-of-iceberg. A merchant who Googles any of those names (`AURORA Bangladesh`, `VANTA Dhaka`, etc.) will not find a customer match. **Until real logos with permission are live, this section should either be removed or replaced with category cards (which already exist in `.trust-categories`).**

### C3. Duplicate fabricated testimonial

**Where:** Hero microquote (`page.tsx:159-169`) and Proof testimonial #3 (`page.tsx:641-650`).

The same quote appears twice with the same attribution:

> "RTO went from 22% to 8.5% in [the/our] first quarter. Same catalog, [s/]ame couriers. We just stopped shipping to fake orders." — Co-founder · Electronics accessories · Dhaka

This is internally inconsistent on the page — and reads to a critical observer as a single fabricated testimonial duplicated to fill space. Either pick one location, or use two distinct quotes from real operators.

### C4. Hero overload — 9 stacked content blocks

**Where:** Hero section (`page.tsx:107-202`).

The hero contains, in order:

1. Eyebrow ("Built for Bangladesh's COD economy" with pulse)
2. H1 (two-line, with hard `<br/>` break)
3. Sub paragraph (4 visual lines on desktop, more on mobile)
4. Two CTAs (calc + comparison)
5. Hero-meta (3 checkmark items)
6. Proof-band pill ("Trusted by 200+ BD merchants")
7. Proof-band stats (3 numbers in mono)
8. Hero-microquote (italic blockquote + figcaption)
9. Stat-strip (4-column data display, animated counters)

A focused hero usually has 3–4 elements: eyebrow, headline, sub, primary CTA. Nine elements means no single message dominates. The eye gets tired before reaching the calculator section. The microquote + stat-strip should both move out of the hero.

### C5. Hero h1 forced `<br/>` causes inconsistent line breaks

**Where:** `page.tsx:117-121`.

```jsx
<h1 className="hero-title">
  You&apos;re losing <span className="accent">৳540,000+</span> a month to fake COD orders.
  <br />
  <span className="serif">We give it back</span> — before the courier picks up.
</h1>
```

`<br/>` is hard-coded, but the surrounding text uses `clamp(40px, 6vw, 76px)` so the natural wrap point varies. At very narrow viewports the line above the `<br/>` already wraps to 3+ lines on its own, then the forced break creates a 4th near-orphaned line. A `<wbr>`, soft-hyphen approach, or simply allowing natural wrap would be safer.

---

## 3. High-priority issues (P1)

### H1. The "৳540,000+" hero number is a generic illustration, not the visitor's loss

**Where:** Hero h1 (`page.tsx:118`) and Problem section (`page.tsx:253-258`).

The hero asserts "**You're** losing ৳540,000+ a month." The Problem section then reveals this is illustrative: "1,000 orders a month, ৳1,200 average value, 18% RTO." A merchant with 200 orders/mo will read the hero, scoff, and bounce. The framing is adversarial-sales, not respectful.

A small merchant doing 200 orders/mo and a 2,000-order shop both see the same bait number — neither feels the page knows who they are. The calculator solves this 2 sections later, but the hero number does the damage first.

### H2. Hero CTAs both go to anchor links — no /signup primary

**Where:** `page.tsx:128-135`.

```jsx
<a href="#calculator" className="btn btn-primary btn-lg">Calculate my ৳ loss →</a>
<a href="#comparison" className="btn btn-secondary btn-lg">See the day-to-day difference</a>
```

Both anchor links. The first /signup CTA appears 3 sections later inside the calculator's `roi-cta`. High-intent visitors who already know the product (returning visitors, referrals, click-throughs from a paid ad) have to scroll through education before they can sign up. Calculator-first is a defensible funnel choice; absence of a /signup secondary is not.

### H3. Visual motion — five always-on infinite animations

**Where:** Multiple — `landing.module.css:153-158, 370-376, 1481-1486, 1148-1154, 750`.

Continuously animated elements:

- `eyebrow .pulse` (cordonPulse, 1.8s infinite) — hero
- `viz-pulse` SVG dasharray animation (cordonDash, 4s linear infinite) — fraud network
- `urgency-dot` (cordonPulse, 1.8s infinite) — final CTA
- `proof-band-dot` (cordonPulse, 1.8s infinite) — hero
- `exit-modal-pulse` (cordonPulse, 1.8s infinite) — modal

The IntersectionObserver pause helps when sections are out of view, but **all four hero-area pulses run continuously while a user reads the hero** (they're inside `.viz`, `.eyebrow`, `.urgency` which the observer tracks — except `proof-band-dot` which is **not** in the observed list, line 62 of page.tsx). Visual fatigue and battery drain on phones.

### H4. Counter animation triggers width reflow

**Where:** Inline JS (`page.tsx:36-56`) + `.stat-num` style.

The animated counters change `textContent` from "0" to "540" to "540K" over 1.4s. The mono font is fixed-width per glyph, but the digit count grows: 0, 1 → 2 → 3 chars. The container is not reserved-width, so each frame can shift the surrounding stat label by a few pixels. Aggregate layout instability inside the stat-strip during the animation. The stat with target=0 ("silent drops") animates 0 → 0, doing 60+ no-op paints.

### H5. Stat-strip cramped at 540–767px

**Where:** `landing.module.css:184-208`.

```css
.stat-strip { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 768px) {
  .stat-strip { grid-template-columns: repeat(2, 1fr); }
}
```

At 540–767px the strip is still 4 columns. Each column is ~120–160px wide, hosting "Average COD RTO rate, BD market" — wraps to 3 lines. Once it drops to 2 columns at 767px the cards become readable but the breakpoint is too late. **Breakpoint should be ~900px**, matching the navbar collapse at 800px and the proof-band stats reflow at 700px.

### H6. Pricing numbers use Western thousands, not BD lakh-crore — inconsistent with the rest of the page

**Where:** `page.tsx:835, 850, 868`. Format conflicts with calculator (`Intl.NumberFormat("en-IN")`).

- Pricing: `৳1,990`, `৳4,990`, `৳12,990` — Western style (commas every 3 digits).
- Calculator output: `৳1,94,400` — Indian/BD style (commas at lakh).
- Hero number: `৳540,000+` — Western style.
- Proof-band: `৳45 Cr+` — BD/Indian crore notation.

A page mixing three notations within the same paragraph signals carelessness to a Bangladesh merchant. **Pick one and stick to it.** For a BD audience, lakh-crore is the convention (`৳1,99,000` for "one lakh ninety-nine thousand").

### H7. The 5+ floating/sticky surfaces compete for attention

**Where:** `floating-loss-indicator.tsx`, `exit-intent-modal.tsx`, mobile-cta in `page.tsx:1015-1022`, `pricing-highlighter.tsx`.

On desktop after touching the calculator, the user has:

- A fixed nav at top (64px)
- A floating loss indicator at bottom-right (280×~150px, persistent until dismissed)
- The pricing-highlighter mutating DOM as they scroll
- An exit-intent modal that fires when the cursor moves toward the URL bar

On mobile (<800px), the nav links collapse, the floating loss indicator hides, but the mobile sticky CTA bar takes the bottom. So mobile is calmer than desktop. **Desktop is doing too much.** Pick two surfaces (nav + one persistent reminder), drop the rest.

### H8. Reliability section uses cryptic mathematical icons that confuse non-technical merchants

**Where:** `page.tsx:667-715`.

The six icons: `{ }`, `↻`, `⊘`, `∝`, `⊞`, `⌛`. To an engineer these read as "code, retry, circuit-breaker, proportional, encryption, timer." To a Bangladesh merchant evaluating an ops tool, they read as random characters. The h4 labels are good ("Idempotent ingestion", "Courier circuit breakers"), but the labels themselves are jargon. **The Reliability section is positioned for technical buyers, but the rest of the page is positioned for operators.** Mismatch.

### H9. Twilio voice-call assumption may not match BD merchant reality

**Where:** Solution section ("Calls only when calls matter"), Pricing ("Full-auto + Twilio").

In Bangladesh, B2C confirmation typically happens via SMS or WhatsApp, not voice calls. Buyers receiving an automated voice call from a number they don't recognize will often hang up. The page assumes Twilio voice as the default confirmation surface. Worth surveying whether merchants want this — or whether SMS/WhatsApp would be a more familiar/converting channel. Not necessarily a redesign issue, but flag for content review.

### H10. "First 50 stores joining this month get a free fraud audit" — manufactured scarcity if not enforced

**Where:** Final CTA (`page.tsx:1004-1007`).

Urgency text is concrete: "first 50 stores joining this month." If this is not enforced — i.e. the 51st store also gets an audit, or the offer renews next month — it's a fairness/integrity issue. If it IS enforced, where is the counter showing how many slots remain?

---

## 4. Medium-priority issues (P2)

### M1. Section count is high; cognitive scroll pile-up

14 sections + final CTA + footer. Each section opens with `section-eyebrow + h2.section-title + p.section-sub` — three elements before content begins. That's 42 cognitive entry points. Consolidate or merge: Solution + How it works + Pipeline could become one section. Reliability + Without/With could be one. Cuts to 9–10 sections without losing content.

### M2. "Most popular" appears twice on the Growth pricing card

In the tier label: "Growth · most popular" (`page.tsx:849`).
In CSS pseudo: there is NO `.price-card.featured::before` rule with content (verified — the `.featured.recommended::before` rule on line 1072 implies one but I cannot find a creating rule). So the visible "most popular" text is single — but the CSS has dead-code referencing a hidden pseudo. **Investigate whether `.price-card.featured::before` ever existed and was removed; the `.featured.recommended::before { display: none }` rule (line 1072-1074) is now orphaned.** Minor cleanup.

### M3. The "+ 195 more" trust-logo cell is styled identically to logos

**Where:** `page.tsx:592` + `.trust-logo` CSS.

If the wall is replaced with real logos, "+ 195 more" should be a smaller text-only cell, not a peer logo. Otherwise it reads like another brand named "+ 195 more."

### M4. Inline `<script dangerouslySetInnerHTML>` for IntersectionObserver

**Where:** `page.tsx:25-72, 1054`.

The inline script handles nav-scroll, counter animations, and animation pause. It's a single-purpose marketing-page script. Acceptable — but bypasses React's reconciliation. If anything in the script's selectors changes (`#cordon-nav`, `.cordon-counter`, `.viz`, `.eyebrow`, `.urgency`), the script silently does nothing. Consider migrating to a small `useEffect` in a thin client wrapper for maintainability.

### M5. Hero uses two `position: absolute` decorative layers on top of `overflow: hidden`

**Where:** `.hero-bg` + `.hero-grid` (`landing.module.css:124-140`).

Two stacked decorative gradient layers + a CSS background-grid pattern + the `mask-image` clip on the grid. Heavy paint cost on the largest section. The grid pattern with `mask-image: radial-gradient` requires GPU compositing; on a budget Android phone this is non-trivial.

### M6. ROI calculator default values may not match a typical BD merchant

**Where:** `roi-calculator.tsx:30-32`.

Defaults: 1,500 orders/mo, ৳1,200 AOV, 18% RTO. Industry baseline RTO in BD is widely quoted as 18–22% (matches the page). 1,500 orders/mo represents a **mid-large** operator. A small merchant doing 50–100 orders/mo will see absurdly small numbers and disengage. Consider a smaller default (e.g., 400 orders) so the entry experience is more inclusive, OR detect via geolocation/referrer.

### M7. RoiEmailCapture writes leads to localStorage, not a real endpoint

**Where:** `roi-calculator.tsx:212-234`.

```js
// TODO: wire to a real lead endpoint. For now we capture in
// localStorage so the value isn't dropped during early launch.
```

If the user submits "Email me the report," nothing actually emails them. The "✓ Report on its way to you@yourstore.com" UI lies. **At minimum, route to a real lead endpoint OR change the success copy to "Saved for our records — we'll be in touch."** The current "Report on its way" claim is a small but real trust bug.

### M8. Footer is sparse — no policies, no legal, no regional contact

**Where:** `page.tsx:1036-1051`.

Footer contains: logo, 5 anchor links (Home/How it works/Fraud network/Pricing/Sign in/Sign up), copyright. **Missing:** privacy policy, terms of service, GDPR/Bangladesh data policy mention, contact email, physical address (relevant in BD merchant-trust patterns), social links. Bangladesh-savvy merchants check the footer for "is this a real company?"

### M9. SEO surface is thin

**Where:** `page.tsx:74-78`.

```js
export const metadata = {
  title: "Cordon — Stop losing money to fake COD orders",
  description: "The order operations OS for Shopify and WooCommerce stores in Bangladesh...",
};
```

No `openGraph`, no `twitter` card, no canonical URL, no JSON-LD structured data (Organization, Product, FAQPage). The FAQ section is a perfect FAQPage schema candidate. Currently nothing structured for search engines beyond title + description.

### M10. Section eyebrows count `01 / The bleed` through `12 / FAQ`

12 numbered sections. The numeric prefix is a stylistic choice and works. But it commits the page to "12 sections" — adding/removing one requires renumbering all subsequent eyebrows. Consider unnumbered eyebrows (just `THE BLEED` etc.).

---

## 5. Mobile-specific issues

| # | Issue | Where |
|---|---|---|
| MOB1 | Hero `padding-top: 180px` (line 123) on a 568px-tall iPhone SE leaves only ~388px for hero content. Eyebrow + h1 alone consume that. The microquote and stat-strip require scrolling before any signal is visible. | `landing.module.css:123` |
| MOB2 | Hero CTAs are `flex-wrap: wrap` (line 177). On 320–360px viewports they often wrap to two stacked rows of one CTA each, but with `gap: 12px` they look ungrouped. | `landing.module.css:177` |
| MOB3 | Stat-strip's 4-cell mobile flip happens at 768px — too late. At 540–767px (most landscape phones, smaller tablets), each cell still hosts a multi-line label. | `landing.module.css:203-208` |
| MOB4 | Pricing 4 → 2 → 1 column at `<1000px` and `<600px`. At 600–999px (large phones, small tablets) you get 2 columns of price cards. The Growth featured card sits next to Starter; Scale and Enterprise sit below. Asymmetric layout — Growth's "most popular" treatment does not look featured among 2-col stacking. | `landing.module.css:460-462` |
| MOB5 | Mobile sticky CTA bar overlaps the FAQ section's last summary on phones with limited viewport (the `<details>` summary's `padding: 22px 0` sits flush with the 64px bar). Tap the FAQ summary near bottom, the bar's accent shadow visually competes. | `landing.module.css:712-735` |
| MOB6 | Number input field touch target ~36px tall (`padding: 10px 14px` + 14px font). Below the 44px Apple HIG minimum. Same for the email-capture input. | `landing.module.css:620-632, 1291-1305` |
| MOB7 | `mode-list` items at `padding: 10px 0` with 13px font ≈ 38px tall. Marginally below 44px touch target — although they aren't tap targets, they sit immediately below buttons and can be miss-tapped. | `landing.module.css:409-415` |
| MOB8 | Network SVG viz at `aspect-ratio: 1` and `max-width: 380px` — at 320px viewport the SVG renders at 280px wide. Six store labels at `font-size: 9px` (`.viz-label`) become barely readable. | `landing.module.css:365-377` |
| MOB9 | The hero serif italic ("We give it back") is `var(--font-serif)` — likely loaded via `next/font` but no `font-display: swap` declaration is visible. Risk of invisible text during web font load (FOIT) on slow 3G connections. | `landing.module.css:43-48` |
| MOB10 | Comparison table mobile fallback uses `::before { content: 'Without Cordon' / 'With Cordon' }` (lines 863-880) — these labels are picked up by screen readers as decorative content but are useful context. Consider `aria-label` or an actual rendered label for accessibility tools. | `landing.module.css:841-881` |
| MOB11 | The mobile sticky CTA's "Stop the bleed" is the primary CTA, but the secondary "See my loss" comes first (left). Convention is primary-right or primary-only on mobile sticky bars; the current order may bias toward secondary. | `page.tsx:1015-1022` |
| MOB12 | No safe-area-inset handling on the hero top — the navbar is `position: fixed` and the hero begins under it without `env(safe-area-inset-top)`. On iPhone 14+ in portrait this is invisible (notch sits in the safe area), but landscape orientation with the address bar can shift the hero behind the nav. | `landing.module.css:123` |

---

## 6. Responsiveness findings (per breakpoint)

| Breakpoint | Width | Issues |
|---|---|---|
| Small mobile | ≤320px | Hero CTAs wrap awkwardly; SVG viz labels at ~9px barely readable; pricing collapses to 1-col cleanly; mobile-cta bar fits but is busy |
| Standard mobile | 360–414px | Hero microquote + stat-strip add long scroll under a tall hero; mobile CTA bar competes with FAQ; testimonial cards stack ok |
| Large mobile | 414–600px | Pricing still 1-col at <600px; trust-logos at 2-col reveals placeholders prominently; comparison table stacks vertically with pseudo-element labels |
| Tablet | 600–900px | **Worst zone.** Pricing 2-col asymmetric, stat-strip 4-col cramped at 540–767px (despite the 768px breakpoint), navbar links visible until 800px, hero h1 gets two-line break that sits awkwardly |
| Laptop | 900–1200px | Best-supported range. Most grid layouts hit their target column counts. Floating loss indicator appears |
| Desktop | 1200–1600px | Container caps at 1200px (`landing.module.css:51`) — content centers cleanly. Heavy whitespace flanks content but feels intentional |
| Ultra-wide | ≥1600px | Container still 1200px. ~200px+ of empty bleed on each side. Hero h1 at `clamp(40px, 6vw, 76px)` caps at 76px — for 2560px+ screens, headline feels small relative to the canvas. Stat-strip and Without/With table look small in the wide canvas. |

### Specific responsiveness defects
- **Pipeline grid** transitions 6 → 2 → 1 (lines 322-326). At 500–999px (big phones, small tablets), 2 columns feels squat — the steps lose their narrative direction.
- **Network grid** transitions 1.2fr/1fr → 1fr at 900px. Below that, the SVG sits at the bottom of the section, far below the title — narrative read order works, but the SVG no longer "illustrates" the heading.
- **Modes-grid** 3 → 1 at 900px. No 2-col intermediate. Tablet users get the 1-col stack early.
- **Pricing-grid** 4 → 2 → 1 (1000px / 600px). The 2-col stage is the asymmetric one — featured Growth doesn't visually dominate.

---

## 7. Conversion friction findings

| # | Friction | Severity |
|---|---|---|
| F1 | Hero primary CTA goes to `#calculator`, not `/signup`. High-intent visitors must scroll through education first. | 🟡 |
| F2 | Three competing CTAs in the hero (calc / comparison / start-trial via mobile bar). No clear primary on mobile. | 🟡 |
| F3 | Calculator → /signup CTA buried inside a tall calculator panel. Users who skim slider widgets miss the conversion. | 🟡 |
| F4 | "Email me the report" button does NOT actually email anything (M7). Lies after submission. | 🔴 |
| F5 | Exit-intent modal anchors back to `#calculator`, not `/signup`. Aggressive interception that pushes users *deeper* into the page. | 🟡 |
| F6 | Pricing "Most popular" badge on Growth, but no enterprise sales-handling visible until you hit the Enterprise card's mailto. No "Talk to sales" floating action for high-volume leads. | 🟢 |
| F7 | "Book a 15-min walkthrough" is a `mailto:` link, not a calendar booking widget (Cal.com/Calendly). High-intent enterprise leads click and find their email client opens with a blank subject — friction-prone. | 🟡 |
| F8 | "Stop the bleed →" appears 5+ times across page (mobile CTA, floating loss, calculator CTA, hero CTA, final CTA) — repetition reduces button novelty / urgency by the 4th sighting. | 🟢 |
| F9 | No live chat surface; no "have a question?" inline. The page assumes self-serve discovery. Many BD merchants prefer WhatsApp-first contact. | 🟡 |

---

## 8. Trust / enterprise positioning findings

### 8.1 Trust gaps

| # | Issue | Why it matters |
|---|---|---|
| T1 | Placeholder metrics (C1) and placeholder logos (C2) — actively erode trust. | Critical |
| T2 | Duplicate fabricated testimonial (C3) — implies the others are also fabricated. | Critical |
| T3 | No "About" / "Team" linkage on the page or in the footer. Bangladesh merchants check who's behind a vendor. "Built in Dhaka" in footer is poetic but identifying. | High |
| T4 | No privacy policy / terms / data-handling page linked from footer. New collections (`customer_reliabilities`, `address_reliabilities`) hash buyer phones — this is a strong privacy story currently undertold on the page. | High |
| T5 | Cross-merchant network section makes a strong privacy claim ("Privacy by architecture, not by promise") — but doesn't link to an open-source repo, security whitepaper, or third-party audit. It's an assertion. | Medium |
| T6 | No "Status page" or "uptime history" link. The "99.9% webhook delivery" claim should anchor to a status URL. | Medium |
| T7 | No press / coverage section — 200+ merchants is a meaningful number; if real, it's worth one paragraph from a recognizable BD outlet. | Low |

### 8.2 Enterprise positioning weaknesses

| # | Issue |
|---|---|
| E1 | The Reliability section uses developer cosplay icons (`{ }`, `↻`, `⊘`, `∝`, `⊞`, `⌛`) — reads as "look how clever our backend is" not "your business won't go down." Reframe the same six primitives as business outcomes. |
| E2 | No SOC 2 / ISO 27001 / PCI badges. Enterprise procurement starts here. |
| E3 | No "SSO / RBAC / audit log" mention anywhere. Enterprise plan listing is a one-line "SLA + dedicated support" with no concrete %. |
| E4 | "Built in Dhaka" footer + "Bangladesh" hero positioning are great for SMBs but suggests provincial scope to a 25k+ orders/mo merchant who may operate cross-border. |
| E5 | No customer-case-study format (situation → action → outcome) for any enterprise-grade merchant. Three short testimonials < one detailed case study. |
| E6 | Enterprise pricing CTA is `mailto:` not a sales-call calendar booking. |

---

## 9. Bangladesh usability findings

### 9.1 Strengths
- BD-specific framing throughout ("BD's COD economy", Pathao/Steadfast/RedX, bKash + Nagad).
- "৳" currency used consistently.
- `Intl.NumberFormat("en-IN")` for Indian/BD lakh-crore convention in the calculator.
- COD-specific RTO problem is the #1 pain point of BD ecommerce — page leads with it.

### 9.2 Weaknesses

| # | Issue |
|---|---|
| BD1 | Number-formatting inconsistency (H6) — Western thousands in pricing + hero, lakh-crore in calculator + proof-band. Pick lakh-crore everywhere. |
| BD2 | English-only — no Bangla version. Most Bangla-first merchants will skim. Even a single Bangla strapline above the hero would signal local affinity. |
| BD3 | Twilio voice-call assumption (H9) doesn't match BD merchant expectations. Most BD merchants want SMS or WhatsApp confirmation. |
| BD4 | Facebook commerce is the largest BD seller cohort by count — page only mentions Shopify + WooCommerce. F-commerce sellers will not see themselves. |
| BD5 | No mention of cash collection, delivery proof, or bKash payment-on-delivery flows that are common in BD. |
| BD6 | Pricing in monthly USD-equivalent feels high to small BD merchants (৳1,990/mo ≈ $18). The Starter tier limit of 500 orders is fine for established stores but excludes the 80% of merchants doing < 100 orders/mo. |
| BD7 | "Setup in under 10 minutes" assumes the merchant has API keys / webhook URLs ready. A non-technical operator may bounce off the integration step even before the trial starts. |
| BD8 | No WhatsApp-based contact / support number visible. Bangladesh B2B procurement frequently happens over WhatsApp. |
| BD9 | "BD COD economy" framing is good, but no visible Bangladesh address or BD-registered company info. Builds suspicion about whether the company is local-operated. |

---

## 10. Accessibility findings

| # | Issue | Severity |
|---|---|---|
| A1 | `var(--c-text-3)` (`#71717A`) on `#0A0A0B` background ≈ 4.8:1 contrast. Passes WCAG AA for normal text, fails AA for large text inverse. Used for footer, captions, hints — borderline acceptable. | 🟢 low |
| A2 | Animated counter (`page.tsx:36-56`) changes textContent without `aria-hidden`. A screen reader may announce "0… 18… 540… 540K…" causing reading interruption. Counter is decorative; should be `aria-hidden="true"` with the final value as accessible text. | 🟡 medium |
| A3 | Mobile-cta bar uses `aria-hidden="false"` (line 1015) which is the default; redundant. The bar is `display:none` on desktop via CSS — assistive tech may still surface it on desktop because the markup is present. | 🟢 low |
| A4 | The compare-table uses ARIA `role="table"` / `role="row"` / `role="cell"` on a CSS Grid layout. ARIA tables on grids can confuse some assistive tech (screen readers expect a real `<table>`). The mobile fallback drops these in favor of stacked divs — even more confusing. | 🟡 medium |
| A5 | The exit-intent modal does not visibly trap focus or dismiss on ESC in the part of the source I read (only ~120 lines visible). Standard modal patterns require both. | 🟡 medium (verify) |
| A6 | `details > summary { list-style: none }` removes the default disclosure marker (line 674). The custom `+` / rotated `+` works visually but assistive tech announces "summary, expanded/collapsed" — works fine. ✅ | 🟢 fine |
| A7 | The trust-logo cells "AURORA / MEEM & CO / VANTA / RUSHANE / CASCADE / + 195 more" are plain `<div>` text. Screen reader users get an unstructured list; no group `aria-label`. The wrapper has `aria-label="Featured merchants"` (line 586) — good but could be `<ul>` for semantic richness. | 🟢 low |
| A8 | The hero's ৳ (Bengali Taka sign) reads correctly in modern screen readers but legacy assistive tech may pronounce it as "Bengali Rupee Sign / unknown character." Adding `aria-label="540,000 taka"` to monetary highlights would improve. | 🟢 low |
| A9 | `prefers-reduced-motion` IS handled (line 1185-1194) — kills all animations to ~0ms. ✅ | 🟢 fine |
| A10 | Skip-to-main-content link absent. Keyboard users must tab through the navbar (4 anchors + 2 buttons = 6 stops) before reaching the hero. | 🟡 medium |
| A11 | Form labels — `label` element wraps the input on Slider/NumberField, so the field-label IS associated. ✅ But `aria-label="Email address"` (line 265) is redundant with the placeholder; the label-via-wrapping `<label>` in Slider/NumberField is missing on the email field. | 🟢 low |
| A12 | Color is the sole differentiator for compare-bad / compare-good in the table (red text vs lime text). For colorblind users (especially red-green), the only other signals are the "Without Cordon" / "With Cordon" tag chips and the row order. Consider adding an icon (✕ / ✓) to the values. | 🟡 medium |

---

## 11. Technical UI findings

### 11.1 Performance / paint cost

| # | Concern |
|---|---|
| P1 | Backdrop-filter on nav, exit-intent backdrop, floating-loss — three separate backdrop-blur surfaces. Each is GPU-heavy on low-end Android. |
| P2 | Hero stacks 4 paint layers: background (color), `.hero-bg` (radial-gradient), `.hero-grid` (linear-gradient + mask-image), and content. On low-end devices this section will be the LCP element AND have the most paint. |
| P3 | 5 always-on infinite animations (H3). With one IntersectionObserver controlling pause for a subset. CPU usage continuous on the hero. |
| P4 | Counter animation reflows on every frame for 1.4s × 4 counters (H4). One target=0 (silent drops) animates to no visible change — wasted work. |
| P5 | Inline `<script>` (`page.tsx:25-72`) blocks parser execution. Acceptable size (~50 lines) but blocks first paint. |
| P6 | Page is `force-dynamic`-equivalent due to `getBrandingSync()` call at module top (`page.tsx:9`). If branding is per-tenant, every request rebuilds. If branding is static, this can be moved to const. (Verify whether `getBrandingSync` is a `cache()`'d call.) |
| P7 | No `<Image>` component usage — entire page is text + inline SVG + CSS. Good for LCP. But the SVG at `viewBox="0 0 380 380"` with 7 nodes, 6 lines, 2 pulses, 7 text labels is duplicated inline — modest cost. |
| P8 | Footer renders `new Date().getFullYear()` (line 1049) — server-rendered. Causes a hydration mismatch only if server time and client time disagree on year — virtually never an issue. |

### 11.2 React / hydration risk

| # | Concern |
|---|---|
| R1 | `<script dangerouslySetInnerHTML>` runs after hydration. Counter elements ARE present in SSR HTML with `>0%</span>` initial state, so no hydration mismatch. ✅ |
| R2 | `useEffect` listeners in client components: floating-loss, exit-intent, pricing-highlighter, ROI calculator. Four `"use client"` boundaries on a marketing page — modest. |
| R3 | `(window as unknown as { __cordonCalc?: ...}).__cordonCalc = detail` (`roi-calculator.tsx:71`) — global window mutation as a state-bus across components. Works but is fragile; if a future dev adds a 5th listener that depends on snapshot ordering, race-conditions appear. |
| R4 | `localStorage` reads in `exit-intent-modal.tsx:46-58` happen INSIDE useEffect. ✅ No SSR break. But if a user has localStorage disabled (Safari private), the try/catch swallows — exit-intent re-fires without persistence. Acceptable but documented behavior. |
| R5 | `roi-calculator.tsx:71` writes to `window.__cordonCalc` even when the user hasn't moved sliders. ✅ Initial render publishes default snapshot; downstream listeners get value on mount. |

### 11.3 Component hygiene

| # | Concern |
|---|---|
| H1 | `page.tsx` is 1,057 LOC. Beyond a comfortable single-file size. Hero / Problem / Calculator wrapper / etc. could each be a `<HeroSection />` etc. Future-edits are riskier in a single monolith. |
| H2 | `landing.module.css` is 1,487 LOC of `:global()` selectors. The CSS Module benefit (scoped) is preserved at the wrapper level, but every selector inside is global-named. If another marketing page lands in `(marketing)`, class-name collisions are possible. |
| H3 | The roi-calculator uses `Intl.NumberFormat("en-IN")` — implicit locale. Calculator's results for ৳ values will format Western-style on en-US locales (some browser configs). Verify formatter respects intent. |
| H4 | No `<noscript>` fallback. The page works without JS for content (counters stay at "0", calculator inputs render but don't compute, exit-intent / floating loss don't appear). Static signup CTAs are still functional. ✅ Implicit. |

---

## 12. Recommended implementation priority order

### Phase 1 — Credibility (block all marketing spend until done)

1. **Replace placeholder metrics (C1) with either real values or honest qualitative claims.** If 200+ merchants is true, leave it. If not, replace with "Built for 1,000+ orders/month operations" or similar honest language that's not a count.
2. **Replace placeholder logos (C2)** with real logos (with permission) OR replace with the existing `.trust-categories` row only (which is honest — categories of customers, not specific names).
3. **Remove the duplicate testimonial (C3).** Pick one location for the "RTO 22% → 8.5%" quote, OR replace one with a different real operator quote.
4. **Wire up `RoiEmailCapture` (M7)** to a real endpoint OR change the success copy from "Report on its way to X" to honest language ("Saved — we'll be in touch within 24h").
5. **Audit the "first 50 stores" urgency claim (H10).** Either implement a counter that ticks down in real-time, or replace with non-numerical urgency ("Free fraud audit during the launch quarter").

### Phase 2 — Hero compaction

6. **Remove the hero microquote** — move it to the Proof section as a 4th testimonial.
7. **Move the stat-strip** to immediately under the Problem section heading (it's a problem-context stat, not a hero element).
8. **Drop one hero CTA** — keep "Calculate my ৳ loss" OR make it `/signup` directly with the secondary "See the math" anchoring to `#calculator`.
9. **Fix the H1 `<br/>` (C5)** — replace with a `<wbr>` or natural wrap.
10. **Replace the hero "৳540,000+" generic illustration (H1)** with a smaller, less specific framing: "You're losing six figures a month to fake COD." Or anchor it to merchant size: "1,000+ orders/mo? You're bleeding ৳540K/mo." Or remove the number entirely from hero and leave it for the Problem section.

### Phase 3 — Mobile / responsiveness rhythm

11. **Stat-strip breakpoint to 900px** (was 768px) (H5).
12. **Mobile sticky CTA reorder** — primary on the right (MOB11).
13. **Number-input touch targets to 44px+** (MOB6).
14. **Pricing 2-col asymmetric problem (MOB4)** — either drop straight from 4 → 1 at 900px, or center the featured Growth card in a 2-row 2-col layout.
15. **SVG viz mobile readability** (MOB8) — add a label-priority strategy: hide store names below 400px, keep the lines and the central "cordon" node only.

### Phase 4 — Visual noise reduction

16. **Drop one or two of the always-on pulses (H3).** Keep the eyebrow pulse in the hero (it signals "live"); drop `proof-band-dot` and `urgency-dot` (visually redundant).
17. **Pause counter animation on `prefers-reduced-data`** (extension) and set initial value to the target (skip animation entirely on slow networks).
18. **Consolidate the four sticky/floating layers (H7)** — pick floating-loss XOR exit-intent on desktop. Keep mobile-cta on mobile.

### Phase 5 — Enterprise + BD positioning

19. **Reframe Reliability section icons (H8)** — replace mathematical glyphs with simple shape icons (shield, refresh, lock, etc.) and rewrite labels in business outcome language ("Your data, encrypted at rest" not "Encrypted credentials").
20. **Pick lakh-crore everywhere (H6)** — mass find-and-replace ৳1,990 → ৳1,990 (already), but ৳540,000 → ৳5,40,000.
21. **Add privacy / terms / contact to footer (T4 + M8).**
22. **Add WhatsApp contact (BD8)** — at minimum a footer chip.
23. **Add Bangla strapline above hero (BD2)** — even one line signals local affinity.
24. **F-commerce mention (BD4)** — even if not yet supported, "Shopify, WooCommerce, and F-commerce coming soon" tells the F-commerce seller you've heard them.

### Phase 6 — Conversion polish

25. **Hero secondary CTA → /signup directly** (F1).
26. **Replace `mailto:` walkthrough booking with Cal.com/Calendly widget** (F7).
27. **JSON-LD FAQPage schema** for the FAQ section (M9).

### Phase 7 — Code hygiene (optional)

28. **Split `page.tsx` into section components** (H1 — code hygiene, not a UI ask).
29. **Replace inline `<script>` with a thin client-side `useEffect` wrapper** (M4).
30. **Verify `getBrandingSync` is cached** (P6).

---

## 13. "Do NOT change" — load-bearing decisions to preserve

The following are working well and should NOT be touched in a redesign pass:

| # | Element | Why preserve |
|---|---|---|
| K1 | The dark theme + lime accent palette | Distinctive, on-brand, and no competing BD ecommerce SaaS uses this. Identity. |
| K2 | The Inter + serif italic + mono triad | Consistent across the page. Italic serif on accent words ("We give it back", "right now?", "no one wants to do.") is a strong typographic signature. |
| K3 | The `(marketing)` route group has zero providers | Documented in `apps/web/CLAUDE.md` § Providers. Marketing bundle stays light. **Do not add `<Providers>`** here for any reason. |
| K4 | `prefers-reduced-motion` handling | Already correct (line 1185-1194). |
| K5 | The IntersectionObserver pause for off-screen animations | Battery / CPU saver. Keep. |
| K6 | The ROI calculator's 3-input + 4-output structure | Clean, fast, no third-party deps. The interaction model is right. |
| K7 | Native `<details>` for FAQ | Zero JS, full keyboard accessibility, indexable as plain text. **Do not replace with a JS accordion.** |
| K8 | `data-plan` attribute on price cards for the highlighter | Clean attribute API; pricing-highlighter mutates DOM correctly. |
| K9 | Mobile sticky CTA pattern | Pattern is correct (the issues are MOB5, MOB11 which are tweaks, not rewrites). |
| K10 | The four-tier pricing structure (Starter / Growth / Scale / Enterprise) | Industry-standard SaaS shape; matches the in-product plan gates. |
| K11 | The 14-day-trial-no-card framing | Removes signup friction. Already reinforced everywhere. Keep. |
| K12 | Use of `:global()` for nested rules | Necessary for the inline JS hooks (`#cordon-nav`, `.cordon-counter`) to work. Don't refactor without a plan. |
| K13 | The "Calculate my ৳ loss" → calculator → `/signup` funnel intent | The page is **deliberately** education-first to convert merchants who don't yet know they have a problem. Hero-to-/signup direct would lose those. The fix is to ADD a /signup secondary, not REPLACE the calculator anchor. |
| K14 | Hashed-only privacy claim ("Privacy by architecture, not by promise") | This is the single strongest enterprise differentiator on the page. Strengthen it (link to whitepaper) but don't soften it. |

---

## 14. Final UX direction recommendation

**The page does NOT need a redesign. It needs a credibility pass + a hero compaction + a mobile rhythm fix.**

### Strategic posture

The right mental model for the next pass is **"calmer, more honest, more local."**

- **Calmer.** Reduce the eight-element hero to four. Remove two of five always-on pulses. Replace developer-cosplay icons with business-outcome wording.
- **More honest.** Replace placeholder metrics and logos with real ones, or with category-level honest language. Make the "Email me the report" actually email. Make the "first 50 stores" claim either real or qualitative.
- **More local.** Pick lakh-crore notation everywhere. Add a Bangla strapline. Add F-commerce acknowledgement. Add a WhatsApp contact in the footer. Add a Bangladesh address.

### What success looks like after the next pass

A Bangladesh merchant arriving on the page on a 360px-wide phone over a 3G connection should:

1. See in 3 seconds: brand + problem ("fake COD orders") + outcome ("RTO down 60%") + primary CTA.
2. Be able to start a trial in two taps without scrolling past the fold.
3. See the calculator section in one downward swipe, with their hand-typed numbers immediately producing a believable loss number (not a manufactured ৳540K hero claim).
4. Reach the pricing in one more swipe with their plan auto-highlighted.
5. Trust every number and quote on the page, because every number and quote is real.

### What the page should explicitly NOT become

- **Not** a scrolly-telling page with parallax + WebGL + heavy animation. The current restraint is a feature; an enthusiastic redesign is more likely to hurt than help.
- **Not** a chatbot-first / conversational landing page. The merchant cohort is decision-fast, mobile-heavy, and skim-oriented.
- **Not** a single-page app. The current static-friendly architecture (SSR, no providers, native `<details>`) is the right shape.
- **Not** a monolith of social proof. A single great case study > five fictional testimonials.

### Suggested next-phase plan length

- **Phase 1 (Credibility):** 1–2 days of mostly content + small layout work.
- **Phase 2 (Hero compaction):** 1 day.
- **Phase 3 (Mobile rhythm):** 1–2 days.
- **Phases 4–7:** as priorities allow; not blocking the staging deploy.

Total: ~1 week of focused work for an 80% conversion-readiness improvement, without redesigning the page.

---

## 15. Appendix — file references

| Concern | File | Line(s) |
|---|---|---|
| Hero | `apps/web/src/app/(marketing)/page.tsx` | 107-202 |
| Hero h1 forced break | same | 117-121 |
| Hero placeholder metrics | same | 145-155 |
| Trust-logo placeholders | same | 583-593 |
| Metric-row placeholders | same | 595-614 |
| Duplicate testimonial | same | 159-169 vs 641-650 |
| Mobile sticky CTA | same | 1015-1022 |
| Inline JS | same | 25-72, 1054 |
| Counter animation | `landing.module.css` | (no animation in CSS — JS-driven) |
| Stat-strip breakpoint | same | 184-208 |
| Hero gradient stack | same | 124-140 |
| Always-on pulses | same | 153-158, 370-376, 750, 1148-1154, 1481-1486 |
| Pricing grid breakpoints | same | 460-462 |
| Compare-table mobile | same | 841-881 |
| ROI calculator | `_components/roi-calculator.tsx` | 1-376 |
| RoiEmailCapture stub | same | 195-281 |
| Floating loss | `_components/floating-loss-indicator.tsx` | 1-62 |
| Exit-intent modal | `_components/exit-intent-modal.tsx` | 1-261 |
| Pricing highlighter | `_components/pricing-highlighter.tsx` | 1-39 |
| Marketing layout (zero providers) | `app/(marketing)/layout.tsx` | 1-17 |
