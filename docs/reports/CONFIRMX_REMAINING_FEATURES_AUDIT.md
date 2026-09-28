# ConfirmX — Remaining Features Audit (Phase 0)

**Date:** 2026-09-28
**Branch / commit audited:** `feat/landing-pages` @ `54571e5` (identical to the production release `20260928T152113Z-54571e5`)
**Scope:** read-only audit. No code, schema, production data or configuration was changed to produce this report.

Production facts quoted below come from read-only queries run on 2026-09-28 (counts only; no PII).

---

## A. Current architecture

| Layer | What it is | Notes |
|---|---|---|
| `apps/api` | Express + tRPC + Mongoose, BullMQ workers in the same process | 23 tRPC routers (`src/server/routers`), REST webhooks in `src/server/webhooks`, storefront collector in `src/server/tracking/collector.ts`. Runs as `confirmx` user on `127.0.0.1:4000`. |
| `apps/web` | Next.js 14 dashboard (NextAuth, tRPC client, Tailwind) | `app.confirmx.ai` + marketing site `confirmx.ai`. Port 3001. |
| `apps/sites` | Next.js 14 public landing renderer + COD checkout | `<label>.confirmx.ai`, `preview.confirmx.ai`. Port 3002. Host header is the only tenant input (`lib/routing.ts`). |
| `packages/db` | Mongoose models (40 files) | Consumed as `@ecom/db`. Production runs `autoIndex=false`; boot runs `syncIndexes` per model. |
| `packages/landing` | Landing spec, templates, host/slug rules, analytics catalogue, React renderer | Shared by web (editor) and sites (renderer). |
| `packages/types`, `branding`, `config` | tRPC `AppRouter` re-export, brand tokens, shared config | |
| Infra | One Ubuntu 24.04 VPS: Nginx 1.24 (80/443 only), Redis 7 (loopback), MongoDB Atlas, systemd units, `deploy/vps/deploy.sh` (release dirs + symlink + rollback) | **Asterisk shares this VPS** (PID 45478). Nothing in this plan touches it. |
| TLS | `confirmx.ai`, `app`, `api`, `preview` certs + wildcard `*.confirmx.ai` via certbot DNS-01 (Hostinger DNS API hooks in `deploy/vps/acme`) | Port-80 default server already serves `/.well-known/acme-challenge/` from `/var/www/certbot`. |

Tenant model: one `Merchant` document = one workspace (`merchantId` on every tenant record); `MerchantUser` for team members. tRPC `protectedProcedure` / `billableProcedure` derive `merchantId` from the session — never from input.

---

## B/C/D/E. Existing implementation, models, APIs, UI — by feature area

### 1. Accounting / finance — **does not exist**

Searched `apps/*`, `packages/*` for `expense|accounting|cogs|costPrice|unitCost|profit` — no accounting model, router, worker or UI. (Matches were the inventory "ledger" and unrelated words.)

Money data that already exists and must be reused, not duplicated:

| Data | Where | Use for accounting |
|---|---|---|
| Order value | `Order.order.total` (items + delivery), `order.subtotal`, `order.deliveryCharge`, `order.cod`, `order.currency` | Sales revenue (derived, not copied) |
| Order lifecycle | `Order.order.status` (pending → … → delivered / cancelled / rto), `logistics.deliveredAt`, `returnedAt` | Revenue recognition timing |
| Line items | `Order.items[] {name, sku, quantity, price, productId}` | COGS once a unit cost exists |
| Product price | `Product.price`, `compareAtPrice`, `currency` (BDT default) | — (**no cost field**) |
| Courier fee | `AWBResponse.fee` returned by `bookShipment` (`routers/orders.ts:~581`) | **Returned to the client only — never persisted** |
| Merchant counters | `MerchantStats` (per-status counts) | Not a revenue source |
| Billing | `Payment`, `billing.ts`, `manual-payments.ts` | This is ConfirmX's **own** SaaS billing (merchant pays ConfirmX). Must NOT be mixed with merchant accounting. |

### 2. Marketing / attribution — **partial**

| Piece | Status | Where |
|---|---|---|
| Meta Pixel on landing pages | **Complete, in production** | `apps/sites/src/lib/analytics/{meta-pixel,landing-analytics,commerce-events}.ts`, `packages/landing/src/analytics.ts`, per-page config `LandingPage.tracking.{metaPixelId,enabled}`, UI `components/landing/tracking-settings.tsx`, doc `docs/landing-analytics.md`, tests `landing-analytics.test.ts`, `landing-commerce-events.test.ts` |
| Meta event dedup | Complete | `eventID` on every event; `Purchase` fires only after the server created the order, keyed `Purchase.<orderNumber>`, session-remembered |
| Meta CAPI (server events) | **Not implemented** (documented as intentional) | Needs a per-page access token (secret) |
| Storefront tracker (external stores) | Exists | `apps/web/public/sdk.js` → `server/tracking/collector.ts` → `TrackingSession` / `TrackingEvent`; captures `utm_source/medium/campaign`, referrer, landing path, funnel counters (pageViews, productViews, addToCart, checkoutStart/Submit), `resolvedOrderId` |
| Campaign classification | Exists (organic / paid_social / direct / unknown) | `services/intelligence/campaignClassification.ts` (mirrors `lib/intent.ts`); used by analytics campaign-source view and intent scoring |
| Landing-page attribution | **Missing** | Landing checkout (`apps/sites/src/app/api/checkout/route.ts` → `lib/commerce/landing-orders.ts`) forwards **no** UTM / referrer / click ids. Landing orders only carry `source.channel="landing_page"`, `landingPageId`, `landingSlug`. |
| `utm_content` / `utm_term`, `fbclid` / `gclid` / `ttclid`, first-touch vs last-touch | Missing everywhere | |
| Google Analytics 4 / Google Ads conversion | **Missing** (no code, no env) | |
| TikTok Pixel | **Missing** (only "tiktok" in the paid-social lexicon) | |
| Spend / CPA / ROAS | Missing | Needs accounting (manual spend) first |

### 3. Custom domains — **not implemented (model is prepared for it)**

- `LandingPageHost` (`collection: landing_page_hosts`) maps hostname → page; `kind` enum is only `platform_subdomain`; the model comment reserves `kind: "custom_domain"` keyed by full hostname. Hostname is globally unique; released names are held until `reusableAfter` (anti-impersonation) — reusable for domains.
- Routing (`apps/sites/src/lib/routing.ts`) and resolution (`apps/api/src/lib/landing/resolve.ts`) accept only `<label>.<LANDING_ROOT_DOMAIN>` and the preview host; everything else → not found.
- Nginx: unknown hosts hit the default servers (80 → `444` except ACME webroot; 443 → default cert). A comment in the template reserves this spot for custom domains.
- Certificates: wildcard only covers `*.confirmx.ai`. Custom domains need **one certificate per domain** (HTTP-01 via the existing webroot is feasible). **Nginx cannot issue certificates on demand**, and the API runs unprivileged (cannot write Nginx config, run certbot or reload Nginx). → the main design decision (see M/Risks).
- Production: 1 published landing (`mytest.confirmx.ai`, returns 200), 4 drafts, 1 active platform host. No custom domains.

### 4. WooCommerce — **orders side complete; products/inventory missing**

| Piece | Status | Where |
|---|---|---|
| Connection model | Complete | `Integration` (provider `woocommerce`), encrypted credentials (`v1:iv:tag:ct` envelope: `consumerKey`, `consumerSecret`, `siteUrl`), `webhookSecret`, `webhookStatus.subscriptions`, `health`, `counts`, status `pending/connected/disconnected/error/…` |
| Auth | REST API consumer key/secret (merchant-generated in WP admin) with an auth-strategy probe (Basic vs query-string for hosts that strip `Authorization`) | `lib/integrations/woocommerce.ts` (`probeWooAuthStrategy`) |
| SSRF protection | Present + tested | `lib/integrations/safe-fetch.ts`, `tests/woo.ssrf.test.ts` |
| Connect / test / sample / import orders / sync now / pause / resume / disconnect / webhook retry / replay / health / issues | Complete | `routers/integrations.ts` (`connect`, `test`, `fetchSample`, `importOrders`, `syncNow`, `pause`, `resume`, `disconnect`, `retryWooWebhooks`, `replayWebhook`, `getHealth`, `listIssues`, …) |
| Webhooks | Complete: auto-registered (`order.created/updated/deleted`), HMAC `x-wc-webhook-signature` verified, inbox + idempotency (`WebhookInbox`, `source.externalId` unique per merchant), retry worker, tombstones for deleted orders | `webhooks/integrations.ts`, `workers/webhookProcess.ts`, `webhookRetry.ts`, `orderSync.worker.ts`, `order-tombstone.ts` |
| UI | Complete for connection lifecycle | `dashboard/settings/integrations` (+ `/issues`) |
| **WooCommerce OAuth (`/wc-auth/v1/authorize`)** | Missing — merchant pastes keys | Optional improvement |
| **Product import** | **Missing** (`commerceImport` worker only imports orders) | |
| **Inventory sync** | **Missing** | Source-of-truth decision needed |
| Production | 1 WooCommerce integration in `error` state; Shopify: 1 connected, 1 pending, 2 disconnected | |

### 5. Couriers — **code complete & deployed; activation is operational**

- Adapters Pathao / RedX / Steadfast with official webhook auth, polling, status maps, state machine, inventory effects, CAS (Phases 0–1.5, live in `54571e5`). Tests: `courier-*.test.ts`, `couriers/*`, `courier.webhook.test.ts`, `courier-state-machine.test.ts`, `order-status-cas.test.ts`, `nginx-redx-log-redaction.test.ts`.
- Credentials: per merchant in `Merchant.couriers[] {name, accountId, apiKey(enc), apiSecret(enc), baseUrl, enabled, lastValidatedAt, validationError}`; UI `dashboard/settings/couriers`. Encryption key `COURIER_ENC_KEY`. `COURIER_MOCK` switch exists.
- Webhook URLs: `/api/webhooks/courier/<provider>/<merchantId>` (RedX token in query, logged query-less in production Nginx).
- Merchant UI: `book-shipment-dialog.tsx`, `tracking-timeline-drawer.tsx`, `order-commerce-panel.tsx` (manual status incl. "Mark returned").
- **Production:** 1 merchant has a Steadfast courier configured and `enabled: true` (manual booking by that merchant would call Steadfast live — existing, pre-deploy behaviour). 0 merchants have auto-book enabled.

### 6. Stock — **backend complete, UX partial**

`Product.inventory {onHand, reserved}`, `lowStockThreshold`, append-only `InventoryMovement` ledger, `lib/inventory.ts` (only writer; CAS + unique keys), `products.adjustStock` + `products.movements`, UI `stock-dialog.tsx`, `StockBadge` (in stock / low / out + available). Missing: one stock overview table (on hand / reserved / available / low-stock filter).

### 7. Notifications / onboarding — **infrastructure exists, welcome missing**

- `Notification` model: `kind` enum, `severity`, `title/body/link`, `readAt`, **unique `(merchantId, dedupeKey)`** → exactly-once creation is already solved. Router: `list`, `unreadCount`, `markRead`, `markAllRead`. Helper `lib/notifications.ts#dispatchNotification`.
- UI: stored notifications are read only by `components/dashboard/operational-banner.tsx`; the shell `notifications-drawer.tsx` shows derived items (billing, fraud, calls) — not the stored rows.
- Onboarding: `components/onboarding/*` (dashboard hero, checklist, activation moments, new-merchant redirect), welcome **email** (`lib/email.ts`, needs `RESEND_API_KEY` — unset in production).
- No `welcome` notification kind.
- **Production noise:** 1,649 `queue.enqueue_failed` notifications (legacy job-id bug, now fixed) + 16 `automation.stale_pending`.

### 8. Dashboard / navigation

Sidebar (`components/sidebar/Sidebar.tsx`): Dashboard, Orders, Products, (Fraud review), Call customer, Recovery, Analytics, Behavior, Landing pages, + Settings (workspace, couriers, integrations, automation, branding, billing, security, team, api, notifications). No Accounting, Marketing, Courier or Domains entries. KPI components exist (`kpi-bar`, `kpi-grid`, `roi-card`).

---

## F. Existing tests

- `apps/api/tests`: 107 files, vitest + mongodb-memory-server (replica set), full suite 1593 passing at `54571e5`. Tenant-isolation tests exist per router (orders, landing, products, integrations, courier webhooks).
- `apps/sites`: vitest (`test` script). `apps/web`: Playwright e2e (`e2e/golden-path.spec.ts`, Shopify flows) + a few unit tests; `next lint` configured.
- Typecheck: `tsc --noEmit` per workspace; strict API build `build:strict`.

## G. Existing docs / specs

`docs/commerce.md`, `docs/landing-pages.md`, `docs/landing-analytics.md`, Shopify go-live docs, `docs/audits/*` (delivery reliability, fraud, landing UX), `docs/infra/*` (recovery, PBX recovery, migration). **No PRD/spec exists for accounting, marketing attribution, custom domains or WooCommerce product sync** — requirements come from the Phase-1…9 brief.

Discrepancies found:
- `docs/landing-pages.md` lists custom domains as future work — consistent with code.
- `apps/api/CLAUDE.md` mentions Railway; production is now the VPS (`deploy/vps`). Informational only.
- My earlier post-deploy report said production had "0 published landings / 0 hosts" — that query used wrong collection names. **Correct figures: 1 published, 4 drafts, 1 active host (`mytest`)**; `https://mytest.confirmx.ai/` returns 200 with valid TLS.

## H. Complete — I. Partial — J. Missing

| Area | Complete | Partial | Missing |
|---|---|---|---|
| Accounting | — | — | Everything: entries, categories, product cost/COGS, courier cost persistence, reports, UI |
| Marketing | Meta Pixel (landing), storefront tracker + UTM for external stores, campaign classification | Funnel exists for storefront sessions, not landing pages | Landing attribution capture (UTM/referrer/click ids, first/last touch), GA4, Google Ads conversion, TikTok Pixel, Meta CAPI, channel spend/CPA/ROAS dashboard |
| Custom domains | Host model + uniqueness/anti-reuse, ACME webroot | — | Domain model/states, ownership verification, routing, resolution, cert issuance, Nginx inclusion, UI |
| WooCommerce | Orders: connect, webhooks, import, sync, retry, disconnect, UI | — | Product import, inventory sync, (optional) WC OAuth connect |
| Couriers | Code, security, state machine, UI | — | Live activation (operational), readiness checklist UI |
| Stock | Ledger, adjust, movements, badges | UI | Overview table + low-stock view |
| Notifications | Store, dedupe, read state, router | Stored rows barely surfaced in UI | Welcome kind + first-login creation + visible inbox |
| Dashboard | KPIs, nav | — | Accounting/Marketing/Courier/Domains entries, profit KPI |
| Cleanup | — | — | Legacy dead-letter confirmation, orders-index matcher, deploy health polling, (new) 1,649 stale notifications |

## K. Reusable code — do NOT rewrite

- `lib/inventory.ts` (only stock writer), `InventoryMovement` ledger, `products.adjustStock/movements`.
- Order CAS in `updateOrder`, courier state machine (`server/tracking.ts`, `lib/couriers/*`).
- `Integration` model + `lib/integrations/*` (Woo/Shopify adapters, `safe-fetch.ts`, `crypto.ts` envelope encryption, webhook inbox/retry/tombstones).
- `LandingPageHost` (hostname uniqueness + release hold), `normalizeHost` / `extractLandingLabel` (`packages/landing/src/host.ts`), `routeFor` (sites).
- Meta Pixel pipeline (`landing-analytics.ts` event bus → per-provider adapter). New pixels (TikTok, GA4/Ads) should be **added as siblings of `meta-pixel.ts` behind the same event bus**, not a new system.
- `TrackingSession` / `campaignClassification.ts` (extend with google/tiktok/referral, don't fork).
- `Notification` + `dispatchNotification` + unique `dedupeKey`.
- `writeAudit` (`lib/audit.ts`) for accounting audit metadata.
- `deploy.sh` release/rollback flow; `deploy/vps/nginx` template + snippets; ACME webroot.

## L. Risks / blockers

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Custom-domain certificates need root** (certbot + Nginx include + reload); API is unprivileged; VPS is shared with Asterisk | Blocks "Activate → SSL → Live" automation | Root-owned, narrowly-scoped systemd timer ("domain agent") that reads *verified* domains, issues HTTP-01 certs via existing webroot, writes per-domain includes, `nginx -t`, then `reload` (never restart). Nginx reload does not touch Asterisk. Needs explicit approval. Phase 3 can ship app-side first with manual ops activation. |
| R2 | COD revenue timing (placed vs delivered) | Wrong profit if double-counted or counted before cash | Derive sales from orders (never copy into entries); recognise on `delivered` by default; show "pending COD" separately. **Decision needed.** |
| R3 | No product cost today | COGS = 0 for history | Add optional `Product.costPrice`; snapshot `unitCost` onto order items at order creation; history shows "cost unknown" rather than 0. |
| R4 | Courier fee not persisted | Courier expense unknown | Persist `logistics.courierFee` at booking (additive field); allow manual courier-cost entries. |
| R5 | Attribution data is PII-adjacent (referrer, click ids) | Privacy | Store only UTM params, click-id *presence/hash*, referrer **host**, landing path; no IP/UA in attribution; retention via existing `customerDataRetention`. |
| R6 | Pixel/CSP changes on public pages | Could break landing pages | Per-page opt-in (like Meta), CSP origins added only when configured, `LANDING_ANALYTICS=off` kill switch honoured. |
| R7 | Woo inventory sync = two sources of truth | Overselling / drift | Decide direction first (see questions). Default proposal: ConfirmX ledger is authoritative for ConfirmX landing orders; Woo stock import only as `RESTOCK/MANUAL_ADJUSTMENT` movements, never direct writes. |
| R8 | 1,649 stale `queue.enqueue_failed` notifications | Merchant noise in banner | Separate, approved cleanup (mark read / archive), never delete. |
| R9 | One merchant has a live Steadfast config enabled | Manual bookings are real | Existing behaviour; courier readiness phase must not change it without approval. |
| R10 | `settings.local.json` tracked by git and locally modified | Accidental commit of local permissions | Keep excluded from every commit (as instructed). |

## M. Recommended implementation order

Same as the brief with two adjustments: (1) the tiny, low-risk P2 fixes (orders-index matcher, deploy health polling) can go first because they de-risk every later deploy; (2) marketing attribution capture should land before the marketing dashboard so data starts accumulating early.

1. **P2a** `fix(order-index)` + `fix(deploy-health)` (+ dead-letter verification report — no mutation without approval).
2. **Phase 1** Accounting.
3. **Phase 2a** Landing attribution capture (UTM/click ids/first-last touch on orders) — no UI yet.
4. **Phase 2b** TikTok Pixel + GA4/Google Ads adapters (per-page opt-in) + marketing dashboard (spend from accounting).
5. **Phase 7** Welcome notification (small) and **Phase 6** stock overview (small).
6. **Phase 3** Custom domains (app side), then an approved ops plan for certs/Nginx.
7. **Phase 4** WooCommerce product import + inventory sync.
8. **Phase 5** Courier readiness UI/checklist (no activation).
9. **Phase 8** Dashboard/nav consolidation.
10. **Phase 10** Full E2E + launch readiness report.

---

## Proposals

### Data models (all additive, backward compatible, merchant-scoped, `timestamps: true`)

**`FinanceEntry`** (`collection: finance_entries`)
```
merchantId (req, idx)       type: "income" | "expense"
category: string            // key from FINANCE_CATEGORIES (extensible list in code, not an enum rewrite)
amount: number (>0, minor-unit-safe: stored as BDT with 2dp) ; currency: "BDT"
occurredAt: Date            description (≤500)   reference (≤200)
source: { kind: "manual" | "order" | "courier" | "marketing_import", refId? }
status: "active" | "void"   voidedAt, voidedBy, voidReason        // no hard delete
createdBy, updatedBy (MerchantUser/Merchant id)
idempotencyKey (unique per merchant, partial)                       // double-submit safe
indexes: {merchantId, occurredAt:-1}, {merchantId, type, category, occurredAt:-1}
```
Categories (code constant, versioned): income `sales_other`, `other_income`; expense `product_cost`, `courier`, `ads_meta`, `ads_google`, `ads_tiktok`, `office_rent`, `salary`, `other`. Adding a category = adding a key, no migration.

**Sales revenue is not stored as entries** — computed from `Order` by aggregation (`status=delivered` by `logistics.deliveredAt`, currency BDT), so it can never be double-counted. Manual "other income" entries are separate.

**Product/order additions**
- `Product.costPrice?: number` (optional).
- `Order.items[].unitCost?: number` — snapshot at order creation (landing, dashboard, integrations).
- `Order.logistics.courierFee?: number` — persisted from `AWBResponse.fee` at booking.
- `Order.attribution?` — `{ firstTouch, lastTouch }`, each `{ channel, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, clickIdType: "fbclid"|"gclid"|"ttclid"|null, referrerHost, landingPath, at }`.

**Marketing config** — extend `LandingPage.tracking` with `tiktokPixelId`, `ga4MeasurementId`, `googleAdsConversionId`, `googleAdsConversionLabel` (all public IDs, strict regex validation, per page like Meta).

**`MerchantDomain`** (`collection: merchant_domains`)
```
merchantId, hostname (normalized, punycode, unique globally), apexOrWww
target: { kind: "landing_page", pageId }   // or merchant default page — decision needed
status: pending | verifying | verified | active | failed | disabled
verification: { token (random 32B), method: "txt", recordName: "_confirmx-verify.<host>", lastCheckedAt, lastError, attempts }
cert: { status: none|requested|issued|failed, expiresAt, lastError }
activatedAt, disabledAt, disabledReason
```
Activation creates a `LandingPageHost {kind: "custom_domain", hostname}` row so resolution stays single-source.

**WooCommerce** — reuse `Integration`; add `Product.external {provider, integrationId, externalId, syncedAt}` with a unique partial index `(merchantId, external.integrationId, external.externalId)` for idempotent import; `Integration.sync {products: {lastAt, lastError, counts}}`.

**Notifications** — add kind `onboarding.welcome`; created once with `dedupeKey: "onboarding.welcome"`.

### APIs (tRPC, all `protectedProcedure`, merchant from session)

- `finance.summary({range})`, `finance.list({range, type?, category?, cursor})`, `finance.create`, `finance.update`, `finance.void`, `finance.categories`, `finance.monthly({year})`.
- `marketing.channelReport({range})` → channel, orders, delivered revenue, spend (from finance), CPA, ROAS (+ `spendComplete` flag; ROAS shown only when spend exists).
- `landingPages.updateTracking` extended (existing procedure) for TikTok/GA4/Ads IDs.
- Public: landing checkout accepts an `attribution` object (validated, size-capped) → stored on the order.
- `domains.list/add/verify/remove/status`; ops-only `domains.pendingActivation` consumed by the root domain agent (auth: local-only shared secret or file drop — decision needed).
- `integrations.importProducts`, `integrations.productSyncStatus` (Woo).
- `products.stockOverview({filter})`.
- `notifications.list` reused; `onboarding.ensureWelcome` (idempotent) or creation at signup.

### UI

- **Accounting** (`/dashboard/accounting`): period switcher (today / month / year / custom), 8 summary cards (Revenue, Product cost, Courier, Advertising, Office, Salary, Other, Net profit), "Add income / Add expense" dialog (category, amount, date, note), entries table with edit / void, category breakdown, 12-month bar chart, P&L view.
- **Marketing** (`/dashboard/marketing`): channel table (Channel, Spend, Orders, Revenue, CPA, ROAS) with honest "spend missing" states; pixel settings stay on each landing page.
- **Domains** (`/dashboard/domains`): add domain → DNS instructions (TXT + A/CNAME) → Verify → status timeline.
- **Integrations**: Woo card gains "Import products", product sync status.
- **Stock** (`/dashboard/products` tab): table Product / On hand / Reserved / Available / Status / Adjust.
- **Notifications**: bell/inbox listing stored notifications with mark-seen; welcome card.
- **Sidebar**: Dashboard, Orders, Products, Landing pages, Marketing, Accounting, Courier, Domains, Integrations, Settings (existing extras kept, grouped).

### Test plan

Per phase: vitest unit (pure calculators: P&L, attribution classifier, hostname validation, category rules), Mongo integration (tenant isolation A↛B for every new procedure, idempotency, void semantics, revenue not double-counted, COGS snapshot), HTTP tests (checkout attribution caps, domain verify endpoint, Woo product webhook signature), sites tests (pixel loading/CSP per provider, dedup), Playwright for the accounting and domain flows, plus full suite + typecheck + `build:strict` + web/sites builds before each commit. Red/green for every bug fix.

### Migration plan

All changes are additive optional fields and new collections → no data migration, no backfill required. New indexes are declared in schemas and created by the existing boot `syncIndexes` (production `autoIndex=false`). No index is dropped. The orders-index matcher fix removes an existing unnecessary drop/rebuild. Historical orders keep `unitCost`/`courierFee` absent → reports show "cost not recorded" instead of inventing 0.

### Risk assessment

Low: accounting, notifications, stock UI, index fix, deploy polling (app/tooling only). Medium: attribution + pixels (public pages, CSP, privacy), Woo product/inventory sync (data ownership). High: custom-domain activation (root automation, Nginx on the shared VPS, certificate issuance) — application part is medium; ops part requires a separate approval.

---

## Open questions (need answers before the related phase)

1. **Revenue recognition:** count sales revenue when the order is **delivered** (cash collected, recommended) or when it is **placed/confirmed**? Show the other as "pending"?
2. **Currency:** BDT only for accounting (products already default BDT)?
3. **Product cost:** OK to add optional `Product.costPrice` and snapshot `unitCost` on new orders only (history = "unknown")?
4. **Custom domain target:** one domain → one landing page (matches today's host model) or one domain → merchant storefront/default page?
5. **Custom-domain activation:** approve the root "domain agent" design (HTTP-01 via existing webroot, per-domain Nginx include, `nginx -t` + reload), or keep activation manual (ops runbook) for launch?
6. **Google/TikTok config level:** per landing page (like Meta, recommended) or per merchant?
7. **WooCommerce inventory direction:** import Woo stock into ConfirmX once (then ConfirmX authoritative), two-way, or read-only display?
8. **Stale notifications:** may the 1,649 legacy `queue.enqueue_failed` notifications be marked read (not deleted) as part of Phase 9?
