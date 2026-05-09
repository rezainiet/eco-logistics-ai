# Final reviewer risk audit

**Generated:** 2026-05-09
**Branch:** `claude/staging-deploy`
**Scope:** pre-submission sweep for: broken links, placeholder
branding, missing logos, inconsistent naming, dead onboarding flows,
review-trigger wording, unsupported claims, missing support
surfaces. Inline fixes applied where safe.

This is the LAST engineering pass before the brand/ops closeout
items in `shopify-production-gap-matrix.md §9`. Anything still open
here at submission time is either an external-infra dependency or a
documented LOW PRIORITY item.

---

## 0. TL;DR

**One marketing-copy fix applied** (softened "autonomous" + "no
human touch" wording on the landing page automation section).
**No other rendered review-risk text found.**

All other items in this sweep are either:
- ALREADY FIXED in earlier passes (Cordon residue §1; OAuth flow
  hardening; GDPR webhook semantics; replay-safety),
- DOCUMENTED as known organisational closeout (legal entity, email
  infra, brand assets, deploy cutover),
- OR LOW PRIORITY post-approval polish (CSS class names,
  localStorage keys, file-name renames).

---

## 1. Broken links + placeholder URLs

| Surface | Status |
|---|---|
| `homeUrl` `https://confirmx.ai` | DEPENDS ON OPS — must resolve before submit |
| `statusPageUrl` `https://status.confirmx.ai` | DEPENDS ON OPS — only rendered in operational alert emails today; LOW PRIORITY |
| `https://confirmx.ai/brand/email-logo.png` (email header) | DEPENDS ON OPS — broken image in inbox until asset shipped |
| `/legal/privacy` link (Partner Dashboard form) | LIVE — page exists, parametrised on branding |
| `/legal/terms` link (Partner Dashboard form) | LIVE — page exists, parametrised on branding |
| `/api/webhooks/shopify/gdpr/*` (3 GDPR endpoints) | LIVE — handlers + HMAC verified |
| `/dashboard/settings/integrations` (post-OAuth landing) | LIVE — direct routing now lands here (P-4 polish) |
| `/dashboard/integrations` (legacy) | LIVE redirect — preserves query strings |
| External `https://www.shopifystatus.com` link in integrations page | LIVE third-party URL |
| `localhost:4000` / `localhost:3001` fallbacks in client code | DEV-ONLY guards. `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"` is baked at build time; in prod the env-var path always wins. NOT a review risk. |

**No broken links inside the application surfaces themselves.** All
review-relevant links resolve to a live route or depend on the
deploy cutover.

## 2. Placeholder branding

Tracked in `shopify-brand-consistency-audit.md`:

| # | Item | Status |
|---|---|---|
| B1 | Marketing SVG `cordon` label | FIXED |
| B2 | `email.ts` doc-comment | FIXED |
| B3 | `admin-alerts.ts` doc-comment | FIXED |
| B5 | `legalName` placeholder | OPEN — brand/ops |

No other placeholder branding remains in rendered surfaces.

## 3. Missing logos / brand assets

Six asset files missing from `apps/web/public/` (`/brand/logo.svg`,
`/brand/logo-mono.svg`, `/brand/email-logo.png`, `/og.png`,
`/apple-touch-icon.png`, `/favicon.ico` — `apps/web/src/app/icon.svg`
covers the basic favicon path).

**Failure modes if missing at submission time:**
- Email header: broken image in transactional emails (subject line
  + content still readable; email is functional).
- OG previews: title + description render; image slot blank.
- Apple home-screen pin: generic web preview placeholder.
- Browser tab: works (Next auto-icon).

**Severity:** medium. Not strictly review-blocking but leaves a
sloppy first impression. Brand/ops drop-in (no code change).

## 4. Inconsistent naming

| Check | Result |
|---|---|
| Marketing landing wordmark | "ConfirmX" everywhere (post-§1 fix) |
| Auth shell wordmark | "ConfirmX" (explicit) |
| Privacy page header | parametrised `${_brand.name}` → "ConfirmX" |
| Terms page header | parametrised → "ConfirmX" |
| Email templates | `senderName="ConfirmX"`, `replyTo=support@confirmx.ai` |
| SDK console prefix | `[confirmx]` |
| SMS sender brand | `"ConfirmX Ops"` |
| Stripe product prefix | `"ConfirmX"` |
| OG image alt | "ConfirmX — confirm every COD order before it ships" |
| Page title template | "%s · ConfirmX" |
| Last-resort error screen | uses `branding.name` and `branding.supportEmail` |

**No naming inconsistency in rendered text.**

CSS class names (`.cordon-card`, `.cordon-arrow`), localStorage
keys (`cordon:incident:dismissed`), and file names
(`cordon-auth-shell.tsx`) still carry the legacy prefix. These are
NOT visible to reviewers in normal use — see
`shopify-brand-consistency-audit.md §2` for the rationale to defer.

## 5. Dead / broken onboarding flows

| Flow | Anchor | Status |
|---|---|---|
| `/dashboard/getting-started` hero + checklist | `apps/web/src/app/dashboard/getting-started/page.tsx` | LIVE |
| `NewMerchantRedirect` (auto-route to getting-started on first dashboard visit) | `components/onboarding/new-merchant-redirect.tsx` | LIVE |
| Per-step progression queries (couriers, orders, automation, integrations) | `components/onboarding/onboarding-checklist.tsx` | LIVE |
| `FirstFlagBanner` activation moment | `components/onboarding/activation-moments.tsx` | LIVE |
| `NextStepBanner` on dashboard | `components/dashboard/next-step-banner.tsx` | LIVE |
| Setup-checklist deep links | each step routes to the appropriate settings page | LIVE |
| Empty states on dashboard, orders, fraud-review | `components/ui/empty-state.tsx` consumed across pages | LIVE |
| `SampleOrdersPreview` skeleton-of-real-data on order list when no orders | `components/orders/sample-orders-preview.tsx` | LIVE |

**Onboarding flow has no dead-ends.** Every step has a CTA, every
empty state has guidance.

## 6. Review-trigger wording sweep

The positioning constraint (`shopify-listing-wording.md` and
`packages/branding/src/defaults.ts:8-11`) bars: "AI fraud detector",
"customer surveillance", "predictive behavioural AI", "aggressive
fraud enforcement", "autonomous blocking".

Grep results:

| Pattern | Hits | Action |
|---|---|---|
| `fraud detection` | 0 in app surfaces | OK |
| `AI screen` / `AI screening` | 0 | OK |
| `machine learning` | 0 | OK |
| `black box` | 0 | OK |
| `autonomous` | 1 in marketing landing — "fully autonomous" | FIXED (changed to "fully automated") |
| `no human touch` | 1 in marketing landing | FIXED (changed to "hands-off operations") |
| `surveillance` | 0 | OK |

The dashboard's existing copy (review queue, automation modes,
operator decisioning) uses the operationally-correct framing
throughout. The marketing landing now matches.

## 7. Unsupported claims

Marketing landing (`apps/web/src/app/(marketing)/page.tsx`) and the
auth-shell hero make several quantified claims:

| Claim | Source / supportability |
|---|---|
| "200+ BD merchants" | aspirational; if literally <200 at submit time, soften to "Built for BD merchants" or use the actual number |
| "৳45 Cr+ RTO prevented" | aspirational; same issue |
| "99.9% webhook uptime" / "99.9% webhook delivery" | technical claim; replay-safe + DLQ + freshness gate makes 99.9% achievable, but should be backed by a status page (`status.confirmx.ai`) once we have one |

**Recommendation:** brand/ops should confirm these numbers before
submission. If literal numbers are below the claim, either:
- Update the claim to reflect reality, OR
- Soften to qualitative language ("Built for BD's COD economy",
  "Replay-safe webhook delivery").

Reviewers don't fact-check, but quantified claims that are
materially overstated risk merchant trust post-launch.

This is **OUT OF SCOPE for engineering** — copy decision for
brand/ops.

## 8. Missing support surfaces

| Surface | Status |
|---|---|
| `support@confirmx.ai` email link in marketing footer | LIVE (parametrised on branding) |
| `support@confirmx.ai` email link in `/legal/terms §12` | LIVE |
| `privacy@confirmx.ai` email link in `/legal/privacy §9` | LIVE |
| Support widget on dashboard (Intercom, Crisp, etc.) | NONE — `NEXT_PUBLIC_SUPPORT_WHATSAPP` and `NEXT_PUBLIC_SUPPORT_URL` env vars exist (`.env.example:217`) but optional |
| Help-desk URL in branding | `supportUrl: "https://confirmx.ai/support"` — depends on ops shipping that page |
| In-app contact form | NONE — link to email instead |
| Status page link | `status.confirmx.ai` referenced; depends on ops |

**Gap:** if `https://confirmx.ai/support` doesn't resolve,
`branding.supportUrl` is broken. Ops should either:
- Ship a stub `/support` page on `confirmx.ai`, OR
- Set `branding.supportUrl` to a `mailto:` link, OR
- Drop the field if not used in any rendered surface.

Verifying which surfaces consume `supportUrl`:

| Anchor | Renders `supportUrl`? |
|---|---|
| Marketing footer | Uses `supportEmail`, not `supportUrl` |
| `/global-error.tsx` | Uses `supportEmail` |
| Branding admin panel | Edits the field (admin-only) |
| Email templates | Uses `replyTo` (`supportEmail`) |

**Currently no rendered surface consumes `supportUrl`.** Safe to
defer fixing the URL until post-approval — the field is editable
via the admin Branding Panel.

## 9. Findings table

| # | Finding | Severity | Status |
|---|---|---|---|
| R1 | Marketing "fully autonomous" wording | MEDIUM (positioning trigger) | FIXED |
| R2 | Marketing "no human touch" wording | MEDIUM (positioning trigger) | FIXED |
| R3 | `apps/web/public/brand/` directory missing six assets | MEDIUM (review impression) | OPEN — brand/ops |
| R4 | `homeUrl` / `statusPageUrl` resolution | DEPENDS ON OPS | OPEN |
| R5 | Quantified claims ("200+", "৳45 Cr+", "99.9%") | LOW (review fact-check) / MEDIUM (post-launch trust) | OPEN — brand/ops |
| R6 | `branding.supportUrl` not consumed; depends on ops shipping `/support` | LOW | DEFERRED |

## 10. Verification

- `grep -rn "[Cc]ordon" apps/web/src apps/api/src packages` → only
  internal CSS / localStorage / filename / doc-comment references
  remain; no rendered text.
- `grep -rn "autonomous\|no human touch\|fraud detection\|AI screen\|machine learning"`
  in `apps/web/src` and `apps/api/src` → 0 review-trigger hits in
  rendered text.
- `grep -rn "TODO\[brand\]" packages apps` → only the documented
  `legalName`, optional physical-address, optional jurisdiction
  clause remain.
- Marketing landing visual sweep — wordmark "ConfirmX" appears at
  nav, hero, network-graph centre node (post-fix), footer.

## 11. Final pre-submit verification (ops-day-of)

These are run **on the live deploy** before flipping distribution.
Cross-referenced into `shopify-go-live-checklist.md §5b`:

- [ ] `/health` returns 200
- [ ] `/ready` returns 200 with both checks green
- [ ] Boot log shows all 16 workers + 7 sync-index entries
- [ ] Sentry DSN parses (`[boot] telemetry=on`); a deliberate test
      error lands in Sentry
- [ ] Three GDPR webhooks return 401 on invalid HMAC, 200 on valid
- [ ] OAuth happy-path: install → callback → webhooks register →
      first order webhook arrives → review queue surfaces it
- [ ] `grep -ri "[Cc]ordon" apps/web/public` is empty (assets dir)
- [ ] DevTools "Find in page" for "Cordon" on
      `https://app.confirmx.ai/dashboard` finds zero hits
- [ ] `support@confirmx.ai` and `privacy@confirmx.ai` accept mail
      (delivery test from non-confirmx address)
- [ ] DNS: SPF, DKIM, DMARC verified for `confirmx.ai`
- [ ] `https://confirmx.ai` resolves to a coherent landing
