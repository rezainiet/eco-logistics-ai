# Reviewer test flow — ConfirmX

**Read-time target:** under 2 minutes.
**Audience:** the Shopify Partner reviewer assigned to our Public
Distribution Unlisted submission.
**Companion docs:** `shopify-app-distribution.md` (distribution
rationale), `shopify-listing-wording.md` (per-scope justifications),
`shopify-go-live-checklist.md` (deploy assumptions).

This page is the single document a reviewer should land on if they
ask "what is this and how do I test it?". Everything review-relevant
is here, in order.

---

## 1. What ConfirmX is

**ConfirmX is COD operational intelligence and order confirmation
infrastructure for Bangladesh-based Shopify merchants.**

For each new order, ConfirmX:

1. Verifies customer details (phone, address) against operator-tunable
   thresholds.
2. Routes the order into one of three operator buckets — **auto-confirm**,
   **confirmation call**, or **human review**.
3. Books the courier (Pathao / Steadfast / RedX) when the merchant or
   operator confirms.
4. Surfaces tracking events back to the merchant's dashboard.

**What ConfirmX is NOT:** an autonomous fraud detector. The system
surfaces signals; the operator decides. Every threshold is tunable;
every action is audit-logged; every webhook is HMAC-verified and
replay-safe.

**Positioning constraint:** COD operational intelligence + order
confirmation infrastructure. Not "AI fraud detector", not "customer
surveillance", not "predictive behavioural AI".

## 2. How to install (the reviewer test flow)

### Step 1 — Open the install link

`https://[install-url-from-partner-dashboard]`

You'll be prompted to enter your shop domain (e.g. `your-store.myshopify.com`)
if not already detected.

### Step 2 — Approve the scope request

ConfirmX requests three scopes:

| Scope | Why |
|---|---|
| `read_orders` | receive `orders/create` + `orders/updated` webhooks |
| `write_orders` | operator-driven cancel from the review queue (operator decides every action; never autonomous) |
| `read_customers` | surface customer phone for the optional confirmation call workflow |

Per-scope justifications are in
`docs/shopify-listing-wording.md §Per-scope justifications`.

**Note for reviewer:** if `write_orders` is the only sticking point,
we are happy to drop it on review request. The alternative is to
redirect operators into Shopify admin to perform cancel actions
manually — a click cost, not a feature loss.

### Step 3 — Land on the dashboard

After Shopify approves, you're redirected to:

`https://app.confirmx.ai/dashboard/settings/integrations?connected=shopify&shop=<your-shop>`

You'll see a green confirmation banner ("Connected · webhooks
registered") OR a yellow warning banner explaining what didn't
register cleanly (most commonly `webhooks_partially_registered` if a
single topic failed; the connection itself is still usable).

### Step 4 — Confirm webhooks are live

Place a test order on your dev store. Within ~30s the order should
appear in:

`https://app.confirmx.ai/dashboard/orders`

The order's risk score, fraud signals, and operational
recommendation are computed in-band. The order detail drawer
(click the row) shows the full timeline.

### Step 5 — Test uninstall

Uninstall the app from your Shopify admin. Within ~5s, the
integration row in our dashboard at `/dashboard/settings/integrations`
flips to `Disconnected` with the reason "Merchant uninstalled the
app from Shopify."

48 hours later, Shopify sends `shop/redact`. Our handler hard-deletes
the merchant's order data + integration rows in dependency order.
Reviewer-relevant detail: this is real per-collection redaction,
not a stub. See `apps/api/src/lib/gdpr/redaction.ts`.

## 3. Demo merchant for review

The submission form will provide a dedicated test store with:
- a pre-installed and connected ConfirmX integration
- ~5 sample COD orders pre-seeded (mix of pending + delivered + RTO)
- an example operational recommendation visible on the dashboard
  (ConfirmX-internal observability layer; observation-only)

The test store credentials will be in the Partner-Dashboard
"Reviewer instructions" field at submission time.

If the test store install needs to be reset, the GDPR `shop/redact`
flow (or a Partner-side uninstall + re-install) clears all state.

## 4. What's intentionally disabled at review time

ConfirmX has multi-stage operational intelligence layers that ship
behind feature flags. **All the heavyweight intelligence flags are
OFF in the review-store environment.** Reviewers see the bare order-
confirmation surface, not the experimental analytics.

Specifically:

| Flag | State | Why off for review |
|---|---|---|
| `DELIVERY_RELIABILITY_WRITE_ENABLED` | 0 | replay-safe aggregate fan-out; Phase 2 of a 32-day rollout |
| `DELIVERY_RELIABILITY_READ_ENABLED` | 0 | merchant UI panel — `tier:"no_data"` cold-start posture |
| `DELIVERY_RELIABILITY_ANALYTICS_ENABLED` | 0 | analytics surfaces |
| `EXTERNAL_DELIVERY_ENABLED` | 0 | per-merchant external-history adapter |
| `BDCOURIER_ENABLED` | 0 | BD-specific platform adapter |
| `NETWORK_EVIDENCE_SURFACE_ENABLED` | 0 | cross-merchant evidence panel |
| `LANE_INTELLIGENCE_*` | 0 | courier-lane analytics |

Reviewers will see:
- The OAuth + webhook + dashboard core (everything in §2 above).
- Operator-tunable confirmation queue.
- Courier integration page (Pathao / Steadfast / RedX).
- Order list, drawer, and timeline.
- Audit log + admin observability surfaces.
- Privacy and Terms pages (`/legal/privacy`, `/legal/terms`).

What reviewers will NOT see (because the flag-gated surfaces are
off):
- Cross-merchant network-evidence panel (it's behind two flags —
  server data flag + client UI flag — both default 0).
- External-delivery history card.
- Delivery-reliability merchant panel.
- Some of the analytics views (those have no-op or empty-state
  fallbacks under the flag-off path).

This is intentional. The intelligence layers ship observation-only
behind flags, with a 32-day phased rollout per
`docs/audits/delivery-reliability-rollout-runbook.md`. The review-
store posture is the production-default-day-zero posture.

## 5. Mandatory privacy webhooks — verifying

Three webhook endpoints, all signed with the platform secret
(`SHOPIFY_APP_API_SECRET` per Shopify spec, NOT the per-merchant
webhook secret):

| Topic | URL |
|---|---|
| `customers/data_request` | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/data_request` |
| `customers/redact` | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/redact` |
| `shop/redact` | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/shop/redact` |

All three:
- Verify HMAC over raw bytes, timing-safe.
- Audit-log receipt + dispatch outcome SEPARATELY (two rows per
  webhook, so reviewers see both the "we received this" event and
  the "we did this with it" event).
- Dispatch to real redaction logic (`apps/api/src/lib/gdpr/redaction.ts`):
  - `customers/redact` pseudonymises 5 collections, hard-deletes 3.
  - `shop/redact` hard-deletes 13 collections in dependency order.
- `shop/redact` includes a fresh-install race guard: if the merchant
  uninstalled then re-installed within Shopify's 48h retention
  window, the redact is declined with an audit row instead of
  wiping a live install.

Reviewer test: trigger via Partner Dashboard's
"Test webhook" feature for each topic. Each returns 200 on a valid
HMAC and 401 on an invalid one.

## 6. Operator workflow (what reviewers click first)

In the reviewer order of priority:

1. **`/dashboard/getting-started`** — onboarding hero + checklist.
   Spend 30s reading; this is where a real merchant lands first.
2. **`/dashboard/orders`** — the order list with the risk-aware
   sample-orders preview when no real orders exist yet.
3. **Click an order row** — opens the tracking-timeline drawer with
   the operator-decisioned panels (intent, address quality,
   operational hint).
4. **`/dashboard/fraud-review`** — the operator review queue.
   Decide on a flagged order (Confirm / Reject / Need more info) —
   each decision is audit-logged and reverses cleanly.
5. **`/dashboard/settings/integrations`** — see the connected
   Shopify integration card with health + webhook status.
6. **`/legal/privacy`** and **`/legal/terms`** — the public pages
   linked from the Partner-app config.

Two minutes is enough to see the full happy-path.

## 7. Things that may surprise the reviewer

- **The "Advanced (for developers)" disclosure** in the connect
  dialog at `/dashboard/settings/integrations` lets technical
  merchants paste their own custom-app credentials. This is a
  deliberate power-user escape hatch for compliance-restricted
  merchants and air-gapped environments — see
  `shopify-app-distribution.md §Fallback`. Not used in the standard
  install flow.
- **Operational copy avoids fraud / AI vocabulary.** Per the
  positioning constraint, you'll see "operator review queue",
  "confirmation call", "operational hint" — not "fraud detection",
  "AI screening", or similar. This is intentional and audited.
- **The `app/uninstalled` handler short-circuits the order ingest
  path.** When you uninstall, the integration flips to disconnected
  before any order-events queue dispatch. The dashboard reflects
  this within ~5s.

## 8. Architecture pointers (for reviewers who want depth)

Optional reading. Not required for review.

- **OAuth flow:** `apps/api/src/server/webhooks/integrations.ts`
  (`shopifyOauthRouter`).
- **Order webhook ingest:** same file
  (`integrationsWebhookRouter`).
- **GDPR webhook handlers:** `apps/api/src/server/webhooks/shopify-gdpr.ts`.
- **Redaction logic:** `apps/api/src/lib/gdpr/redaction.ts`.
- **Webhook idempotency:** `WebhookInbox` model + unique compound
  index on `(merchantId, provider, externalId)`.
- **Replay safety:** see
  `docs/audits/final-production-readiness-report.md`.

## 9. Support

| Channel | Address |
|---|---|
| General support | `support@confirmx.ai` |
| Privacy / data | `privacy@confirmx.ai` |
| Reviewer-specific questions during review | the address provided in the Partner-Dashboard submission form |

We respond to reviewer-flagged questions within 24 hours during the
review window.

## 10. What's deliberately NOT submitted

- **App Bridge / embedded experience** — deferred. ConfirmX is
  external-app posture for the Unlisted launch; revisit when we
  pursue admin-nav launch post-approval.
- **Embedded session tokens** — N/A without App Bridge.
- **Shopify Billing API** — skipped. We bill via Stripe + manual
  bKash/Nagad approval (BD merchant preference). No Shopify revenue
  share applies for off-platform billing on Public Distribution
  Unlisted.
- **App Store listing** — Unlisted-only first submission. App Store
  listing is a separate review (marketing copy, screenshots) we may
  pursue later for top-of-funnel discovery.
