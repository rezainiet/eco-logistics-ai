# Cordon Web App Surface Map

**Goal:** Complete inventory of routes, layouts, providers, NextAuth wiring, and merchant-facing flows. Accurate enough for canonical SaaS documentation.

**Generated:** May 2026 | **Codebase:** `apps/web` (Next.js 14 App Router)

---

## Architecture Overview

### Provider Wiring

The web app uses a **stratified provider model**:

1. **Root layout** (`apps/web/src/app/layout.tsx`): HTML/body shell ONLY
   - Loads fonts (Inter, Instrument Serif, JetBrains Mono) via `next/font/google`
   - Injects static branding CSS from `getBrandingSync()` (no async, no DB)
   - **No Providers here** — keeps the page coherent even if deeper layouts fail

2. **Marketing layout** (`apps/web/src/app/(marketing)/layout.tsx`): Public surface, zero auth weight
   - Children inherit only the root HTML shell
   - No SessionProvider, no TRPCProvider, no QueryClientProvider
   - Renders: Landing page, legal, pricing

3. **Auth layout** (`apps/web/src/app/(auth)/layout.tsx`): Unauthenticated routes
   - Wraps children in `<Providers>` (SessionProvider + tRPC + QueryClient)
   - Renders `/login`, `/signup`, and wraps them in `CordonAuthShell`
   - Redirects authenticated users to `/dashboard`

4. **Dashboard layout** (`apps/web/src/app/dashboard/layout.tsx`): Merchant workspace
   - Server-side auth gate: `getServerSession(authOptions)` → redirect to `/login?callbackUrl=...`
   - Wraps entire dashboard in `<Providers>`
   - Renders: Sidebar, Topbar, breadcrumbs, modal system, global toaster
   - Sub-providers: `CommandPaletteProvider`, `BrandingProvider`, `I18nProvider`, `TokenRefreshKeeper`

5. **Admin layout** (`apps/web/src/app/admin/layout.tsx`): RBAC-gated admin panel
   - Server-side auth gate: `getServerSession(authOptions)` → redirect to `/login`
   - Role gate: `session.user?.role !== "admin"` → redirect to `/dashboard`
   - Fixed sidebar navigation, separate styling (dark blue theme)

### Providers Component

**File:** `apps/web/src/app/providers.tsx`

The `<Providers>` component wraps all authenticated pages:

```
<SessionProvider>
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  </trpc.Provider>
</SessionProvider>
```

**Key behaviors:**
- Custom CSRF + Bearer token handling: `readCsrfCookie()` reads non-HttpOnly `csrf_token` cookie; `getSession()` retrieves the JWT from NextAuth
- Headers sent on every tRPC call: `Authorization: Bearer {apiToken}`, `x-csrf-token: {csrf}`
- **SESSION_UNAUTHORIZED_EVENT**: Custom DOM event fired by `queryCache.onError` when tRPC returns `UNAUTHORIZED`. `<TokenRefreshKeeper>` listens and attempts silent refresh via `/auth/refresh`; only signs out if refresh itself fails
- **FORBIDDEN code** (403): User is authenticated but lacks permission; no global toast, UI handles it

---

## NextAuth Setup

**File:** `apps/web/src/lib/auth.ts`

```typescript
authOptions = {
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      authorize(credentials) {
        // POST {email, password} to /auth/login (API)
        // Returns: { id, email, name, role, token }
      }
    })
  ],
  callbacks: {
    jwt({ token, user, trigger, session }) {
      // On login: attach user.role + user.apiToken to JWT
      // On silent refresh: extract new apiToken from session.apiToken (passed by TokenRefreshKeeper)
    },
    session({ session, token }) {
      // Attach token.role + token.apiToken to session object
    }
  }
}
```

**Session strategy:** JWT (not database)

**Custom pages:** Sign-in at `/login` (explicit redirect, no modal)

**Token refresh flow:**
1. Browser calls `/auth/refresh` (httpOnly cookies reach the API)
2. API returns new `access_token` JWT in a response field
3. `<TokenRefreshKeeper>` calls `useSession().update({ apiToken })` 
4. NextAuth `jwt` callback fires with `trigger === "update"`, captures the new token
5. All subsequent tRPC calls use the refreshed token

---

## Middleware

**File:** `apps/web/src/middleware.ts`

```typescript
AUTH_ROUTES = ["/login", "/signup"]
PROTECTED_PREFIXES = ["/dashboard"]

middleware(req):
  - If token exists + on AUTH_ROUTE → redirect to `/dashboard/orders`
  - If no token + on PROTECTED → redirect to `/login?callbackUrl={pathname}{search}`
  - Otherwise pass through

config = { matcher: ["/login", "/signup", "/dashboard/:path*"] }
```

**Effect:** Silent enforcer of auth boundaries. Prevents authenticated users from seeing login screen; prevents unauthenticated users from accessing dashboard.

---

## Route Structure

### 1. Marketing Surface (Public)

#### Path: `/`
- **Layout chain:** Root → (marketing) → children
- **Auth gate:** Public (no session check)
- **Purpose:** Landing page. Hero, problem/solution, cross-merchant fraud network, automation modes, integration grid, testimonials, pricing, FAQ, final CTA
- **Key components:**
  - `RoiCalculator`: Interactive calculator showing monthly RTO bleed
  - `FloatingLossIndicator`: Appears after calculator interaction, follows scroll
  - `PricingHighlighter`: Toggles "most popular" badge on plan matching calculator recommendation
  - `ExitIntentModal`: Fires once per session on desktop when cursor leaves toward URL bar
- **Key tRPC:** None (static page)

#### Path: `/pricing`
- **Layout chain:** Root → (marketing) → children
- **Auth gate:** Public
- **Purpose:** Pricing page with four plan cards (Starter / Growth / Scale / Enterprise), feature comparison table, trust points, FAQ
- **Key components:** Generated plan bullets derived from `@ecom/types` PLANS feature gates, not static strings
- **Key tRPC:** None (static)
- **Notable:** `buildPlanBullets()` ensures marketing copy stays synced with runtime feature gates (previous bug: Growth card promised "Shopify + WooCommerce" but runtime allowed only 1 integration)

#### Path: `/legal/privacy`, `/legal/terms`
- **Layout chain:** Root → (legal) → children
- **Auth gate:** Public (no auth wall — required for Shopify Partner app review)
- **Purpose:** Privacy Policy (GDPR compliance, Shopify GDPR webhooks), Terms of Service
- **Key sections:**
  - Data collection (orders, customer details, telemetry, branding)
  - Retention (lifetime during subscription, 90-day webhook audit trail)
  - Customer data requests (`customers/data_request`, `customers/redact` webhooks)
  - Sub-processors (MongoDB, Stripe, Twilio, Shopify, WooCommerce)
- **Key tRPC:** None

---

### 2. Auth Routes (Public, Redirect-Aware)

All auth routes wrap children in `CordonAuthShell` (visual shell matching landing page).

#### Path: `/login`
- **Layout chain:** Root → (auth) → children
- **Auth gate:** Public; redirects authenticated users to `/dashboard`
- **Purpose:** Email + password login
- **Form handling:** `signIn("credentials", {email, password, redirect:false})`
- **Security:** Explicit `method="post"` + `action="/api/auth/__nope"` (defense against credential leaks if React hasn't hydrated)
- **Error:** Generic "email and password don't match" (no email-existence leak)
- **Callback:** `?callbackUrl=...` passed by middleware; defaults to `/dashboard`
- **Key tRPC:** None (submit via `signIn()` → API `/auth/login`)

#### Path: `/signup`
- **Layout chain:** Root → (auth) → children
- **Auth gate:** Public; redirects authenticated users to `/dashboard`
- **Purpose:** Business name + email + password + optional phone
- **Form:** Validates phone against BD format (`+8801XXXXXXXXX`)
- **Submit:** POST to `/auth/signup` (API), then `signIn("credentials", ...)` on success
- **Trust band:** "200+ BD merchants · ৳45 Cr+ RTO prevented"
- **URL param:** `?plan={tier}` to pre-select plan on next billing screen
- **Key tRPC:** None

#### Path: `/forgot-password`
- **Layout chain:** Root → (forgot-password) → children
- **Auth gate:** Public
- **Purpose:** Email-based password reset request
- **Submit:** POST to `/auth/request-reset` (API)
- **Success:** Shows "check your inbox" screen with email confirmation
- **Rate limiting:** 429 → "Too many requests, wait a few minutes"
- **Key tRPC:** None

#### Path: `/reset-password`
- **Layout chain:** Root → (reset-password) → children
- **Auth gate:** Public (token validation happens server-side or in the API)
- **Purpose:** New password entry after clicking reset link
- **URL param:** `?token={...}` supplied by email link
- **Submit:** POST to `/auth/reset-password` with new password + token
- **Key tRPC:** None

#### Path: `/verify-email`, `/verify-email-sent`
- **Layout chain:** Root → individual layouts
- **Auth gate:** Public (optional, for future email verification flow)
- **Purpose:** Email verification (may be added if strict verification becomes a requirement)

---

### 3. Dashboard Routes (Merchant Workspace)

All dashboard routes require `getServerSession(authOptions)` + redirect to `/login?callbackUrl=...` if missing.

#### Path: `/dashboard` (Overview)
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** KPI overview with 7-day trends. Entry point for fresh signups → `NewMerchantRedirect` component routes to `/dashboard/getting-started` on first visit
- **Key tRPC:**
  - `trpc.analytics.getDashboard` — total orders, delivered, RTO, revenue today
  - `trpc.analytics.getOrdersLast7Days` — daily breakdown for chart
  - `trpc.fraud.getReviewStats` — fraud review queue counts
- **Key components:**
  - `StatCard`: KPI tiles with spark lines + trend deltas
  - `ChartCard`: Recharts bar + pie charts (7-day orders/status breakdown)
  - `NewMerchantRedirect`: If merchant has no orders, render checklist
  - `FirstFlagBanner`: 7-day celebration after first risky order detected (localStorage-gated)
  - `NextStepBanner`: Contextual nudge banner
  - `OperationalBanner`: Incident/status banner (env-var driven, non-dismissible if critical)

#### Path: `/dashboard/orders`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Full orders table with filters, bulk actions, automation
- **Filters:** Status (all / pending / confirmed / packed / shipped / delivered / failed), Courier, Customer phone, Date from
- **Pagination:** Cursor-based, 25 rows per page
- **Bulk actions:** Select multiple bookable orders → `BookShipmentDialog` to book couriers
- **Key tRPC:**
  - `trpc.orders.listOrders` — paginated list with filters
  - `trpc.orders.listCouriers` — available couriers (cached 1 min)
  - `trpc.orders.refreshTracking` — poll tracking for a single order
- **Key components:**
  - `CreateOrderDialog` — manual order creation
  - `BulkUploadDialog` — CSV import
  - `BookShipmentDialog` — courier booking for selected orders
  - `TrackingTimelineDrawer` — order event timeline
  - `SampleOrdersPreview` — skeleton preview on first visit (no orders)
  - `BulkAutomationBar` — sticky action bar when rows selected
- **URL params:** `?new=1` (open create dialog), `?bulk=1` (open upload dialog)

#### Path: `/dashboard/integrations`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Connect Shopify / WooCommerce, manage active integrations, import historical orders
- **Key tRPC:**
  - `trpc.integrations.listIntegrations` — active connectors (Shopify, Woo, CSV)
  - `trpc.integrations.connectShopify`, `connectWoocommerce` — OAuth flows
  - `trpc.integrations.importHistorical` — backfill last 25/90 days

#### Path: `/dashboard/integrations/issues`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Webhook delivery status, error log, retry queue
- **Key tRPC:** `trpc.integrations.listWebhookIssues`, `retryWebhook`

#### Path: `/dashboard/fraud-review`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Queue of high-risk orders pending merchant approval / customer confirmation calls
- **Statuses:** `pending_call` (awaiting Twilio call), `no_answer`, `rejected`, `approved`
- **Key tRPC:**
  - `trpc.fraud.getReviewQueue` — orders awaiting action
  - `trpc.fraud.approveOrder`, `rejectOrder` — mark decision
  - `trpc.fraud.manualCall` — trigger Twilio call for order

#### Path: `/dashboard/recovery`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Cart recovery analytics + SMS outreach to customers with abandoned carts
- **Key tRPC:** `trpc.recovery.getMetrics`, `recovery.sendRecoverySMS`

#### Path: `/dashboard/analytics`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Deeper analytics: behavior (customer sessions, cart events), courier performance, RTO trends
- **Sub-paths:**
  - `/dashboard/analytics` — overview
  - `/dashboard/analytics/behavior` — anonymized browsing + intent
  - `/dashboard/analytics/couriers` — per-courier success rates, SLA tracking

#### Path: `/dashboard/billing`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Subscription management, payment methods, invoices, plan upgrades
- **Key tRPC:**
  - `trpc.billing.getSubscription` — current plan, next billing date, status
  - `trpc.billing.listInvoices` — payment history
  - `trpc.billing.createCheckoutSession` — Stripe or bKash/Nagad manual billing

#### Path: `/dashboard/settings`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Team, couriers, automation rules, branding overrides
- **Sub-tabs:** (implied URL structure)
  - Couriers: Add/remove Pathao, Steadfast, RedX API keys (encrypted at rest)
  - Automation: Choose mode (manual / semi-auto / full-auto), set risk thresholds
  - Team: Add/remove users, manage roles
  - Branding: Logo, primary color, display name (propagates to public tracking page)
- **Key tRPC:**
  - `trpc.merchants.getCouriers`, `addCourier`, `removeCourier`
  - `trpc.merchants.getAutomationConfig`, `updateAutomationConfig`
  - `trpc.teams.listUsers`, `inviteUser`, `removeUser`
  - `trpc.branding.getBranding`, `updateBranding`

#### Path: `/dashboard/call-customer`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Manual Twilio confirmation call interface (ops team calls customer, logs result)

#### Path: `/dashboard/api`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** API documentation, webhook events, API key management, replay tools

#### Path: `/dashboard/getting-started`
- **Layout chain:** Root → dashboard → children
- **Auth gate:** Signed-in only
- **Purpose:** Onboarding checklist (shown to fresh merchants via `NewMerchantRedirect`)
- **Checklist steps:**
  1. Connect store (Shopify / Woo)
  2. Import orders
  3. Add courier
  4. Enable automation
  5. Test SMS confirmation
- **Completion tracking:** Derived from dashboard state (no separate progress model)

---

### 4. Admin Routes (RBAC-Gated)

All admin routes:
- Server-side auth: `getServerSession(authOptions)` → redirect to `/login`
- Role check: `session.user?.role !== "admin"` → redirect to `/dashboard` (customer merchant dashboard)
- Styling: Dark theme (separate from merchant dashboard)

#### Path: `/admin` (Dashboard)
- **Purpose:** Admin overview (operational health, queue status)

#### Path: `/admin/billing`
- **Purpose:** Payment risk queue, flagged transactions, chargeback tracking

#### Path: `/admin/fraud`
- **Purpose:** Cross-merchant fraud network status, signal weights, model performance

#### Path: `/admin/alerts`
- **Purpose:** Real-time operational alerts, downtime tracker, incident log

#### Path: `/admin/system`
- **Purpose:** System health, database metrics, API latency, queue depth, worker status

#### Path: `/admin/audit`
- **Purpose:** Audit log of all merchant actions (orders created, integrations connected, settings changed)

#### Path: `/admin/access`
- **Purpose:** Admin user management, role assignments, API key issuance

#### Path: `/admin/branding`
- **Purpose:** Global SaaS branding config (display name, logo, email addresses), overrideable per-merchant

---

### 5. Public Tracking

#### Path: `/track/[code]`
- **Layout chain:** Root → children (NO Providers, static rendering)
- **Auth gate:** Public (anonymous customers)
- **Purpose:** Customer-facing order tracking page (shared link, no account needed)
- **Parameters:** `code` is a public tracking token (opaque, unguessable)
- **Data fetching:** Server-side `fetchPublicTracking(code)` → order summary, timeline events, branding customization
- **Metadata:** Generated dynamically per order (title, description, robots: no-index)
- **Error handling:** "not found" errors render identical to real 404 (never leak internal errors to customers)
- **Key components:**
  - `MerchantHeader` — merchant logo, name, brand color
  - `StatusHero` — large status badge (delivered / pending / failed)
  - `Timeline` — chronological event log
  - `SupportActions` — merchant's support phone/email
- **Styling:** Minimal, customer-friendly (light gray, not dark theme)
- **Key tRPC:** None (server-only)

---

### 6. Payment & Legal

#### Path: `/payment-success`
- **Layout chain:** Root → (payment-success) → children
- **Auth gate:** Public (receipt display, no auth required)
- **Purpose:** Post-payment confirmation screen (Stripe or bKash/Nagad)
- **URL params:** `?plan={tier}&amount={bdt}&currency={...}&session_id={...}&next_billing={iso_date}`
- **Key components:** Receipt summary, invoices link, dashboard CTA

#### Path: `/payment-failed`
- **Layout chain:** Root → (payment-failed) → children
- **Auth gate:** Public
- **Purpose:** Payment failure / retry screen

#### Path: `/legal/terms`
- **Layout chain:** Root → (legal) → children
- **Auth gate:** Public
- **Purpose:** Terms of Service

#### Path: `/legal/privacy`
- **Layout chain:** Root → (legal) → children
- **Auth gate:** Public
- **Purpose:** Privacy Policy

---

## Onboarding State Machine

**File:** `apps/web/src/lib/onboarding/progress.ts`

The onboarding progress is **derived, not persisted**. Five sequential steps:

```typescript
export type OnboardingStepKey =
  | "connect_store"
  | "import_orders"
  | "add_courier"
  | "enable_automation"
  | "test_sms"

deriveOnboardingProgress(state: OnboardingState): OnboardingProgress
  state.hasStoreConnected ← integrations.list().some(connected live provider)
  state.hasFirstOrder ← orders.listOrders({limit:1}).length > 0
  state.hasCourier ← merchants.getCouriers().length > 0
  state.automationOn ← merchants.getAutomationConfig().enabled
  state.smsTested ← orders.listOrders({...}).some(bookedByAutomation)

  return {
    steps: [
      { key: "connect_store", done: hasStoreConnected, ctaHref: "/dashboard/integrations" },
      { key: "import_orders", done: hasFirstOrder, ctaHref: "/dashboard/orders?new=1" },
      { key: "add_courier", done: hasCourier, ctaHref: "/dashboard/settings?tab=couriers" },
      { key: "enable_automation", done: automationOn, ctaHref: "/dashboard/settings?tab=automation" },
      { key: "test_sms", done: smsTested, ctaHref: "/dashboard/orders?test_sms=1" }
    ],
    doneCount, totalCount, percent, nextStep, complete
  }
```

**UI integration:**
- `<NewMerchantRedirect>` on dashboard home — renders onboarding checklist if `complete === false`
- `<ActivationToaster>` — fires once-per-merchant celebration toasts when milestones hit (first risky order, first confirmed order)
- Checklist hides when all steps are done

---

## Key UI Components & Patterns

### Shell Components

- **`Sidebar`** — merchant nav with onboarding progress, team section, integrations quick-links
- **`Topbar`** — breadcrumbs, search (command palette), user menu, notification bell
- **`CommandPaletteProvider`** — keyboard-driven navigation (Cmd+K / Ctrl+K)
- **`TokenRefreshKeeper`** — listens for SESSION_UNAUTHORIZED_EVENT, attempts silent `/auth/refresh`, signs out if refresh fails

### Billing & Onboarding

- **`NewMerchantRedirect`** — checks `onboarding.complete`; if false, redirects to `/dashboard/getting-started`
- **`FirstFlagBanner`** — renders a 7-day celebration card after first high-risk order detected (localStorage-gated)
- **`DashboardBanners`** — contextual notices (trial ending, plan upgrade nudges)
- **`IncidentBanner`** — operational status (env-var `NEXT_PUBLIC_INCIDENT_BANNER_TEXT`; critical = non-dismissible, info/warning = dismissible)

### Forms & Dialogs

- **`CreateOrderDialog`** — manual order entry (name, phone, address, COD amount, customer email)
- **`BulkUploadDialog`** — CSV import (columns: order_number, customer_name, customer_phone, etc.)
- **`BookShipmentDialog`** — select courier + pickup date for multiple orders
- **`TrackingTimelineDrawer`** — order event timeline + status transitions

### Tables & Lists

- **`OrdersCardList`** — mobile-responsive card layout (hidden ≥sm breakpoint, shown on mobile)
- **Recharts integration** — bar + pie charts on dashboard (customizable colors, tooltips)

---

## Key Merchant Flows

### Onboarding Flow
1. Signup → `/signup?plan={tier}` (optional plan preselection)
2. Auto-login via `signIn("credentials", ...)`
3. Redirect to `/dashboard` → `NewMerchantRedirect` routes to `/dashboard/getting-started`
4. Step 1: Connect store `/dashboard/integrations` (Shopify OAuth or WooCommerce API key)
5. Step 2: Import orders (one-click backfill or wait for webhooks)
6. Step 3: Add courier `/dashboard/settings?tab=couriers`
7. Step 4: Enable automation `/dashboard/settings?tab=automation`
8. Step 5: Test SMS confirmation (manual Twilio call or automated via `automationOn=true`)

### Order Ingestion Flow
1. Webhook arrives (Shopify `orders/create`, WooCommerce `order.completed`)
2. Idempotent inbox dedupes via `externalId` + `clientRequestId`
3. Order normalized (phone coerced to BD format, address parsed, history pulled)
4. Risk scored (merchant rules + cross-merchant network)
5. Routed: low → auto-confirm, medium → confirmation call, high → review queue
6. Tracking polled every 5 minutes from courier

### Fraud Review Flow
1. High-risk order lands in `/dashboard/fraud-review` queue
2. Merchant reviews order details (customer name, phone, COD, pattern signals)
3. Approve → order books to courier; Reject → order frozen
4. Medium-risk → Twilio confirmation call triggered (auto or manual)

### Automation Modes
- **Manual:** Merchant approves + books every order
- **Semi-auto:** Low-risk auto-confirm; medium/high in review queue
- **Full-auto:** Low-risk auto-confirm + auto-book; medium gets Twilio call; high in queue

---

## Route Guard & Redirect Summary

| Route Group         | Requires Auth | Requires Role | Fallback                           |
|---------------------|---------------|---------------|------------------------------------|
| `/` (marketing)     | No            | —             | Public                            |
| `/pricing`, `/legal`| No            | —             | Public                            |
| `/login`, `/signup` | No (but redirects if authenticated to `/dashboard`) | — | Authenticated → `/dashboard` |
| `/forgot-password`  | No            | —             | Public                            |
| `/dashboard`        | Yes           | None (merchant) | No session → `/login?callbackUrl=...` |
| `/admin/*`          | Yes           | `admin`       | No session → `/login`; non-admin → `/dashboard` |
| `/track/[code]`     | No            | —             | Public (anonymous customer)       |
| `/payment-success`  | No            | —             | Public                            |

---

## Critical Security & Quality Notes

### Credential Protection

All auth forms use **defense-in-depth** against accidental credential leaks:
1. Explicit `method="post"` (not implicit GET)
2. `action="/api/auth/__nope"` (non-existent endpoint; native fallback gets 404, loud failure)
3. `onSubmit` unconditionally calls `e.preventDefault()`

**Rationale:** If React fails to hydrate (slow bundle, hydration error, JS disabled), native form submission won't leak credentials into the URL.

### CSRF Protection

- Double-submit: `x-csrf-token` header on every mutation (mirrors value in non-HttpOnly `csrf_token` cookie)
- `readCsrfCookie()` extracts token from `document.cookie` on every tRPC call
- API validates signature

### Session Refresh

- HttpOnly access token + secure refresh token (opaque cookie)
- Silent refresh via `/auth/refresh` when 401 encountered
- `<TokenRefreshKeeper>` orchestrates recovery without user intervention
- Only signs out if refresh itself fails (network error, 401 on refresh)

### Webhook Verification

- All inbound webhooks (Shopify, WooCommerce) verified via HMAC-SHA256 over raw bytes
- 5-minute freshness window blocks replay attacks

### Encryption at Rest

- Courier API keys wrapped with AES-256-GCM (envelope encryption)
- Decryption key in separate secret store, rotates on schedule
- Passwords stored as bcrypt hashes (per-installation salt)

### Audit Trail

- Every merchant action logged (order created, integration connected, setting changed, fraud decision)
- Webhook delivery audit trail retained for 90 days (SLA verification, debugging)
- Raw webhook payloads reaped after 30 days (GDPR, storage efficiency)

---

## Branding System

**Dynamic branding** via `@ecom/branding` package:

```typescript
getBrandingSync()
  → reads ENV + hardcoded defaults (no DB, no async, SSR-safe)
  → returns { name, displayName, logoUrl, primaryColor, ... }

buildRootMetadata(branding, opts)
  → generates Next.js Metadata (title, description, OG tags)

renderBrandingCss(branding)
  → outputs CSS custom properties (--brand-primary, --brand-secondary, etc.)
```

**Propagation:**
- Root layout injects `<style>` block with branding CSS (fallback: `globals.css` hardcoded defaults)
- Dashboard layout re-reads from DB-backed resolver (allows admin to edit live)
- Public tracking page (`/track/[code]`) customizes per-merchant (logo, primary color, support email)

---

## Deployment & Environment Notes

- **Port:** 3001 in dev (`npm run dev` from root)
- **API URL:** `process.env.NEXT_PUBLIC_API_URL` (defaults to `http://localhost:4000`)
- **NextAuth secret:** `process.env.NEXTAUTH_SECRET` (required for production)
- **Font loading:** Self-hosted via `next/font/google` (no external requests)
- **Build artifacts:** `.next`, `.tsbuildinfo`, ignored by git (ephemeral)
- **Imagery:** Recharts library for dashboards (no external charting service)

---

## Summary: Route Inventory

**Total routes:** ~28 main pages

- **Public:** 7 (home, pricing, legal/terms, legal/privacy, track/[code], payment-success, payment-failed)
- **Auth (unauthenticated):** 4 (login, signup, forgot-password, reset-password)
- **Dashboard (signed-in merchant):** 10+ (overview, orders, integrations, fraud-review, recovery, analytics, billing, settings, getting-started, call-customer, api)
- **Admin (RBAC-gated):** 8+ (dashboard, billing, fraud, alerts, system, audit, access, branding)
- **Email verification (future):** 2 (verify-email, verify-email-sent)

**Provider coverage:**
- Marketing surface: 0 providers (static, no auth weight)
- Auth + Dashboard: Full stack (SessionProvider + tRPC + QueryClient)
- Admin: Full stack (same providers as dashboard, separate sidebar + styling)
- Public tracking: 0 providers (server-rendered, customer-facing)

---

**Document version:** 1.0 (May 2026)  
**Next review:** After major routing refactors or new feature areas (integrations, analytics expansions)
