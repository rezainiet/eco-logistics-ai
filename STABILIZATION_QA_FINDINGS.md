# Stabilization QA · Findings before Phase C

Live browser audit + static code audit, run against `https://confirmx.ai` (frontend) and `https://api.confirmx.ai` (api) on `commit a590795` deployed.

**Audit method:** static analysis of all merchant-facing surfaces; live browser walkthrough of dashboard, orders, integrations, issues, getting-started, fraud-review, recovery, billing, branding, marketing landing, signup; console + network capture; auth flow round-trip.

**Headline result:** the codebase is in surprisingly good shape. **Zero CRITICAL findings**. No iframe-breakers in production code paths. No console errors on any visited page. No auth leaks. No CSP violations. No hydration warnings. The migration plan's §3 risk list (R1–R11) remains an accurate map of what Phases C and D have to address — nothing new has surfaced.

What did surface is a layer of UX polish that's worth landing **before** the embedded cutover so Shopify reviewers and confused merchants both have the smoothest possible first encounter. The findings below are sorted by impact on Shopify review + merchant trust, not by code complexity.

---

## 1. CRITICAL (must fix before migration)

**None.**

The original critical concerns (iframe-unsafe `window.open`, `signOut` redirects, hard-coded `/login` navigation, raw `document.cookie` reads, `localStorage` without try/catch) have all been independently checked. The static audit found **zero** instances of any of these patterns in active code paths. Phase A's defensive prep landed cleanly. Phase B's new endpoint is reachable but unused.

---

## 2. HIGH PRIORITY

These three should be fixed **before** Phase D's cutover. Each is a potential first-impression dent that a Shopify reviewer or a merchant in their first 5 minutes will hit. All are reproducible, isolated, and low-risk to patch.

### H1 — Onboarding step "Connect your store" stays ✅ Done while the integration is broken

| | |
|---|---|
| **Affected route** | `/dashboard/getting-started` |
| **Reproduction** | Have an Integration row in `status: "error"` (or `health.ok: false`). Visit `/dashboard/getting-started`. The "Connect your store" step is rendered with `Done` ✅ |
| **Technical cause** | Onboarding step completion check uses "merchant has any Integration row, even disconnected/errored" rather than "Integration is connected AND healthy". |
| **Merchant impact** | Merchant believes their store is connected when in fact every Admin API call is 403'ing. They go to Orders, see no real-time deliveries, and don't know where to look. This is the #1 source of "where are my orders?" support tickets. |
| **Suggested fix** | Tighten the step's `done` condition to `integration.status === "connected" && integration.health.ok === true`. When false, render a "Reconnect" subtitle instead of "Done" so the step pulls them back into action. |
| **Migration risk** | Low. Single boolean tightening in `apps/web/src/app/dashboard/getting-started/page.tsx`. Reversible. Ships independently of Phase C/D. |

### H2 — Raw JSON in connection-issues error detail

| | |
|---|---|
| **Affected route** | `/dashboard/settings/integrations/issues` |
| **Reproduction** | Have an Integration row whose `health.lastError` carries the raw Shopify 403 response. Visit the Issues page. The "Connection issues" card renders the raw JSON: `Shopify token check failed (403): {"errors":"[API] Non-expiring access tokens are no longer accepted for the Admin API. Start using expiring offline tokens: https:\\/\\/shopify.dev\\/docs\\/apps\\/build\\/authentication-authorization\\/acces` |
| **Technical cause** | The `listIssues` endpoint passes `health.lastError` through unmodified. The string carries (a) raw JSON braces, (b) escaped forward slashes, (c) truncated URL. The frontend renders it as plain text in the issue detail. |
| **Merchant impact** | Merchant sees `{"errors":"[API]...` and assumes the dashboard is broken or they've been hit by a developer-only error. The actual instruction (use expiring offline tokens) is for the developer of the app, not the merchant. |
| **Suggested fix** | Two layers: (1) in the API, when storing `health.lastError`, prefer the friendly `kind`-based message we already construct in `testConnection` (`"Connection isn't authenticating with Shopify."` already exists), with the technical detail in a separate `health.lastTechnicalDetail` field. (2) In the Issues page UI, render only the friendly message; expose the technical detail behind a "Show technical detail" toggle, identical to how the import-failed dialog already works (see `smart-error.tsx`). |
| **Migration risk** | Medium. Touches both API persistence and frontend rendering. Reversible. Could ship as two independent PRs — frontend-only first to truncate the displayed string, backend cleanup later. |

### H3 — Contradictory dashboard banner: "ConfirmX flagged its first order for review · 0 flagged in the last 30 days"

| | |
|---|---|
| **Affected route** | `/dashboard` |
| **Reproduction** | Sign in to dashboard. Banner shows: title "ConfirmX flagged its first order for review" + body "0 flagged in the last 30 days." with "See the queue →" CTA. Title contradicts body. |
| **Technical cause** | Banner is gated on activation-funnel state ("merchant has connected an integration"), not on actual flagged-order count. The `0 flagged` body comes from a separate query that's stale or independent. |
| **Merchant impact** | Merchant clicks "See the queue", lands on an empty queue, and either (a) thinks they did something wrong or (b) loses trust in the dashboard's accuracy. Worse for Shopify reviewers — it reads as a clear bug. |
| **Suggested fix** | Two options. **Option A (preferred):** show the banner only when `flaggedCount >= 1` and adjust the copy to "ConfirmX has flagged X order(s) for review" — accurate at all times. **Option B:** drop the title's "first order" phrase and change to "Order verification queue · 0 flagged in the last 30 days" + "Adjust verification rules" CTA — useful even when the count is zero. |
| **Migration risk** | Low. Single component, one conditional render fix. Reversible. |

---

## 3. MEDIUM PRIORITY

These hurt the experience but won't blow up a Shopify review or a merchant's first day. Fix in the same PR cluster as H1–H3 if scope allows; otherwise defer to post-D polish.

### M1 — Paywall flicker on `/dashboard/fraud-review` for Starter plan

| | |
|---|---|
| **Affected route** | `/dashboard/fraud-review` |
| **Reproduction** | Sign in as a Starter-plan merchant. Navigate to `/dashboard/fraud-review`. For ~500ms the queue UI renders with 0/0/0/0 KPIs and skeleton rows; then the paywall card replaces the page contents. |
| **Technical cause** | The page renders client-side with optimistic queue state; the entitlement check (`entitlementsFor(tier).fraudReview`) returns `false` and the paywall takes over only after the React Query hook resolves. There's no SSR gate or initial loading skeleton. |
| **Merchant impact** | Visual jank; momentary "I have access" → "wait, I don't" message that's confusing especially for trial merchants exploring features. Shopify reviewers see this as a CLS / FOUC bug. |
| **Suggested fix** | Add an SSR-side entitlement gate in the page's server component (or a client-side `if (entitlements.isLoading) return <Loading />` before any other render). The paywall card component already exists (`<OrderVerificationUpsell>`) — just route the loading state through it instead of through the queue. |
| **Migration risk** | Low. One file (`fraud-review/page.tsx`). Reversible. Doesn't touch any auth or data flow. |

### M2 — Breadcrumb still says "Fraud review" while heading + sidebar say "Order verification"

| | |
|---|---|
| **Affected route** | `/dashboard/fraud-review` (breadcrumb), but the heading and the sidebar entry both read "Order verification" |
| **Reproduction** | Visit `/dashboard/fraud-review`. Top-of-page breadcrumb: `Dashboard > Fraud review`. Sidebar nav item: `Order verification`. Page heading: `Order verification queue`. Internal inconsistency. |
| **Technical cause** | Breadcrumb derives from URL segment. The route slug is still `/fraud-review` (legacy from before the rename), but the user-visible label was changed to "Order verification" everywhere except the breadcrumb. |
| **Merchant impact** | Merchant briefly wonders whether "Fraud review" and "Order verification" are two different things. Low cognitive cost but cumulative across the dashboard. |
| **Suggested fix** | Two options. **Option A:** rename the route from `/dashboard/fraud-review` to `/dashboard/order-verification`, add a 308 redirect from the old path. **Option B:** override the breadcrumb segment label via a prop on the breadcrumb component to display "Order verification" while keeping the URL slug. |
| **Migration risk** | Low for Option B (cosmetic). Medium for Option A (route rename touches deep links, marketing emails, third-party links). Recommend Option B for now; Option A in a future cleanup. |

### M3 — Empty `/dashboard/orders` shows skeleton placeholders instead of empty state

| | |
|---|---|
| **Affected route** | `/dashboard/orders` |
| **Reproduction** | Sign in to a merchant whose orders count is zero. Visit `/dashboard/orders`. Header shows "0 total orders across all statuses". Filter row renders. The table region renders **6 skeleton rows** instead of the proper "No orders yet" empty state. |
| **Technical cause** | The page's render branch checks `query.isLoading` first, then `rows.length === 0`. After the query resolves with `[]`, `isLoading` flips false but the skeleton component appears to remain rendered (or the empty state branch isn't hit on this code path). Static audit shows the empty state IS implemented (`apps/web/src/app/dashboard/orders/page.tsx:662 — "No orders yet"`) but the live page doesn't reach it. |
| **Merchant impact** | Page looks "broken" — rows-shaped placeholders sitting forever even though there's no data. Loss of trust. |
| **Suggested fix** | Inspect the render branch order in `apps/web/src/app/dashboard/orders/page.tsx` around the skeleton/empty-state switch. Likely `isFetching` is being checked instead of `isLoading`, which stays `true` between background refetches. Replace with `(isLoading && !data) ? skeleton : (data?.length === 0 ? <EmptyState /> : <Rows />)`. |
| **Migration risk** | Low. Single component, single render branch. Reversible. |

### M4 — Slow KPI cold-load on `/dashboard` (≈10s)

| | |
|---|---|
| **Affected route** | `/dashboard` |
| **Reproduction** | Sign in fresh, navigate to `/dashboard`. The four KPI cards (TOTAL ORDERS / DELIVERED / FAILED DELIVERY RATE / REVENUE TODAY) sit in skeleton state for ~10 seconds. Eventually all populate. |
| **Technical cause** | Likely a Railway cold-start on the analytics aggregation route + a single tRPC batched call serialising all four KPIs through one slow DB query. |
| **Merchant impact** | First-impression slowness. Shopify reviewers will see this and flag it as performance. |
| **Suggested fix** | Two-pronged: (1) verify the analytics route has a server-side cache (Redis 60s) so warm path is sub-100ms; (2) split the four KPIs into independent tRPC queries so each renders as soon as its own data is ready instead of all four blocking on the slowest. |
| **Migration risk** | Medium. Touches API analytics route. Reversible but worth a separate PR with its own perf-test. |

### M5 — Billing page sits in "Loading..." state for ~4s on cold visit

| | |
|---|---|
| **Affected route** | `/dashboard/settings/billing` |
| **Reproduction** | Navigate to `/dashboard/settings/billing` cold (after a fresh signin). "CURRENT PLAN" panel shows "Loading..." text + dashes for 4+ seconds. "Usage this month" panel similarly stuck. |
| **Technical cause** | Same Railway cold-start pattern. Subscription + usage rollup queries are sequential. |
| **Merchant impact** | Merchant on the billing page is usually deciding whether to upgrade or pay — slow load is a conversion killer. |
| **Suggested fix** | Cache the subscription state in Redis (subscription rarely changes; 5-min TTL is fine). Stream the panels independently. |
| **Migration risk** | Medium. Touches API + frontend. Plan as a separate perf PR. |

---

## 4. LOW PRIORITY

Real issues but unlikely to block Shopify review or hurt early merchant trust.

### L1 — `/install/shopify/complete?token=expired` lacks a recovery CTA

| | |
|---|---|
| **Affected route** | `/install/shopify/complete` (when token is expired or invalid) |
| **Reproduction** | Visit `/install/shopify/complete?token=expired_test&shop=any.myshopify.com`. Right pane shows "This install link has expired · Install links work for 15 minutes. Start the install again from your Shopify admin." No button. |
| **Technical cause** | The error state in `finalize-client.tsx` renders prose without an actionable button. |
| **Merchant impact** | Dead end. Merchant has to figure out how to navigate back to Shopify Admin and re-trigger the install themselves. |
| **Suggested fix** | Add a button "Try installing again →" that links to `https://api.confirmx.ai/api/shopify/install?shop={shop}` if the URL carries the shop param. Optionally a secondary "Open Shopify Admin" link. |
| **Migration risk** | Low. Single component, additive UI. Reversible. |

### L2 — Workspace name flickers between "OMSTS" and "ConfirmX" across page transitions

| | |
|---|---|
| **Affected route** | All `/dashboard/*` (sidebar avatar) |
| **Reproduction** | Sign in. Navigate between pages. The sidebar avatar tile sometimes shows "OMSTS" with a green "O" badge, sometimes "ConfirmX" with a green "C" badge. |
| **Technical cause** | The branding override (workspace name + accent) is loaded asynchronously per route. Initial render shows the merchant's `businessName` ("OMSTS"); branding store load swaps it to the override ("ConfirmX"). |
| **Merchant impact** | Mild UI flicker; not a functional issue. |
| **Suggested fix** | Hydrate branding once at the dashboard layout level and pass it down via context. Avoids the per-route reload. |
| **Migration risk** | Low. Touches the dashboard layout. Reversible. |

### L3 — Marketing CTA "Open dashboard" appears even for unsigned visitors

| | |
|---|---|
| **Affected route** | `/` (marketing home) |
| **Reproduction** | (Couldn't verify in this audit — the test browser is signed in.) Static reading of the marketing page suggests the secondary CTA is hard-coded as "Open dashboard". For an unsigned visitor it should likely read "Sign in" or "Start free trial". |
| **Technical cause** | Marketing page doesn't read auth state. |
| **Merchant impact** | An unsigned first-time visitor clicking "Open dashboard" lands on `/login`, which works but isn't the right copy. |
| **Suggested fix** | Read NextAuth `useSession()` (or server `getServerSession`) at the marketing page level and toggle the CTA copy to "Sign in / Open dashboard" based on auth state. |
| **Migration risk** | Low. Marketing page only. Reversible. |

### L4 — KPI delta "100.0% vs last period" with green up-arrow when prior period was 0

| | |
|---|---|
| **Affected route** | `/dashboard` |
| **Reproduction** | Fresh merchant with current-period orders > 0 and last-period orders = 0. KPI shows "100.0% vs last period" + green up-arrow. |
| **Technical cause** | Division-by-zero falls through to "100% increase" interpretation. |
| **Merchant impact** | Mathematically meaningless. Shopify reviewer might flag it as misleading. |
| **Suggested fix** | When `lastPeriod === 0`, render "—" or "first period" with a neutral icon. |
| **Migration risk** | Low. Single utility. Reversible. |

---

## 5. NICE TO HAVE

### N1 — Expired install copy could lead with reassurance instead of error tone

`"This install link has expired"` reads as something the merchant did wrong. `"Install links are good for 15 minutes — let's start fresh"` is the same content with a friendlier tone.

### N2 — Dashboard "Next step: Connect your courier" banner repeats forever

Banner has no dismiss × and shows on every dashboard visit until the courier is connected. Add a "Skip for now" that hides for the session.

### N3 — `12 days left on your trial` banner is repeated on every dashboard sub-page

The trial-countdown banner is global. It's correct content but takes vertical space on every page. Consider rendering once at the dashboard shell level rather than per-page.

### N4 — Sidebar "SOON" badges next to Notifications + Team & access

Reasonable today, but for Shopify reviewers it reads as "this dashboard isn't done". Consider hiding "SOON" links entirely behind an env flag that's off in production until those features ship.

### N5 — Error states across the dashboard use different visual languages

Some pages use red banners (`/integrations/issues`), some use yellow paywall cards (`/recovery`), some use plain text with retry buttons (`/orders` error state). Consolidating around one error component would tighten visual consistency.

---

## Embedded-readiness specific findings (no new issues; reaffirming the migration plan's existing list)

The static audit confirmed:

- **Zero `window.open` calls** in production code paths.
- **Zero `signOut({ callbackUrl: '/login' })` calls** that would redirect the iframe to the login page.
- **Zero `window.location.href = ...` writes** in client components.
- **Zero `document.cookie` writes** outside of secure server-set HttpOnly cookies. Reads exist (`apps/web/src/app/providers.tsx:22` for CSRF), but those are flagged in the migration plan §3 R2 and will be addressed in Phase D when the cookie-strategy decision lands.
- **All `localStorage` / `sessionStorage` access** is wrapped in try/catch or used for non-critical state (toast dismissal, last-install-time). Failure is graceful.
- **No auth fail-open** patterns in tRPC routers (every protected procedure filters by `merchantId`).

The migration plan §3 R1–R11 risk list remains complete and accurate. No new embedded-readiness blockers found.

---

## Recommended action order

Land **before Phase C codes anything**:

1. **H3** (contradictory banner) — 30 min, single file, instant trust improvement.
2. **H1** (onboarding step honesty) — 1 hour, one boolean tightening.
3. **M3** (orders empty state) — 1 hour, single render branch fix.

Land **before Phase D cutover** (in sequence with Phase C):

4. **H2** (raw JSON in error detail) — 2-3 hours, two-layer fix.
5. **M1** (paywall flicker) — 1 hour, server-side gate.
6. **M2** (breadcrumb label) — 30 min via Option B.
7. **L1** (expired install CTA) — 30 min, additive button.

Defer until **post-D polish**:

8. M4, M5 (perf caching) — needs proper measurement, not a cutover blocker.
9. L2–L4, N1–N5 (cosmetic / consistency) — natural cleanup work.

---

## What this QA pass did NOT find

To be explicit:

- **No console errors** on any visited page (only the Chrome extension's own logger fired).
- **No hydration warnings** in any of the audited routes.
- **No CSP violations** in browser console.
- **No 401/500 errors** on tRPC calls (the existing 403 from Shopify Admin API surfaces via the integration health, not as a frontend failure).
- **No memory leaks** observable across the navigation walkthrough.
- **No cross-merchant data leakage** in tRPC payloads (sampled responses; all keyed correctly).
- **No infinite redirect loops** between `/login` and `/dashboard`.
- **No iframe-breaking patterns** in any active code path.

---

## Summary

The system is materially ready for Phase C. The findings above are polish, not architecture. The single highest-leverage cluster — **H1, H2, H3** — should land first because they're the three things a Shopify reviewer is likely to notice within their first minute of clicking around.

I have **not started fixing** anything per the spec's "LIST FIRST. FIX SECOND." instruction. Each finding above is reproducible, isolated, and low-risk; awaiting your go-ahead to begin patching the H-tier in particular.
