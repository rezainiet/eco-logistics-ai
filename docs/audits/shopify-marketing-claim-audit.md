# Marketing claim audit (review-trigger sweep)

**Generated:** 2026-05-09
**Scope:** every quantified or comparable claim across rendered
public surfaces. For each: risk classification + verify-or-soften
recommendation.
**Rationale:** Shopify reviewers do not fact-check, but quantified
claims that are materially overstated risk merchant trust post-
launch. The submission posture should be defensible.

---

## 0. TL;DR

**Three high-impact claims appear on every login / signup screen
(plus the mini variant on signup) and need verification before
submission:**

1. `200+ BD merchants` — count claim
2. `৳45 Cr+ RTO prevented` — aggregate-impact claim
3. `99.9% webhook uptime` / `99.9% webhook delivery` — SLA claim

**One technical pattern is referenced in a testimonial-style block
on the marketing landing** ("18–22% RTO baseline can drop into the
6–8% band"). Less fact-checkable because it's framed as a "Pattern
· RTO reduction" observation, not a specific testimonial.

The remaining numbers (pricing, calculated examples with all inputs
visible, retention-window statements in legal pages) are factual
product values, not marketing claims.

---

## 1. The trust-band claims (highest review exposure)

### Where rendered

`apps/web/src/components/shell/cordon-auth-shell.tsx:208–220` (mobile)
and lines 279–291 (desktop). The auth shell wraps `/login`,
`/signup`, `/forgot-password`, `/reset-password`, `/verify-email`
— so reviewers see this trust band twice: when they create the
demo account, and again any time they re-authenticate.

`apps/web/src/app/(auth)/signup/page.tsx:204–209` carries a
shorter variant in the signup form footer:
> Used by **200+ BD merchants** · **৳45 Cr+** RTO prevented

### Per-claim risk

| # | Claim | Verifiability | Risk | Notes |
|---|---|---|---|---|
| C1 | `200+ BD merchants` | Brand/ops can verify against the production `Merchant` collection count | HIGH if literal count < 200 | Reviewer-trigger: easily fact-checkable from public LinkedIn / press / a casual ask. |
| C2 | `৳45 Cr+ RTO prevented` | Brand/ops can verify against aggregated `MerchantStats.codSavedTotal` (or equivalent) | HIGH if not aggregable | "Cr" = crore (10 million BDT). ৳45 Cr ≈ USD 4.1M. Specific enough to be challenged. |
| C3 | `99.9% webhook uptime` / `99.9% webhook delivery` | Architecture supports the *target* (replay-safe, DLQ floor, freshness gate, idempotent inbox) but no published SLA backs it | MEDIUM | Three-9s implies ~9 hours downtime per year. We have not measured this in production yet. |

### Recommended replacements (if not verifiable)

If the literal numbers cannot be confirmed before submit, replace
with qualitative language that's defensible:

| Current | Suggested |
|---|---|
| `200+ BD merchants` | `Built for BD merchants` |
| `৳45 Cr+ RTO prevented` | `Designed to prevent RTO at the confirmation stage` |
| `99.9% webhook uptime` | `Replay-safe webhook delivery` |
| `99.9% webhook delivery` | `Idempotent webhook delivery` |

These keep the trust-band visual layout and emphasis intact; only
the words change.

## 2. Marketing landing claims (lower review exposure)

`apps/web/src/app/(marketing)/page.tsx`:

### Calculated examples (LOW RISK — inputs are visible)

| Anchor | Claim | Risk |
|---|---|---|
| `:401–404` | "৳5,40,000+ The monthly bleed. 1,000 orders a month, ৳1,200 average value, 18% RTO" | LOW — math is shown; reviewer can verify (1000 × 1200 × 0.18 × 2.5 ≈ ৳540k for the round-trip cost assumption). Frame is "your bleed if X, Y, Z" — not "we save merchants this much". |

### Pricing (NOT a claim — actual product price)

| Anchor | Value | Risk |
|---|---|---|
| `:1045` | `৳1,990 / mo` Starter | NONE — actual product price |
| `:1064` | `৳4,990 / mo` Growth | NONE |
| `:1088` | `৳12,990 / mo` Scale | NONE |
| `:1110` | `For 25,000+ orders` Enterprise | NONE — capacity descriptor |

### Pattern-style testimonial blocks (MEDIUM — implies typicality)

`(marketing)/page.tsx:772–796` has three "testimonial" blocks
framed as `Pattern · <topic>` rather than as named-merchant quotes.
They imply typical behaviour without claiming a specific merchant
said them.

| Anchor | Excerpt | Risk |
|---|---|---|
| `:772–782` | "When the cross-merchant network flags a buyer who refused parcels at other ConfirmX stores in the same week, the signal is on the order before the courier is booked. One catch can pay for months of subscription." | MEDIUM — "One catch can pay for months" is a value claim. Defensible if true for at least one real catch, but should be backed by data. |
| `:785–796` | "An 18–22% RTO baseline can drop into the 6–8% band on the orders ConfirmX scores — same catalog, same couriers — once fake-order shipping is held back at the pickup stage." | MEDIUM — specific numeric range. If the BD COD market typically runs 18-22% RTO, the 6-8% claim implies ~70% reduction. Real production data would either back this or it shouldn't ship. |

### Recommended

These are NOT shown on the auth shell; they're behind a
`/(marketing)` route reviewers may or may not visit. If brand/ops
can confirm the patterns hold in real data, leave them. If not,
either:
- Drop the specific numbers (~"18–22%" → "high", "6–8%" → "much lower"), OR
- Replace with verified case-study language once a real merchant
  agrees to be named.

### Signal-network value claim (LOW — operational fact)

`apps/web/src/components/shell/cordon-auth-shell.tsx:259-262`:
> Real-time order verification across a cross-merchant signal
> network, automated booking on Pathao / Steadfast / RedX, and
> webhook delivery you can actually trust.

This is product-feature description, not a quantified claim.
Reviewer-safe.

## 3. Things that look like claims but aren't

| Surface | Text | Why it's not a claim |
|---|---|---|
| Privacy page §3 | "...retained for 90 days for debugging and SLA verification" | Operational retention statement (factual policy) |
| Privacy page §5 | "Within 30 days of receipt..." | Shopify-mandated GDPR window |
| Pricing CTA | "Try it free for 14 days" | Actual trial length set in `env.ts` (`TRIAL_DAYS=14`) |
| Pricing CTA | "60 seconds" | Onboarding time estimate; verifiable |
| Onboarding checklist | "about 3 minutes / about 1 minute / about 2 minutes" | Step time estimates; verifiable |
| Webhook health card | "47 received · 100% succeeded" | Live operational data per merchant |

These are factual or per-merchant operational statements; not
marketing claims subject to "is it true on average?" scrutiny.

## 4. Findings table

| # | Finding | Severity | Owner | Current value |
|---|---|---|---|---|
| M1 | `200+ BD merchants` (auth shell + signup) | HIGH (verify-or-soften) | brand/ops | 200+ |
| M2 | `৳45 Cr+ RTO prevented` (auth shell + signup) | HIGH | brand/ops | ৳45 Cr+ |
| M3 | `99.9% webhook uptime` (auth shell mobile) | MEDIUM | brand/ops | 99.9% |
| M4 | `99.9% webhook delivery` (auth shell desktop) | MEDIUM | brand/ops | 99.9% |
| M5 | "One catch can pay for months" testimonial | MEDIUM | brand/ops | left as-is until challenged |
| M6 | "18–22% → 6–8% band" RTO testimonial | MEDIUM | brand/ops | left as-is until challenged |
| M7 | Calculated bleed example ৳5,40,000+ | LOW | — | math visible; defensible |
| M8 | Pricing values | NONE | — | actual prices |

## 5. Decision matrix

For each of M1–M4, brand/ops decides:

| Option | When it fits |
|---|---|
| **Verify and keep** | If the actual production count / aggregate / measured uptime meets the claim, document the source and keep. |
| **Update to real number** | If the actual number is different but defensible, update. ("87 BD merchants" / "৳12 Cr+ RTO prevented" reads more credible than a stretched 200+/45 anyway.) |
| **Soften to qualitative** | If the actual number is materially below or unmeasured, replace with the qualitative alternatives in §1. |
| **Remove the trust band** | Most aggressive option; loses conversion lift but eliminates the entire fact-checkable surface. |

For M5–M6 (testimonial-style patterns):

| Option | When it fits |
|---|---|
| **Keep** | If the patterns are observably true on real production data. Frame is already "Pattern", not a quote. |
| **Soften the numerics** | Replace specific ranges with qualitative ranges. |
| **Replace with verified case studies** | Once a real merchant agrees to be named. |

## 6. Engineering action — what I will do

I'll **apply the soft alternatives now** to M1–M4 unless told
otherwise, on the rationale that:

- The cost of a softened phrase is small (visual layout
  preserved, copy reads as confident product description).
- The cost of a fact-checkable overstatement is high (merchant
  trust, review delays, potential post-launch retraction).
- Reverting is trivial — every change is a single string edit.

For M5–M6, **leave as-is** — they're behind a marketing-only
route, framed as patterns rather than testimonials, and editing
them is a copy decision better made by brand/ops.

If brand/ops can verify M1–M4 against real data, the bolder
phrasing can be re-instated in a single small revert PR.
