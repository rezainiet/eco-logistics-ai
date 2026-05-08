# Landing Page — Phase 4 Motion + Sticky Surface Cleanup

**Live URL (currently):** https://confirmx.ai/
**Reference audits:**
- `docs/audits/landing-page-critical-ux-audit.md`
- `docs/audits/landing-page-phase1-credibility-report.md`
- `docs/audits/landing-page-phase2-hero-report.md`
- `docs/audits/landing-page-phase3-responsiveness-report.md`

**Posture:** motion calmness + sticky/floating surface consolidation. **No redesign.** Visual identity, palette, typography, layout, component architecture, responsiveness — all preserved.
**Date:** 2026-05-08

---

## 0. TL;DR

The page now has **2 live looping animations** (was 3 after Phase 1's removal of the duplicate `proof-band-dot`, and 5 originally — eyebrow + viz + urgency-dot + proof-band-dot + exit-modal-pulse). Both remaining loops are slowed to ~half their previous tempo. The desktop sticky/floating layer count drops from **3** (FloatingLossIndicator + ExitIntentModal + nav) to **2** (FloatingLossIndicator + nav). The FloatingLossIndicator itself is now visually quieter — narrower, no backdrop-filter, no accent glow ring, restrained border. The dead `.cordon-counter` IntersectionObserver setup (left over after Phase 2 removed the stat-strip JSX) is pruned from the inline `<script>`.

`tsc --noEmit` clean. Phase 1/2/3 wins all preserved. No new components, no new dependencies, no animation-library imports.

---

## 1. Files changed

| File | Change | Net |
|---|---|---|
| `apps/web/src/app/(marketing)/landing.module.css` | Eyebrow pulse 1.8s → 2.4s + opacity floor 0.5 → 0.55; viz-pulse 4s → 8s + opacity 0.7 → 0.55; urgency-dot animation removed (dot stays static); exit-modal-pulse animation removed; floating-loss restyled (narrower, no backdrop-filter, no glow ring, restrained border, smaller value text); `.paused` selector list trimmed (`.urgency-dot` removed). | +6 LOC net |
| `apps/web/src/app/(marketing)/page.tsx` | `ExitIntentModal` import + render removed (file kept dormant); inline `<script>` pruned of dead `.cordon-counter` IntersectionObserver setup; `.urgency` removed from the motion-pause observed list. | -39 LOC |

**Total: 2 files modified. Zero new components. Zero file deletions (`exit-intent-modal.tsx` kept dormant).**

---

## 2. Animations reduced / removed

### 2.1 Slowed (still alive but calmer)

| Animation | Before | After | Where it appears |
|---|---|---|---|
| `cordonPulse` (eyebrow .pulse) | `1.8s ease-in-out infinite` + scale 0.85 / opacity 0.5 floor | `2.4s ease-in-out infinite` + scale 0.88 / opacity 0.55 floor | Hero status indicator (only) |
| `cordonDash` (viz-pulse) | `4s linear infinite`, opacity 0.7 | `8s linear infinite`, opacity 0.55 | Fraud-network SVG dash |

The eyebrow now reads as a slow system heartbeat instead of a kinetic pulse; the SVG dash reads as "data flowing" rather than racing.

### 2.2 Made static (animation removed, element preserved)

| Element | Before | After |
|---|---|---|
| `.urgency-dot` (final CTA "Launch quarter" line) | `cordonPulse 1.8s infinite` | static lime dot — keeps the visual signal as a quiet accent without competing with the hero's pulse for attention |
| `.exit-modal-pulse` (inside the exit-intent modal) | `cordonPulse 1.8s infinite` | static — and the modal itself is now unmounted (see §3.1), so even the static element doesn't render in production |

### 2.3 Already eliminated in earlier phases

| Element | Removed in |
|---|---|
| `.proof-band-dot` pulse (4 stats below hero h1) | Phase 2 (proof-band JSX removed) — CSS rule remains dead but element never renders |
| `.cordon-counter` × 4 animated counters in hero stat-strip | Phase 2 (stat-strip JSX removed) |

### 2.4 Final inventory of live looping animations

```
1. .eyebrow .pulse              cordonPulse 2.4s   (hero, paused off-screen)
2. .viz-pulse                   cordonDash   8s    (fraud-network SVG, paused off-screen)
```

All other looping motion on the page has been retired or made static. CSS keyframes that remain referenced by dead elements (`.proof-band-dot`'s `cordonPulse`, `cordonModalIn`/`cordonFadeIn` for the no-longer-mounted exit modal) are CSS-only dead rules — the elements they target don't render. Pruning these CSS rules is a Phase 7 hygiene task.

### 2.5 One-shot animations preserved

| Animation | When it fires | Why preserved |
|---|---|---|
| `cordonSlideUp` (.4s) | floating-loss enter | one-shot affordance — tells the user "something appeared" |
| `cordonModalIn` / `cordonFadeIn` | exit-intent modal enter | dead — modal is unmounted; CSS rule kept dormant |

These are not "looping motion." They run once when an element mounts. They support orientation/affordance, not decoration. Keep.

---

## 3. Floating / sticky hierarchy changes

### 3.1 Surface inventory

| Surface | Status before Phase 4 | Status after Phase 4 |
|---|---|---|
| Fixed nav (top) | always present | unchanged |
| Mobile sticky CTA bar (<800px, bottom) | always present on phones | unchanged |
| FloatingLossIndicator (≥900px, bottom-right, after first calculator slider move) | present, accent-tinted border + accent glow + backdrop-filter, attention-grabbing | **quieter** — see §3.2 |
| ExitIntentModal (≥900px, fires once per 10-min on cursor exit toward URL bar) | mounted | **unmounted** — `<ExitIntentModal />` removed from `page.tsx`; component file kept dormant for possible future re-enablement |
| PricingHighlighter (no-render, side-effect listener) | mounted | unchanged — invisible UX |

The desktop user no longer experiences three layers of UI competing for attention (nav at top + floating-loss at bottom-right + interrupt modal). The flow is now: nav → calculator → floating-loss reminder. Calmer, more enterprise.

### 3.2 FloatingLossIndicator — calmer styling

**Before:**
```css
width: 280px;
padding: 18px 20px;
background: rgba(17, 17, 19, 0.96);
border: 1px solid rgba(198, 248, 79, 0.35);  /* bold accent border */
box-shadow:
  0 16px 40px -12px rgba(0, 0, 0, 0.6),
  0 0 0 1px rgba(198, 248, 79, 0.08),         /* accent ring */
  0 0 32px -8px var(--c-accent-glow);          /* accent glow */
backdrop-filter: blur(8px);                    /* GPU-heavy */
```

**After:**
```css
width: 264px;
padding: 16px 18px;
background: var(--c-surface);                  /* solid, no transparency */
border: 1px solid var(--c-border-strong);     /* neutral border */
box-shadow: 0 12px 32px -10px rgba(0, 0, 0, 0.5);
/* no backdrop-filter, no accent ring, no glow */
```

Plus the floating-loss-value font dropped 26px → 22px. The card now reads as a peripheral status reminder rather than an attention-claim.

GPU benefit: removing `backdrop-filter: blur(8px)` eliminates one of the most expensive paint operations on the page. The card now composites cleanly without filter passes.

### 3.3 Mobile sticky CTA — unchanged

The mobile sticky CTA bar layout (secondary "See my loss" left + primary "Stop the bleed" right, with primary taking the wider flex share) is already convention-correct — primary right-aligned with greater visual weight. Phase 4 does not touch it.

---

## 4. Motion hierarchy improvements

### 4.1 Attention budget

The page now has a clear motion-attention hierarchy:

```
Tier 1 — Always-on, slow:
  • Hero eyebrow pulse (2.4s)
  • Fraud-network SVG dash (8s, only when section visible)

Tier 2 — One-shot affordances:
  • Floating-loss slide-up enter
  • Hover transforms on cards (translateY -2px)
  • Button hover transitions

Tier 3 — Static accents:
  • Eyebrow chip
  • Final-CTA urgency dot (was Tier 1)
  • Logo dot
  • Mode "Most popular" pill
```

A user reading the hero sees one slow pulse. Scrolling to fraud-network adds the SVG dash. By final CTA, no looping motion competes with the call-to-action. **The eye is never asked to track two things simultaneously** in the same viewport, except when the floating-loss reminder is mounted (which is calm + neutral after Phase 4).

### 4.2 Comparison

| Phase | Live infinite animations | Sticky/floating surfaces (desktop) | Motion-perception verdict |
|---|---|---|---|
| Original | 5 (eyebrow, viz, urgency, proof-band-dot, exit-modal) + 4 counter animations on scroll | 3 (nav, floating-loss, exit-intent) | Hyperactive |
| After Phase 1 | 5 (microquote-elsewhere + counters preserved) | 3 | Improved credibility, motion unchanged |
| After Phase 2 | 4 (proof-band-dot gone, counters gone — JSX removed) | 3 | Calmer above-fold |
| After Phase 3 | 4 (no motion changes) | 3 | Calmer at every viewport, motion unchanged |
| **After Phase 4** | **2** (eyebrow + viz only, both slowed) | **2** (nav + floating-loss only) | Enterprise calm |

---

## 5. Enterprise polish improvements

### 5.1 What changed in feel

- **Slower heartbeat.** A 2.4s eyebrow pulse vs 1.8s reads as "operational status indicator" rather than "blinking startup beacon."
- **Slower data flow.** The fraud-network SVG dash at 8s reads as "signals routing through the network" rather than racing lines.
- **No interrupt overlay.** Removing the exit-intent modal removes the single most growth-hack-flavored UX on the page. Enterprise buyers rarely respond well to "where are you going?" interruptions.
- **Quieter peripheral reminder.** The floating-loss-indicator drops the lime-tinted border + glow ring + backdrop blur. It's now a neutral status card with red/lime accents only on the value text — a color-of-information signal rather than a color-of-attention-grab signal.
- **Static dots for static information.** The "Launch quarter" urgency dot is now static; an animated dot for a non-time-critical message read as growth-hack urgency theater.

### 5.2 What stayed (intentional personality)

- Eyebrow pulse — preserves the "live system" signal in the hero. Slowed but kept.
- Viz dash — the fraud-network section's defining visual. Slowed but kept.
- All hover transitions on cards (problem-card, solution-card, mode, price-card, etc.). Subtle micro-interactions support polish.
- Button arrow translate-on-hover (`btn:hover .arrow { transform: translateX(4px) }`).
- Logo dot box-shadow glow (no animation, just lit).

The page still has personality. It's just no longer flickering.

---

## 6. Mobile improvements

| Surface | Before Phase 4 | After Phase 4 |
|---|---|---|
| Eyebrow pulse | 1.8s — quick glance-grab on scroll-into-view | 2.4s — calmer hero arrival |
| Sticky CTA bar | unchanged | unchanged (already convention-correct) |
| Exit-intent modal | desktop-only — already not on mobile | removed entirely |
| FloatingLossIndicator | desktop-only via `@media (min-width: 900px)` — never visible on mobile | unchanged behavior, still desktop-only |
| Animations during scroll | 4 active (eyebrow + viz + urgency-dot + counter on scroll-into-view) | 2 active (eyebrow + viz only) |

**Result:** mobile scroll experience now has at most 2 simultaneous looping motions. On viewports where neither the hero (eyebrow) nor the fraud-network (viz) is in-view, **zero motion is animating** — a calm, static read.

---

## 7. Verification

| Check | Result |
|---|---|
| `apps/web` typecheck (`tsc --noEmit`) | exit 0 ✅ |
| Live looping `animation: ... infinite` rules in CSS that target rendered elements | 2 (`.eyebrow .pulse` 2.4s, `.viz-pulse` 8s) ✅ |
| Dead `animation: ... infinite` rules (selectors that don't match any rendered element after Phase 1/2 cleanups) | 1 (`.proof-band-dot`) — Phase 7 cleanup |
| Sticky/floating layers on desktop | 2 (nav + floating-loss) ✅ — was 3 |
| Sticky/floating layers on mobile | 2 (nav + mobile-cta-bar) ✅ — unchanged |
| `prefers-reduced-motion` honored | yes — global rule at line 1185 still active ✅ |
| Hover transitions on cards | preserved ✅ |
| One-shot enter animations (slide-up, fade-in, modal-in) | preserved (used by floating-loss only post-Phase 4) ✅ |
| New components / dependencies | none ✅ |
| Phase 1 credibility wins preserved | ✅ (no placeholder metrics, no fake testimonials, no fake email-capture, soft urgency, footer trust) |
| Phase 2 hero compaction wins preserved | ✅ (5-element hero, /signup secondary CTA, Reliability outcome-led copy) |
| Phase 3 responsiveness wins preserved | ✅ (3-stage section padding, 4-stage hero padding, pricing 4→1, pipeline 6→3→2→1, modes 3→1 at 800px, ultra-wide 1280px container, touch targets) |
| Bundle size impact | small reduction — `<ExitIntentModal />` no longer rendered (saves an additional client component on the marketing route) ✅ |

---

## 8. Intentionally deferred items

The following remain **out of scope** for this phase. Phase 4 was strictly motion + sticky-surface scope.

| # | Audit ref | Deferred to |
|---|---|---|
| D1 | `exit-intent-modal.tsx` file kept dormant — could be deleted entirely | Phase 7 (code hygiene) |
| D2 | `.proof-band-dot` dead CSS rule (selector targets a removed element, animation never runs in browser) | Phase 7 |
| D3 | `cordonModalIn` / `cordonFadeIn` keyframes (referenced only by the now-unmounted exit modal) | Phase 7 |
| D4 | Counter-animation IntersectionObserver code already pruned in Phase 4; no further JS reduction obvious | resolved |
| D5 | Reliability section icons (`{ }`, `↻`, `⊘`, `∝`, `⊞`, `⌛`) — labels were updated in Phase 2 but glyphs remain mathematical | Phase 5 (icon system decision) |
| D6 | E2 / E3 — SOC 2 / ISO 27001 / SSO badges | Phase 5 — needs real artifacts |
| D7 | M1 — 14-section count + section-eyebrow density | Phase 5 |
| D8 | M9 — JSON-LD FAQPage schema, OpenGraph, Twitter card metadata | Phase 6 (SEO) |
| D9 | BD2 — Bangla strapline | Phase 5 |
| D10 | BD8 — WhatsApp footer chip | pending branding-schema field |
| D11 | M8 — Privacy / Terms / Bangladesh address footer links | pending the actual `/legal/*` pages |
| D12 | MOB8 — SVG fraud-network label visibility < 400px (text-fill 9px) | Phase 5 (SVG label hide-strategy) |
| D13 | MOB10 — Compare-table mobile pseudo-element labels accessibility | Phase 5 (semantic refactor) |
| D14 | MOB9 — `font-display: swap` for the Inter / serif / mono fonts | Phase 6 (typography + perf) |
| D15 | MOB12 — `env(safe-area-inset-top)` on hero padding | Phase 5 / Phase 6 |

**None of these are motion or sticky-surface issues.**

---

## 9. Remaining Phase 5 items (preview)

Phase 5 is **enterprise visual polish + content compaction** per the audit's recommended order. Likely scope:

1. **Reliability section icons** — replace the mathematical glyphs (`{ }`, `↻`, `⊘`, `∝`, `⊞`, `⌛`) with simple shape icons or letter-based marks that read as enterprise rather than developer-cosplay. Labels are already operator-friendly (Phase 2). This needs an icon system decision (lucide-react is already available in `apps/web` via the order-detail panels — could reuse).
2. **SVG fraud-network label hide-strategy** — at < 400px viewports, hide the six store labels and keep only the central "cordon" node + lines. Improves readability without changing the diagram's narrative.
3. **Compare-table semantic refactor** — replace pseudo-element mobile labels with real `<th>` / `<td>` elements for proper screen-reader semantics.
4. **Section consolidation** — explore merging Solution + How it works + Pipeline into a single section, reducing the section count from 14 → ~10. Big ask; needs content review.
5. **Bangla strapline above hero** — single line in Bangla signaling local affinity. Needs translator.
6. **Hero `padding-top` `env(safe-area-inset-top)` on iOS landscape** — small accessibility / visual fix.

Phase 5 will likely touch ~50–80 LOC of CSS and modest JSX changes (icon swap-ins). It is genuinely the polish phase — not blocking production.

---

## 10. Final verdict

Phase 4 is complete and verified. The page has:

- **2 live looping animations** (was 5 originally) — both slowed for calmer feel
- **2 sticky/floating layers on desktop** (was 3) — exit-intent modal unmounted
- **Quieter floating-loss indicator** — no backdrop-filter, no accent glow, restrained border, smaller value text
- **Static urgency-dot** — eliminates pulse stacking with the hero
- **Pruned inline JS** — dead `.cordon-counter` setup removed
- **Trimmed `.paused` selector list** — only what's still observed remains

All Phase 1 (credibility), Phase 2 (hero compaction), and Phase 3 (responsiveness) wins remain intact. Visual identity, palette, typography system, layout architecture, and component model are all untouched. The page now reads as a calmer, more enterprise-feeling operational software pitch — exactly the intent of the spec.

The page is ready for **Phase 5 (enterprise visual polish + content compaction)** when the operator chooses to schedule it. Phases 6–7 (SEO/perf, code hygiene) remain non-blocking polish items.
