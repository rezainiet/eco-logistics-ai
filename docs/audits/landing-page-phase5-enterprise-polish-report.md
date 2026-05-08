# Landing Page — Phase 5 Enterprise Polish + Semantic Clarity

**Live URL (currently):** https://confirmx.ai/
**Reference audits:**
- `docs/audits/landing-page-critical-ux-audit.md`
- `docs/audits/landing-page-phase1-credibility-report.md`
- `docs/audits/landing-page-phase2-hero-report.md`
- `docs/audits/landing-page-phase3-responsiveness-report.md`
- `docs/audits/landing-page-phase4-motion-report.md`

**Posture:** enterprise visual polish + semantic clarity + iconography refinement. **No redesign.** No animation added. Visual identity, palette, typography, layout, component architecture, responsiveness, motion calmness — all preserved.
**Date:** 2026-05-08

---

## 0. TL;DR

Six surgical refinements that lift the page out of "developer-first" reading into "enterprise software" reading without redesigning anything:

- **Reliability section glyphs** (`{ }`, `↻`, `⊘`, `∝`, `⊞`, `⌛`) replaced with **inline SVG line-art icons**. No icon library imported, no marketing-bundle bloat. Icons inherit the existing `--c-accent` color via `currentColor`.
- **Compare-table mobile labels** are now real DOM spans (visible only on mobile, hidden on desktop where the column header carries context). Previous `::before` pseudo-elements were inaccessible to assistive tech and provided no screen-reader fallback.
- **SVG fraud-network outer-store labels** hide at < 480px while the central "cordon" label stays anchored — the diagram remains legible at 320–414px.
- **Pipeline terminology pass** — dropped two pieces of developer-flavored jargon (`Phone coerced to BD format` → `Phone normalized to Bangladesh format`; `Idempotent AWB` → `Each AWB created exactly once`).
- **iOS safe-area-inset** added to hero top padding so landscape orientation on iPhone 14+ no longer slips behind the address bar.
- **`.trust-icon svg` defensive CSS** keeps the new SVG icons crisp inside the existing 36px chip container.

Both files touched. `tsc --noEmit` clean. All Phase 1–4 wins preserved. Marketing bundle cost: zero new dependencies; ~6 tiny inline SVGs (~80 LOC of JSX).

---

## 1. Files changed

| File | Change | Net |
|---|---|---|
| `apps/web/src/app/(marketing)/page.tsx` | 6 Reliability glyphs → 6 inline SVG icons; 12 `<span className="compare-cell-label">` added inside compare-table cells (6 rows × 2 cells); 6 outer SVG store labels gain `viz-label-store` class + center label gains `viz-label-center` class; 3 pipeline step descriptions reworded to remove developer jargon. | +56 LOC |
| `apps/web/src/app/(marketing)/landing.module.css` | `.trust-icon svg` defensive sizing rule; `.compare-cell-label` (sr-only/visible-on-mobile) replacing the old `::before` pseudo-element labels; `.viz-label-store` hide rule at < 480px; hero padding wrapped with `calc(N + env(safe-area-inset-top))` at all four breakpoints. | +16 LOC |

**Total: 2 files modified. Zero new components. Zero new dependencies. No icon library imported.**

---

## 2. Iconography changes

### 2.1 Reliability section — six inline SVG icons

The six mathematical glyphs are replaced with line-art icons in the existing 36px chip container. All icons:

- 24×24 viewBox, 20px rendered size
- `stroke="currentColor"` (inherits `--c-accent` from `.trust-icon`)
- `stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`
- `fill="none"`
- `aria-hidden="true"` on the wrapping `.trust-icon` (icon is decorative — the h4 carries the meaning)

| Card | Before | After (inline SVG, paths summarized) |
|---|---|---|
| Idempotent ingestion | `{ }` | Circle with checkmark inside — "verified once" |
| Webhooks always replay | `↻` | Refresh / circular-arrow with arrow-tail — "retry loop" |
| Courier outages auto-route | `⊘` | Branching Y-shape — "diverging routes" |
| Concurrent updates don't clash | `∝` | Two arcs converging into one node — "merged versions" |
| Credentials encrypted at rest | `⊞` | Padlock — direct semantic match |
| Raw payloads age out | `⌛` | Clock face — direct semantic match |

The icons are visually consistent (same stroke weight, same size, same color), readable at every breakpoint, and don't read as "developer cosplay." The first four are now meaningful where the previous glyphs (especially `∝` and `⊞`) had no relationship to their labels.

### 2.2 Why inline SVG instead of `lucide-react`

`lucide-react` IS already an `apps/web` dependency (used by the order-detail panels). Importing 6 icons would have been minimal weight — but the marketing route group's `apps/web/CLAUDE.md` directive is "ships ~zero JS that touches auth/tRPC — preserve this." The same posture argues against introducing the **first** icon-library import on the marketing surface. Inline SVGs add ~80 LOC of static JSX, zero runtime cost, zero dependency bytes. They render identically to lucide equivalents.

### 2.3 What stayed

- Logo dot (CSS-only background + box-shadow) — unchanged
- Hero pulse dot (eyebrow indicator) — unchanged
- Final-CTA urgency dot — unchanged (Phase 4 made it static)
- Mobile sticky-CTA arrow glyphs — unchanged
- All `→` arrows in button labels — unchanged

The Reliability section was the only place the audit flagged for "developer-cosplay" iconography. Other surfaces use restrained text + dots, which already read enterprise.

---

## 3. Compare-table improvements

### 3.1 Semantic labels

Each of the 12 bad/good cells (6 rows × 2) now carries a `<span className="compare-cell-label">Without Cordon</span>` or `With Cordon` as a real DOM element. This replaces the previous `.compare-bad::before { content: 'Without Cordon' }` / `.compare-good::before { content: 'With Cordon' }` CSS pseudo-elements that were:

- **Inaccessible** to assistive tech (Safari/VoiceOver in particular ignores `content` text in many configurations)
- **Decorative-only** (couldn't be styled per-cell, couldn't carry their own ARIA, no fallback if CSS fails to load)

### 3.2 Behaviour at each viewport

| Viewport | `.compare-cell-label` behaviour |
|---|---|
| Desktop (> 800px) | `display: none` — column header tags ("Without Cordon" / "With Cordon" pills) carry the context. Avoiding double-announcement for screen readers. |
| Mobile (≤ 800px) | `display: block`, monospace 10px uppercase, color-matched to the cell tone (red for bad, lime for good). Replaces the old pseudo-element labels visually + accessibly. |

### 3.3 What stayed

- The compare-table's div-grid layout with ARIA roles (`role="table"` / `role="row"` / `role="cell"`) — unchanged
- The desktop column header chips (`.compare-tag-bad` / `.compare-tag-good` pills) — unchanged
- The 6-axis row content (RTO rate, calls, courier, webhooks, ops time, reporting) — unchanged
- The mobile collapse layout (`.compare-row { grid-template-columns: 1fr }`) — unchanged

The audit flagged this as a Phase 5 candidate for "semantic refactor — replace with real labels." Phase 5 closes that finding without rebuilding the compare experience.

---

## 4. Mobile readability fixes

### 4.1 SVG fraud-network outer labels

Six store-name labels (`store_a` through `store_f`) at 9px font-size were unreadable on viewports < 400px. Phase 5 splits the `.viz-label` class into two:

- `.viz-label-store` (the six outer dots)
- `.viz-label-center` (the central "cordon" label)

CSS hides only `.viz-label-store` at `< 480px`:

```css
@media (max-width: 480px) {
  .cordonPage :global(.viz-label-store) { display: none; }
}
```

The diagram on small mobile now shows the connection lines + the dash-pulse animation + the center "cordon" label, which is enough to convey the network-of-stores narrative. The peripheral store names were illegible at that size anyway.

### 4.2 Compare-table mobile context labels

Each cell now visually announces its context (Without Cordon / With Cordon) when the column header collapses. Previously the mobile fallback read as a stack of values without explicit context other than the row's axis label.

### 4.3 iOS safe-area-inset

Hero top padding wrapped:

```css
.cordonPage :global(.hero) {
  padding: calc(180px + env(safe-area-inset-top)) 0 80px;
}
```

Plus the same `calc(... + env(safe-area-inset-top))` at the three subsequent breakpoints (1024px / 768px / 480px). On iPhone 14+ in landscape orientation, the dynamic address-bar inset is now respected — the hero content no longer slips behind the address-bar safe area.

---

## 5. Terminology refinements

Three pipeline step descriptions reworded:

| Step | Before | After |
|---|---|---|
| /02 Normalize | `Phone coerced to BD format. Address parsed.` | `Phone normalized to Bangladesh format. Address parsed.` |
| /05 Book | `Best-fit courier picked. Idempotent AWB. Circuit breakers fall through to backups.` | `Best-fit courier picked. Each AWB created exactly once. Circuit breakers fall through to backups.` |
| /06 Track | `Status polled every 5 min. Events deduped. Delivery, RTO, failed — all surfaced live.` | `Status polled every 5 min. Duplicate events suppressed. Delivery, RTO, failed — all surfaced live.` |

**Rationale:**
- "coerced" → "normalized" — `coerced` is TypeScript/PL jargon. `normalized` is operations-engineering vocabulary that ops leaders recognize.
- "Idempotent AWB" → "Each AWB created exactly once" — the latter is the same architecture claim in operator language. Idempotent stays in the Reliability section's first card title (where engineering buyers see it).
- "Events deduped" → "Duplicate events suppressed" — same fact, fewer dev shorthand letters.

These are minor surface tweaks. The Reliability section's body copy (Phase 2) and Cross-merchant network section (Phase 1) already used operator-friendly language at this depth. Phase 5 just brought the Pipeline section in line.

---

## 6. Visual consistency improvements

### 6.1 `.trust-icon svg` defensive sizing

The existing `.trust-icon` flex container styles set `font-family` and `font-size` (relevant when the icon was a unicode glyph like `{ }`). With SVG content these are inert. Added:

```css
.cordonPage :global(.trust-icon svg) { display: block; flex-shrink: 0; }
```

Prevents the icon from being squashed under unusual flex parent sizing (defensive — the existing `display: flex` parent already centers content correctly in normal cases).

### 6.2 Single source of truth for compare-cell labels

The two identical-content pseudo-elements (`.compare-bad::before { content: 'Without Cordon' }` and `.compare-good::before { content: 'With Cordon' }`) became one CSS class (`.compare-cell-label`) styled differently inside `.compare-bad` vs `.compare-good`. Easier to maintain — adding a 7th comparison row in the future doesn't require thinking about CSS pseudo-element ordering.

### 6.3 Consistent SVG class naming

The fraud-network SVG labels split into `.viz-label-store` and `.viz-label-center`, mirroring the BEM-ish naming convention used by `.compare-num-bad` / `.compare-num-good`, `.viz-node` / `.viz-node.center`, etc.

---

## 7. Verification

| Check | Result |
|---|---|
| `apps/web` typecheck (`tsc --noEmit`) | exit 0 ✅ |
| Old reliability glyphs (`{ }`, `↻`, `⊘`, `∝`, `⊞`, `⌛`) in JSX | zero hits ✅ |
| Old developer jargon (`coerced`, `Idempotent AWB`) | zero hits ✅ |
| New `.compare-cell-label` spans | 12 (6 rows × 2 cells) ✅ |
| New SVG icons in Reliability section | 6 ✅ |
| `viz-label-store` / `viz-label-center` classes | 6 + 1 ✅ |
| `env(safe-area-inset-top)` references | 4 (one per hero breakpoint) ✅ |
| New components / dependencies | none ✅ |
| New animations | none ✅ |
| Phase 1 credibility wins preserved | ✅ |
| Phase 2 hero compaction wins preserved | ✅ |
| Phase 3 responsiveness wins preserved | ✅ |
| Phase 4 motion calmness wins preserved | ✅ (no new looping animations introduced) |
| `landing.module.css` LOC | 1541 → 1557 (+16) |
| `page.tsx` LOC | 995 → 1051 (+56) |
| Marketing bundle dependency cost | zero (no `lucide-react` import on the marketing route) ✅ |

---

## 8. Intentionally deferred items

The following audit items remain **out of scope** for Phase 5. Phase 5 was strictly enterprise polish + semantic clarity scope.

| # | Audit ref | Deferred to |
|---|---|---|
| D1 | M9 — JSON-LD FAQPage schema, OpenGraph, Twitter card metadata | Phase 6 (SEO) |
| D2 | MOB9 — `font-display: swap` for Inter / serif / mono fonts | Phase 6 (typography + perf) |
| D3 | E2 / E3 — SOC 2 / ISO 27001 / SSO badges in the Reliability section | Future — needs real artifacts |
| D4 | M1 — 14-section count + section-eyebrow density | Future content-compaction phase |
| D5 | BD2 — Bangla strapline | Future (with translator) |
| D6 | BD8 — WhatsApp footer chip | pending branding-schema field |
| D7 | M8 — Privacy / Terms / Bangladesh address footer links | pending the actual `/legal/*` pages |
| D8 | M2 — Orphan `.price-card.featured.recommended::before` rule | Phase 7 (CSS prune) |
| D9 | Dead CSS rules (`.stat-strip`, `.proof-band`, `.proof-band-dot`, `cordonModalIn` / `cordonFadeIn` keyframes for the unmounted exit modal) | Phase 7 |
| D10 | `exit-intent-modal.tsx` file kept dormant — could be deleted | Phase 7 |
| D11 | A12 — colorblind-friendly compare-table marks (✗ / ✓ icons in addition to color) | Future — requires icon-system decision (lucide-react candidate) |
| D12 | Marketing bundle perf — Next.js `next/font` integration with `display: swap` for both serif italic and mono | Phase 6 |

**None of these are enterprise-polish issues.**

---

## 9. Remaining Phase 6 items (preview)

Phase 6 is the **SEO + perf optimization** pass per the audit's recommended order. Likely scope:

1. **JSON-LD structured data** — emit `Organization`, `FAQPage`, and `Product` schemas in the marketing page metadata. The existing FAQ section is a perfect candidate: its 6 native `<details>` items map directly to FAQPage entries.
2. **OpenGraph + Twitter card metadata** — populate the `metadata` export with `openGraph` / `twitter` fields. Currently only `title` + `description` are set.
3. **`font-display: swap`** — verify Next.js `next/font` is using `display: swap` for Inter / serif / mono, preventing FOIT on slow 3G connections.
4. **Canonical URL** — add a `canonical: 'https://confirmx.ai/'` link.
5. **`<noscript>` fallback verification** — the page already works without JS (counters were removed in Phase 2; the calculator inputs still render but don't compute; static signup CTAs work).

Phase 6 is mostly metadata additions with tiny CSS/typography hooks — likely ~30–50 LOC of `metadata` export + a couple of `<script type="application/ld+json">` blocks. Not blocking production.

---

## 10. Final verdict

Phase 5 is complete and verified. The page now has:

- **Six clean line-art SVG icons** in the Reliability section, replacing developer-cosplay glyphs
- **Real DOM cell labels** in the compare-table — inaccessible pseudo-elements gone
- **Smarter mobile SVG** — peripheral fraud-network labels hide < 480px; center label anchors
- **Operator-language pipeline descriptions** — three pieces of dev jargon retired
- **iOS safe-area-aware hero** — landscape orientation no longer hides content
- **Defensive trust-icon SVG sizing** — guards against unusual flex parent rendering

All Phase 1–4 wins are preserved verbatim. Visual identity, palette, typography system, layout architecture, motion calmness, responsiveness rhythm, sticky/floating layer model — all untouched. The marketing bundle posture is intact (zero new deps).

The page is ready for **Phase 6 (SEO + metadata)** when the operator chooses to schedule it. Phase 7 (code hygiene — dead CSS prune, exit-intent-modal file removal, orphan rule cleanup) remains a non-blocking polish item.
