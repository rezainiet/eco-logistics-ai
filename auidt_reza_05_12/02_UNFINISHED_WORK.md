# 02 — Unfinished Work (brutal, file-anchored)

> What is **stubbed**, **partial**, or **missing**. This is the doc to read
> before any external commitment ("we'll demo to merchant X next Tuesday").

Verdict legend:
- **REAL** — works end-to-end against the live service.
- **PARTIAL** — most of the path is wired; specific feature flag, fallback, or
  edge case is open.
- **STUBBED** — adapter or page exists but emits placeholder behaviour.
- **MISSING** — referenced in plans but no implementation in the repo.

## 1. SMS pipeline — PARTIAL (mid-migration, uncommitted)

- `lib/sms/sslwireless.ts` — REAL. Live HTTP POST, 8 s timeout, sender-id
  + msisdn normalisation. Tests exist (`tests/sms.test.ts`).
- `lib/sms/bulksmsbd.ts` — REAL adapter, **but currently untracked in git**.
  Dedicated test `tests/bulksmsbd.test.ts` likewise untracked.
- `lib/sms/index.ts` — provider selector. Six templates
  (OTP, order confirmation, delivery update, expiry, etc.). **Sender ID is
  read from env, not from merchant config** → no per-merchant branded SMS.
- `lib/twilio.ts` — deleted in working tree (replaced by `lib/voice/twilio.ts`)
  but the deletion is **not committed**.
- DLR via `/api/webhooks/sms-dlr` — REAL, HMAC-verified
  (`SMS_WEBHOOK_SHARED_SECRET`). Dev bypass with warning.
- Inbound via `/api/webhooks/sms-inbound` — REAL, modified in working tree
  (uncommitted).
- `lib/confirmation-outcome.ts` — NEW, untracked. Suggests the
  reply/DLR → state-machine consolidation is in flight.

**Action**: commit (or revert) the SMS migration as one atomic PR before
deploy. Leaving it half-staged is the single highest deployment risk in the
repo today.

## 2. Voice / IVR — STUBBED (the most consequential gap)

- `lib/voice/index.ts` — provider abstraction. Default `stub`.
- `lib/voice/stub.ts` — REAL stub: logs to stdout, returns synthetic call IDs.
- `lib/voice/twilio.ts` — **demo-only**. Hardcoded TwiML
  `http://demo.twilio.com/docs/voice.xml`. `initiateConfirmationCall()`
  **throws `NOT_IMPLEMENTED`**.
- `lib/voice/types.ts:25` — comment: *"PR 2 wires the BD adapter."*
- `lib/voice/types.ts:8` — comment: *"Bangladeshi recipients largely ignore
  foreign caller IDs — real production traffic must terminate on a BD-local
  provider."*

This matches saved memory `project_call_stack_state`. **No BD-local IVR
adapter exists.** The `call` tRPC router exposes `initiateOutboundCall` only;
confirmation IVR will return 501 if invoked.

**Action**: either disable Voice from the UI for soft launch and label it
"coming Q3", or integrate a BD-local provider (Banglalink Engage, Robi
voiceXML, or a local CPaaS) before public claims about IVR confirmation.

## 3. Courier integrations — REAL (booking) / STUBBED (history backfill)

- `lib/couriers/pathao.ts`, `redx.ts`, `steadfast.ts` — REAL. AWB create,
  tracking fetch, price quote, webhook HMAC verification, circuit breaker.
- `lib/couriers/webhook-registration.ts` — **NOT auto-registration**. Returns
  copy-pasteable instructions for merchant to paste into courier portal.
  Documented in code comments as the deliberate "reality check".
- `lib/external-delivery/providers/pathao.ts`, `redx.ts`, `steadfast.ts` —
  STUBBED. `isConfigured()` returns false; throws `stub_unconfigured`.
  Comment: *"real HTTP call lands when API access is wired."*
- `lib/external-delivery/providers/bdcourier.ts` — REAL fallback aggregator.

So **shipment ops** (create / track / cancel) work. **Historical performance
import** from each native courier is stubbed; today only the BDCourier
aggregator drives external performance profiles.

## 4. Shopify / WooCommerce — PARTIAL (scope blocker documented)

- OAuth: REAL (apps/api/src/server/webhooks/integrations.ts).
- Public install + claim-token flow: REAL
  (`apps/web/src/app/(direct)/install/shopify/complete`).
- Token refresh: REAL (`lib/integrations/shopify-token-refresh.ts`).
- GDPR webhooks: REAL.
- **Embedded App Bridge** (`apps/web/src/app/(embedded)/`): PARTIAL. Layout
  exists. **CSP is still `frame-ancestors 'none'`** — the iframe Shopify Admin
  uses will be blocked. Phase D not flipped on.
- **Order import after install**: PARTIAL. No on-install backfill of recent
  orders. `orderSync.worker.ts` polls every ~5 min as a *recovery rail*, not
  an install-time backfill. → New merchant lands on an empty dashboard.
- **Shopify scope issue**: documented in root `SHOPIFY_SCOPE_ISSUE_ANALYSIS.md`.
  Shopify now requires `read_customers_private_data` to read phone/email/
  address embedded in orders. Older installs missing this scope will silently
  fail to import customer details. Re-auth required.

## 5. Billing — PARTIAL

- Stripe subscriptions + portal + webhooks: REAL.
- **Stripe card checkout for one-off payments**: NOT WIRED. Billing UI literally
  reads *"Manual card receipt (Stripe coming soon)."*
- Manual payments (bKash, Nagad, bank): REAL, with sophisticated cross-merchant
  fraud detection in `lib/manual-payments.ts` (txnId / proof-file / metadata
  reuse → dual-approval at score ≥ 60).
- Trial / grace / dunning workers (`trialReminder`, `subscriptionGrace`):
  REAL — both **modified in working tree, uncommitted**.

## 6. Fraud / intelligence — REAL (but tunable, not learnt)

- `lib/address-intelligence.ts` — REAL, deterministic, explainable. BD lexicon
  (mosque, bazar, thana, etc.) lives in `lib/thana-lexicon.ts`.
- `lib/fraud-network.ts` — REAL. Cross-merchant hash-based signal exchange.
- `lib/anomaly.ts` — PARTIAL. Hooks present; fired by `riskRecompute`. Exact
  threshold tuning unclear.
- `fraudWeightTuning` worker — REAL but conservative. Weights are tunable;
  there is no ML training loop. This is honest, not a flaw.

## 7. Workers — all wired, none dead

All 19 workers in `apps/api/src/workers/` are registered in `index.ts`. None
are stubs. The new `customerDataRetention.worker.ts` runs daily.

The only items flagged are:
- `subscriptionGrace.ts` and `trialReminder.ts` are uncommitted in working tree.
- `pendingJob` outbox semantics rely on the consumer being idempotent — it is.

## 8. Admin surfaces — PARTIAL

- `apps/web/src/app/admin/page.tsx` — REAL. Live tRPC queries:
  `adminObservability.systemHealth`, `fraudOverview`, `paymentOverview`,
  `adminAudit.search` with 30–60 s refetch.
- Sub-pages: `access`, `alerts`, `audit`, `billing`, `branding`, `fraud`,
  `system` — all backed by tRPC routers. Most read paths LIVE; some write
  actions on `admin/billing` not exhaustively traced.
- `lib/admin-rbac.ts.new` — **untracked sibling** of the live file with a
  duplicate `throw new TRPCError` near line 147. If ever swapped in, it
  won't compile. Either merge the intended changes or `rm` the file.
- `lib/audit.ts.new` — similar sibling. Reconcile.

## 9. Public tracking — REAL

`apps/web/src/app/track/[code]/page.tsx` is SSR, branded, IP-rate-limited,
shows timeline + masked address. **English only** — no Bangla rendering.

## 10. Onboarding / time-to-value — PARTIAL

- `dashboard/getting-started/` exists; the checklist is real.
- **No demo order / sandbox data**. A prospect must connect a real Shopify
  store and wait for real orders before they can see SMS confirmation fire.
- **No "send me a test SMS to my own phone" button** in the dashboard. The
  script `apps/api/src/scripts/sendTestConfirmation.ts` exists (untracked)
  but is CLI-only, not surfaced in product.

## 11. Notifications / Team / Embedded — explicit "Coming Soon" stubs

These are visible to merchants in production navigation:

| Route | Status |
|-------|--------|
| `dashboard/settings/notifications` | `<ComingSoon />` — *"Today every operational alert is hard-coded."* |
| `dashboard/settings/team` | `<ComingSoon />`. |
| `billing` UI (Stripe card method) | *"Stripe coming soon."* |
| `(embedded)/` | exists, CSP not flipped → still 403 in Shopify iframe. |

## 12. Tests — strong unit, weak integration

- ~95 test files in `apps/api/tests/`.
- Solid coverage on: SMS, courier adapters, address intelligence,
  fraud-network, auth/session, shopify-exchange.
- **No end-to-end flow test** for: Shopify webhook → DB → confirmation SMS →
  DLR → outcome update. The riskiest path is the least covered.
- Playwright e2e exists in `apps/web/e2e/` — coverage of the public tracking
  page in particular is missing.

## 13. Items present in plans but not in code

Grep + repo scan turned up **no** implementation for:

- **WhatsApp** confirmation channel. (Order automation state enum suggests
  forethought, but no provider adapter, no template, no worker.)
- **STOP / opt-out** SMS reply handling. The inbound webhook routes
  `YES <code>` / `NO <code>` only — no global unsubscribe semantics.
- **Customer-facing language picker** on `/track/[code]`.
- **Merchant-configurable SMS templates** (the database/Schema does not
  store per-merchant templates today; sender id and body are env/code-bound).
- **In-app status page link** or incident banner. No `StatusBanner` component.
- **In-app changelog / what's-new**. No surface.
- **Multi-language UI** (i18n). Dashboard is English-only.

## 14. Files that should not exist on disk

Recommend `git clean` (after careful diff) of:

- `apps/api/src/lib/admin-rbac.ts.new` — broken sibling.
- `apps/api/src/lib/audit.ts.new` — sibling, reconcile or delete.
- Root-level audit `*.md` that are stale (>20 of them). Move to `docs/archive/`.

## 15. Quick scorecard

| Capability | State |
|------------|-------|
| Outbound SMS (transactional) | REAL (uncommitted migration in flight) |
| SMS DLR + inbound replies | REAL |
| Bangladesh IVR voice confirmation | STUBBED — **blocker** |
| Courier shipment booking | REAL |
| Courier history backfill | STUBBED (Phase 4A) |
| Shopify install + GDPR | REAL |
| Shopify embedded app | PARTIAL (CSP still blocks iframe) |
| WooCommerce | REAL (basic) |
| Stripe subscriptions | REAL |
| Stripe one-off card | NOT WIRED |
| bKash / Nagad manual | REAL + fraud-checked |
| Risk / intent scoring | REAL, explainable, tunable |
| Fraud network (cross-merchant) | REAL |
| Address intelligence (BD) | REAL |
| Public tracking page | REAL (English only) |
| Admin dashboard | REAL (read), mostly REAL (write) |
| Worker farm (19) | REAL |
| Idempotency + DLQ | REAL |
| Email transactional (Resend) | REAL |
| Observability (logs/metrics/Sentry) | PARTIAL |
| GDPR + retention | REAL |
| BD DPA-specific surface | MISSING |
| Merchant notification settings | STUBBED ("Coming soon") |
| Merchant team / seats | STUBBED ("Coming soon") |
| In-app sandbox / demo data | MISSING |
| Per-merchant SMS template editor | MISSING |
| WhatsApp channel | MISSING |
| SMS STOP/opt-out | MISSING |
| Customer language picker (tracking) | MISSING |

## 16. The two minimum cuts before soft launch

1. **Decide the SMS migration commit boundary.** Either:
   - Commit `bulksmsbd.ts`, `confirmation-outcome.ts`, the `sms/index.ts`
     changes, the worker changes, and `voice/` as one atomic PR; OR
   - Stash all of it and ship the soft launch with SSL Wireless only.

2. **Hide Voice/IVR from the merchant UI**, or label it explicitly
   *"Bangladesh local voice — closed beta, contact us."* The current code
   path will 501 in production and look broken.
