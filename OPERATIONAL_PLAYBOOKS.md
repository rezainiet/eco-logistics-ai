# OPERATIONAL_PLAYBOOKS.md

**Audience:** Cordon on-call + support team during the design-partner pilot.
**Phase:** Real-merchant operations — first 5–25 partners.

This document is **the** runbook. When the dashboard goes red or a merchant
emails saying "something's broken," start here. Every playbook below names:

- the **trigger** that signals the failure mode,
- the **immediate steps** the on-call engineer takes (always read-only first),
- the **escalation** path,
- the **rollback** if a code change made it worse,
- a **post-mortem** seed.

**Non-destructive bias.** Every playbook starts with read-only diagnostics.
Destructive actions (revoking sessions, retrying jobs, flipping kill-switches)
require an explicit human decision and are called out in their own step.

---

## Playbook 1 — Webhook signature verification failures

### Trigger

- `evt: "webhook.signature_invalid"` log lines spiking on a single
  integration.
- `Integration.webhookStatus.failures` increment > 5 in 10 min on the
  affected merchant.
- Merchant report: "Shopify says my webhook isn't being received."

### Immediate diagnostics (read-only)

1. Pull the merchant's snapshot — `adminObservability.merchantSupportSnapshot({merchantId})`.
2. Look at `integrations[].webhookStatus.{lastError, failures}`. The
   `lastError` field will say `"signature mismatch"` for HMAC failures.
3. Cross-reference `evt: "webhook.signature_invalid"` entries in the
   structured log stream. Same `integrationId` for every line → secret
   mismatch on that integration. Many `integrationId`s in the same
   minute → probe traffic from outside, not a real merchant issue.

### Resolution paths

- **Single-merchant secret rotation drift:**
  - For Shopify (platform-app install): the secret is `env.SHOPIFY_APP_API_SECRET`.
    If recently rotated, redeploy with the new value AND ensure the
    rotation followed Shopify's grace-period playbook (run both old +
    new for ~24h before flipping).
  - For Shopify (custom-app, legacy): the secret is per-integration
    `credentials.apiSecret`. Merchant must reconnect from the
    Integrations page (no admin path; the secret is encrypted).
  - For Woo / custom_api: the secret is per-integration
    `webhookSecret`. Direct merchant to the rotation flow on the
    Integrations page.
- **Probe traffic from outside:** confirm the source IPs in the
  per-IP `webhookLimiter` metrics. The 120/min/IP cap is enforced; if
  you see > 1k req/min from one IP, escalate the IP block to the
  edge proxy (Railway / load balancer config).

### Rollback

Not applicable — verification is gating an inbound write. The signal
is "we're correctly refusing" rather than "we broke something".

### Post-mortem seed

If the failure was secret rotation drift: document the missing
grace-period step in the rotation runbook for the merchant or for
internal ops. If platform-wide: ticket against the secret-rotation
process itself.

---

## Playbook 2 — Shopify integration disconnects

### Trigger

- Merchant report: "Cordon stopped seeing my orders."
- `evt: "shopify-webhook"` log line with `topic: app/uninstalled` (this
  is logged with `integrationId` + `flipped: true/false`).
- `Integration.status === "disconnected"` with a recent `disconnectedAt`.

### Immediate diagnostics

1. `adminObservability.merchantSupportSnapshot({merchantId})`. Check
   the integration's `disconnectedAt` and `webhookStatus.lastError`.
2. If `disconnectedAt` is recent AND `app/uninstalled` was the last
   webhook → merchant intentionally uninstalled from Shopify Admin.
   Reach out and ask why.
3. If `disconnectedAt` is recent BUT `app/uninstalled` was NOT logged →
   the disconnect came from inside Cordon (token-test failure during a
   sync). Check `integration.health.{ok, lastError}` for the actual
   reason.

### Resolution paths

- **Merchant uninstalled intentionally:** they need to reconnect via
  the Integrations page. The OAuth flow handles orphan-cleanup in
  `webhooks/integrations.ts:504-519` (deletes only `disconnected`
  rows that conflict on the canonical accountKey).
- **Token expired / rotated:** merchant reconnects. Same path. If
  their orders were missed during the gap, run an import via the
  Integrations page → "Import recent orders" (this calls
  `commerceImport` worker). Note: the master audit flagged that
  `orderSync.worker.ts` (polling fallback) is currently unwired —
  prioritize that 3-line fix if many merchants hit this.
- **Webhook subscription rotted:** merchant clicks "Retry webhook
  registration" from Integrations (`integration.shopify_webhooks_retried`
  audit action). Verify in `webhookStatus.subscriptions[]` afterward.

### Rollback

Not applicable.

### Post-mortem seed

If unintentional disconnects cluster on a deploy boundary, look for
a regression in the OAuth callback. If they cluster on a Shopify-side
event (mass uninstall), check Shopify changelog.

---

## Playbook 3 — Delayed ingestion (orders missing)

### Trigger

- Merchant report: "I placed an order on my storefront and it's not in
  Cordon."
- `Integration.lastImportAt` or `webhookStatus.lastEventAt` > 30 min
  old on a healthy-status integration.
- `adminObservability.systemHealth` shows webhook backlog.

### Immediate diagnostics

1. `adminObservability.merchantSupportSnapshot({merchantId})`. Look at
   `operational.lastIngestionAt` and per-integration `lastWebhookAt`,
   `lastSyncAt`.
2. Check `WebhookInbox` rows for the merchant in `recentInbox`. Look
   for status="failed" with non-trivial `lastError`.
3. Check the BullMQ snapshot in `systemHealth` — is `webhookProcess`
   waiting > 0 with active = 0? That's a worker-stalled signal.
4. If the merchant has a specific external order id, query
   `WebhookInbox.findOne({merchantId, externalId})` directly via Mongo
   shell. If the row exists with `status: "succeeded"` but the order
   isn't in our DB, that's an ingest-side bug — escalate.

### Resolution paths

- **Webhook never arrived from upstream:** in the dashboard,
  Integrations → "Sync recent orders" runs the
  `commerceImport` worker which pulls via API. Master-audit fix:
  also wire `orderSync` for automatic polling fallback.
- **Webhook arrived but inbox stamping failed (rare):** the webhook
  receiver returns 5xx; upstream retries. Look at
  `evt: "webhook.acked"` logs for that integration. If outcomes are
  all "queued" but the worker isn't draining, bounce the worker
  process (`pendingJobReplay` will pick up any dead-lettered rows).
- **Workers stalled (Redis pingable but workers not consuming):**
  set `INTENT_SCORING_ENABLED=0` and `ADDRESS_QUALITY_ENABLED=0` to
  rule out the new layers as the cause, then redeploy. If it
  resolves, the regression is in those layers — open a ticket.

### Rollback

If a recent deploy correlates with the stall, roll back the deploy.
The kill-switches above let you keep the new schema fields working
in observation-only mode without rolling code.

### Post-mortem seed

Track whether the resolution was "merchant clicked sync" vs "platform
fixed". Repeated platform-side stalls mean the polling fallback wiring
is overdue.

---

## Playbook 4 — Replay recovery (PendingJob backlog)

### Trigger

- `adminObservability.systemHealth` shows growing `pending-job-replay`
  queue OR `_counters.failures` incrementing on multiple queue names.
- Mongo: `db.pendingjobs.countDocuments({status: "pending"})` > 100.
- `evt: "queue.dead_lettered"` log lines spiking.

### Immediate diagnostics

1. **Is Redis up?** `redis-cli ping`. If down, the dead-letter system
   is doing exactly what it was built for — preserving work until
   Redis recovers. Don't intervene; wait for Redis.
2. If Redis is up but PendingJob isn't draining: read the replay
   sweeper logs for `evt: "queue.dead_letter_replay_failed"`. The
   `error` field tells you why each replay attempt failed.
3. Check `_counters.exhausted` — these are jobs that hit the 5-attempt
   cap. They preserve forensics; they don't auto-retry.

### Resolution paths

- **Redis recovered, sweeper draining:** wait. The sweeper runs every
  30s; backlog should clear within minutes. Watch
  `_counters.replayed` increment.
- **Replay-attempt errors point at a queue name:** that queue's
  consumer is broken. Look at the worker's recent logs. Common causes:
  Mongo schema drift (a worker reading a field that was renamed),
  external API returning unexpected shape (defensive code missing).
- **Exhausted rows that need manual replay:** the on-call engineer
  reviews each one, decides go/no-go, and either calls a manual
  replay procedure or marks the row dismissed. There's no admin UI
  for this yet — use Mongo shell to inspect: `db.pendingjobs.find({status: "exhausted"})`.

### Rollback

If a recent deploy introduced the failure, roll back. The PendingJob
rows persist across deploys.

### Post-mortem seed

Every exhausted job is a class of failure that escaped automated
retry. Categorise the cluster (one merchant? one queue? one external
API?) and add specific defensive code or alerting.

---

## Playbook 5 — Stuck pending jobs

### Trigger

- A specific merchant ticket: "I confirmed the order 2 hours ago but
  it never shipped."
- `Order.automation.state === "confirmed"` but no
  `logistics.trackingNumber` and `automation.confirmedAt` > 30 min ago.
- `automationWatchdog` worker logs `automation.watchdog_exhausted`
  audit action.

### Immediate diagnostics

1. `adminObservability.merchantSupportSnapshot({merchantId})`.
   `pendingJobs` field counts the merchant's PendingJob rows.
2. Pull the order — `Order.findById(orderId)`. Check
   `automation.{state, attemptedCouriers}`,
   `logistics.{bookingInFlight, bookingLockedAt, trackingNumber}`.
3. The `automationWatchdog` worker re-enqueues stuck orders every
   5 minutes (`workers/automationWatchdog.ts`). Confirm the worker
   is running by checking its last log line.

### Resolution paths

- **Booking lock is stale (`bookingInFlight: true`, lock acquired
  > 90s ago):** the `awbReconcile` worker breaks stale locks every
  60s (`workers/awbReconcile.ts`). Wait one cycle.
- **Couriers in `attemptedCouriers` already exhausted (≥3 entries):**
  the order needs manual courier override. The merchant can re-pick
  a courier from the order detail; the auto-book fallback chain has
  given up by design.
- **Auto-book worker not consuming:** check Redis + worker logs.
  If process is fine but jobs pile up, restart the worker.

### Rollback

Same kill-switch logic as Playbook 3 — disable intent/address
stamping if a recent change correlates.

### Post-mortem seed

If multiple merchants hit "all couriers attempted, manual handoff",
the courier-intelligence engine is mis-selecting. Pull
`CourierPerformance` for the affected merchants/districts and check
whether the cohort size is too small for confident selection — could
be a calibration issue, not a bug.

---

## Playbook 6 — Degraded integrations

### Trigger

- `Integration.degraded === true` on a merchant's integration row.
- Merchant report: "Cordon shows my Shopify connection as red."

### Immediate diagnostics

1. `adminObservability.merchantSupportSnapshot({merchantId})`.
   Look at the integration's `health.{ok, lastError, lastCheckedAt}`,
   `errorCount`, `lastError`.
2. Run `integrations.test` from the dashboard (calls the adapter's
   `testConnection` — emits `evt: integration.test` audit row).
3. The `degraded` flag is set by the alert worker after
   `MAX_REPLAY_ATTEMPTS` recovery attempts have been exhausted; it
   disables retry/sync buttons in the dashboard until reconnect.

### Resolution paths

- **Shopify token expired or scopes changed:** merchant must reconnect
  through OAuth. The "Reconnect" button on Integrations runs the same
  install flow.
- **WooCommerce credentials rotated on the merchant side:** merchant
  pastes new consumer key/secret into the Edit dialog.
- **Custom API URL change:** merchant updates the URL on Integrations.
- **Persistent 5xx from upstream:** the SSRF guard
  (`lib/integrations/safe-fetch.ts`) won't help here — that's an
  upstream stability problem on Shopify/Woo's side. Communicate to
  merchant that we're waiting on upstream.

### Rollback

Not applicable.

### Post-mortem seed

A `degraded: true` flag stays set until reconnect — track
distribution by provider. If concentrated on Woo, the WooCommerce
auth-strategy probe (`integrations/types.ts:97-101`) may need
calibration on a specific Cloudflare-fronted host.

---

## Playbook 7 — Merchant onboarding support

### Trigger

- Merchant submitted feedback with `kind: "onboarding"` (queryable
  via `adminObservability.recentFeedback({kind: "onboarding"})`).
- Merchant reaches out via concierge channel saying "I'm stuck on
  step X".

### Immediate diagnostics

1. `adminObservability.merchantSupportSnapshot({merchantId})`.
   - `merchant.subscription.{status, trialEndsAt}` — they still have
     trial time?
   - `integrations[]` — anything connected at all?
   - `ordersByStatus7d` — empty? has anything ingested?
2. Cross-reference the recent feedback row in
   `recentFeedback({kind: "onboarding"})` for the merchant's
   description of what they tried.

### Resolution paths

- **Stuck on connect_store:** confirm the env var
  `SHOPIFY_APP_API_KEY` + `SHOPIFY_APP_API_SECRET` are set so they
  get the one-click install path. If unset, they're falling through
  to the manual custom-app flow which requires API credential
  pasting.
- **Stuck on import_orders:** dashboard has an "Import recent orders"
  button that runs `commerceImport`. Confirm Shopify scope grant
  includes `read_orders`.
- **Stuck on add_courier:** they need an account ID + API key from
  Pathao/Steadfast/RedX directly. Concierge here.
- **Stuck on enable_automation:** the default `manual` mode is fine
  for the trial. Encourage them to leave it on manual until 50+
  orders are flowing.
- **Stuck on test_sms:** `sms.send` mutation. Verify the merchant
  has a phone in their profile.

### Rollback

Not applicable.

### Post-mortem seed

After 5 design partners onboard, count which step generated the most
feedback. That's where the next polish iteration goes.

---

## Playbook 8 — Billing / support incidents

### Trigger

- Merchant report: "I paid but my plan didn't activate" / "Cordon
  charged me but I cancelled" / "I'm in past_due but I just paid".
- `evt: "subscription.payment_failed"` audit + merchant reaches out.
- Stripe webhook delivery failures in Stripe Dashboard.

### Immediate diagnostics

1. `adminObservability.merchantSupportSnapshot({merchantId})`.
   Look at `merchant.subscription.{status, currentPeriodEnd, trialEndsAt}`.
2. Pull the merchant's Payment history:
   `Payment.find({merchantId}).sort({createdAt: -1}).limit(10)`.
3. Cross-reference Stripe Dashboard → Customer → Events for the
   merchant's stripeCustomerId.
4. Check `recentAudit` for any `subscription.*` actions in the
   last 24h.

### Resolution paths

- **Stripe Subscription paid but webhook didn't fire:** Stripe Dashboard
  → Webhooks → resend the event. Our handler is idempotent
  (`Payment.providerEventId` unique) so resending is safe.
- **Manual payment (bKash/Nagad) submitted but not approved:** the
  merchant submitted a Payment row; admin needs to approve via
  `/admin/billing` (or `admin.approvePayment` directly). High-risk
  payments require dual approval — confirm
  `Payment.requiresDualApproval` and route accordingly.
- **Past due → suspended (grace expired):** the `subscriptionGrace`
  worker handled this. To recover, merchant pays via Stripe Customer
  Portal OR finance admin extends via `subscription.extend` with
  documented reason.
- **Trial ended without payment, merchant locked out:** `billableProcedure`
  refuses revenue-adjacent calls. Finance admin can extend the trial
  via `admin.extendTrial`. Document the reason in audit.

### Rollback

Stripe events are idempotent server-side. No rollback needed.

### Post-mortem seed

If multiple merchants hit "paid but didn't activate", check whether
the Stripe webhook URL is reachable from Stripe's side and whether
`STRIPE_WEBHOOK_SECRET` matches the dashboard configuration.

---

## Cross-cutting playbook — "I don't know what's broken"

When the dashboard goes red but no specific signal points anywhere:

1. **Check `/health`** on the API (`GET /health` returns `{ok: true}`).
2. **Check `adminObservability.systemHealth`** in the admin UI.
   Read every section. Anything red, follow the relevant playbook.
3. **Check Sentry** if `SENTRY_DSN` is configured. Recent unhandled
   errors live there.
4. **Check Stripe Dashboard webhook deliveries** if billing is involved.
5. **Tail production logs** for `evt: ` lines — every structured log
   has a stable code prefix you can filter on:
   - `evt: webhook.*` — webhook receivers
   - `evt: queue.*` — queue / dead-letter
   - `evt: intent.*` / `evt: address.*` — intelligence layer
   - `evt: feedback.submitted` — incoming merchant feedback
6. **If nothing helps, set `NEXT_PUBLIC_INCIDENT_BANNER_TEXT`** with
   the truthful current state ("We're investigating slow webhook
   processing"), then continue debugging. Better to be transparent
   than silent.

---

## On-call rotation expectations

For the design-partner pilot:

- One engineer on-call at any given time.
- Response SLA: 30 min during BD business hours (10:00–22:00 BST),
  best-effort overnight.
- Every incident → `OPERATIONAL_PLAYBOOKS.md` post-mortem section
  gets a one-paragraph addendum within 24h. The playbook gets better
  by being used.

---

**End of playbooks.**

*This document is a living artifact. Every playbook section is a
template — when a real incident teaches us something the playbook
didn't cover, we add it. The right number of playbooks is "one per
distinct kind of trouble we've actually seen", not "one per
hypothetical".*
