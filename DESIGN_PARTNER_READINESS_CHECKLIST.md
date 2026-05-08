# DESIGN_PARTNER_READINESS_CHECKLIST.md

**Phase:** Design Partner Launch — readiness gate
**Repository:** `C:\devs\ecommerce-logistics` (Cordon)
**Date:** 2026-05-07
**Cohort target:** 5–25 design partners (initial pilot ~5).

Each dimension below carries a status — **READY** / **PARTIAL** / **BLOCKED** —
plus the file/line evidence the team can verify in the current repo.

> "PARTIAL" means: the system works for design-partner volume but has a known
> gap that should close before broader rollout. None of the PARTIAL items
> below are launch blockers for the 5-merchant pilot.

---

## 1. Onboarding readiness — **READY**

| Component | Evidence |
|---|---|
| Self-serve signup | `apps/api/src/server/auth.ts:212` (`/auth/signup`) — bcrypt(10), email+phone+language captured, audit-stamped (`auth.signup`) |
| 5-step checklist with ETAs | `apps/web/src/components/onboarding/onboarding-checklist.tsx:37` (`STEP_TIMES`) |
| Benefit-framed step hints | `apps/web/src/components/onboarding/onboarding-checklist.tsx:48` (refined this milestone) |
| Activation moments (toaster) | `apps/web/src/components/onboarding/activation-moments.tsx` mounted in dashboard layout |
| Funnel signals (audit-stamped) | `auth.signup` → `integration.connected` → `integration.first_event` (`apps/api/src/server/webhooks/integrations.ts:269-308`) |
| Empty states across surfaces | `EmptyState` mounted on orders, integrations, recovery (verified) |
| Trial defaults + 14-day window | `env.ts:39` (`TRIAL_DAYS`), `auth.ts:222` (computed `trialEndsAt` at signup) |

**Gap:** none material for design-partner cohort.

---

## 2. Support readiness — **PARTIAL**

| Component | Evidence |
|---|---|
| Per-merchant support snapshot tRPC | `adminObservability.merchantSupportSnapshot` shipped in prior milestone — single-roundtrip diagnostic |
| System-wide observability | `adminObservability.systemHealth`, `recentWebhookFailures`, `fraudOverview`, `paymentOverview` already in place |
| Merchant feedback capture | `MerchantFeedback` model + `feedback.submit` + topbar button shipped this milestone |
| Admin feedback triage | `adminObservability.recentFeedback` + `triageFeedback` shipped this milestone |
| Operational playbooks | `OPERATIONAL_PLAYBOOKS.md` shipped this milestone |
| Support UI (admin page) | ❌ Not yet built — backend procedures exist, no frontend admin page calls them |

**Gap:** the admin-side UI to display the support snapshot + feedback queue
is unbuilt. Ops can call the procedures via curl/tsx today, but a dedicated
`/admin/merchant/[id]` page would speed up triage. **Half-day of follow-up
work; not a launch blocker** — for the 5-merchant pilot, ops calling the
procedures directly is acceptable.

---

## 3. Observability readiness — **PARTIAL**

| Component | Evidence |
|---|---|
| Sentry-compatible error capture | `apps/api/src/lib/telemetry.ts` — DSN-gated, captures unhandled rejections + tRPC INTERNAL_SERVER_ERROR + Express unhandled errors |
| Structured ingest logs | `evt: "intent.scored"`, `address.scored`, `webhook.signature_invalid`, `webhook.acked` (with `ackMs`) |
| Queue counters | `_counters` map in `lib/queue.ts:154-200` — failures, retryRecovered, deadLettered, replayed, exhausted per queue |
| Queue wait-time logging | Worker `active` event ≥5s threshold (`lib/queue.ts:90-104`) |
| BullMQ snapshot endpoint | `adminObservability.systemHealth` — every queue's job counts in one call |
| Webhook health surfaces | `Integration.webhookStatus.{lastEventAt, failures, lastError}` |
| Operational hint UI | Order detail drawer (`apps/api/src/lib/operational-hints.ts` + UI panel) |
| Anomaly engine | `apps/api/src/lib/anomaly.ts` — short-window-vs-baseline detection across 4 alert kinds, fans out via `lib/admin-alerts.ts` |
| External dashboard wiring (Grafana / Datadog) | ❌ Not configured |
| Production log aggregator config | ❌ Not in repo (likely Railway-side) |

**Gap:** structured logs are emitted; nobody is aggregating them externally
yet. For the 5-merchant pilot the team will read raw stdout; for the 25-merchant
expansion, set up a log aggregator. **Not a launch blocker.**

---

## 4. Billing readiness — **READY**

| Component | Evidence |
|---|---|
| 4-tier plan catalogue | `packages/types/src/plans.ts:53-187` — Starter/Growth/Scale/Enterprise, BDT + USD |
| Stripe Subscriptions full webhook flow | `apps/api/src/server/webhooks/stripe.ts` — checkout, payment_succeeded, payment_failed, subscription.deleted; idempotent via `Payment.providerEventId` unique index |
| Manual rails (bKash/Nagad/bank) | `models/payment.ts` — receipt + risk score + dual-approval for high-risk |
| Cross-merchant fingerprint (anti-fraud) | `Payment.txnIdNorm`, `proofHash`, `metadataHash` indexed |
| Trial → past_due → suspended state machine | `models/merchant.ts:24-32` (subscription enum), `subscriptionGrace` worker (hourly sweep) |
| Quota enforcement | `lib/usage.ts` — atomic conditional `$inc`; refund on E11000 race in `ingest.ts:222-247` |
| Plan downgrade preview | `billing.previewPlanChange` (`routers/billing.ts:108-150`) — surfaces exact integrations that would be disabled |
| Stripe Customer Portal | `lib/stripe.ts:createPortalSession` |
| Trial-ending email | `trialReminder` worker (every 6h, idempotent stamp on `merchant.notificationsSent.trialEndingAt`) |
| Test coverage | `tests/billing.test.ts`, `manual-payments.test.ts`, `downgrade.enforcement.test.ts` |

**Gap:** none material. The billing surface is unusually mature for the
company stage.

---

## 5. Webhook reliability — **READY**

| Component | Evidence |
|---|---|
| Permanent idempotency keys | `models/webhookInbox.ts:13-45` — `(merchantId, provider, externalId)` unique with **no TTL**; explicit doc-block explaining why |
| Defense-in-depth via Order partial-unique | `models/order.ts:474-479` — `(merchantId, source.externalId)` unique-partial |
| Raw-body HMAC verification | `apps/api/src/index.ts:194-207` — webhook routes mounted BEFORE `express.json` |
| Freshness gate (5 min window, 1 min skew tolerance) | `webhooks/integrations.ts:158-176` |
| Per-IP rate limit | `webhookLimiter` 120/min/IP (`middleware/rateLimit.ts:69-77`) |
| Signature-failure observability | `evt: "webhook.signature_invalid"` (shipped in prior milestone) |
| ACK-latency SLO log | `evt: "webhook.acked"` with `ackMs` (shipped in prior milestone) |
| Retry sweep + payload reaper | `webhook-retry` worker every 60s; payloads NULLed at 90 days while idempotency key persists forever |
| Test coverage | `tests/webhookIdempotencyDurability.test.ts`, `shopifyWebhookHttp.test.ts`, `courier.webhook.test.ts` |

**Gap:** none for design partner volume.

---

## 6. Replay durability — **READY**

| Component | Evidence |
|---|---|
| `safeEnqueue` with 3-retry backoff | `lib/queue.ts:328-390` — 50/200/500ms in-process retries before fall-through |
| `PendingJob` Mongo-backed dead-letter | `models/pendingJob.ts` — replays 5x with exponential backoff (1m/5m/15m/1h/4h) |
| Replay sweeper running | `pendingJobReplay` worker every 30s (`apps/api/src/index.ts:156-172`); `ensureRepeatableSweep` called at boot |
| Inbox retry sweep | `webhook-retry` worker every 60s; picks up failed rows + orphans (received >5 min) |
| Test coverage | `tests/pending-job-replay.test.ts`, `tests/queue-reliability.test.ts`, `tests/webhookIdempotencyDurability.test.ts` |

**Gap:** none.

---

## 7. Queue safety — **READY**

| Component | Evidence |
|---|---|
| 16 BullMQ queues with single source of truth | `lib/queue.ts:11-32` (`QUEUE_NAMES`) |
| Per-merchant token-bucket fairness (Redis Lua) | `lib/merchantRateLimit.ts:26-66` — atomic via Lua, fail-open on Redis outage |
| Worker registration discipline | `apps/api/CLAUDE.md` — registration checklist; verified at boot in `index.ts` |
| Per-(provider, accountId) circuit breaker | `lib/couriers/circuit-breaker.ts:51-55` — 5-failure trip / 30s open / 5s wall-time |
| Optimistic concurrency on Order | `lib/orderConcurrency.ts:71` — `updateOrderWithVersion` + `runWithOptimisticRetry` |
| Booking lock | `models/order.ts:111-125` — `bookingInFlight` flag; `awbReconcile` worker breaks stale locks (every 60s) |

**Gap:** the `orderSync.worker.ts` registration gap (master audit §2) **still
exists** — file present, never registered in `apps/api/src/index.ts`.
**Polling fallback for missed Shopify/Woo deliveries is offline.** Not a
blocker for the 5-merchant pilot (Shopify retries up to 19× over 48h on its
own), but flag for `[FILL]` when the cohort grows. **Master audit
recommendation: 3-line fix.**

---

## 8. Backup / recovery posture — **PARTIAL**

| Component | Evidence |
|---|---|
| Mongo connection: standard URI | `env.ts:13` (Atlas-compatible) |
| `autoIndex` OFF in production | `lib/db.ts:13-16` — explicit |
| One-shot legacy index migrations at boot | `lib/db.ts:54-104` — idempotent, drop-only, safe to run repeatedly |
| Index sync at boot (background) | `apps/api/src/index.ts:113-135` — non-blocking; healthcheck unaffected |
| Deploy-time index migration script | `apps/api/src/scripts/syncIndexes.ts` (npm `db:sync-indexes`) |
| Mongo Atlas backup config | ❌ Not in repo — assumed configured at the cloud level (verify before launch) |
| Cross-region failover | ❌ Single region (sufficient for design partner cohort) |
| Disaster-recovery runbook | `OPERATIONAL_PLAYBOOKS.md` shipped this milestone |

**Gap:** the Mongo Atlas backup config is OUT of repo. **Verify before
onboarding the first merchant** — run a test point-in-time restore against
staging to confirm. **Soft launch blocker** — confirm in 30 minutes;
otherwise pre-launch fix.

---

## 9. Merchant communication readiness — **PARTIAL**

| Component | Evidence |
|---|---|
| In-app notifications | `models/notification.ts` — severity-tiered, dedupe-keyed, stored per merchant |
| Outbound SMS (transactional) | `lib/sms/sslwireless.ts` — BD provider, retry-on-5xx, DLR webhook closes the loop |
| Outbound email (transactional) | `lib/email.ts` — Resend transport, dev fallback to stdout, fails open on misconfig |
| Critical-severity SMS escalation | `dispatchNotification` fans out via `sendCriticalAlertSms` opt-in per `merchant.adminAlertPrefs` |
| Operational hint surface (per-order) | `OperationalHintPanel` in order detail (shipped in prior milestone) |
| Incident banner (env-driven) | `IncidentBanner` mounted in dashboard layout — critical messages override merchant-dismiss |
| Feedback channel (merchant→ops) | `feedback.submit` + topbar `<FeedbackButton>` shipped this milestone |
| Email cadence for activation | ❌ Only the trial-ending warning email exists; no welcome / day-3 / day-7 cadence |
| WhatsApp Business adapter | ❌ Out of scope (per master strategy doc, medium-term) |

**Gap:** no automated email cadence beyond trial-ending. For 5 design
partners this is fine — concierge onboarding from the founders is the
expected channel. **For 25 merchants, add a 4-touch email cadence
(welcome / day 3 / day 7 / pre-trial-end).**

---

## 10. Incident handling readiness — **READY**

| Component | Evidence |
|---|---|
| Tamper-evident audit log | `models/auditLog.ts:181-251` — selfHash + prevHash chain; Mongoose immutability hooks; verifier walks chain |
| Per-merchant rate limit + per-IP rate limits | `middleware/rateLimit.ts` — login (5/15m IP+email), signup (10/h), password reset (5/h), webhook (120/min), public tracking (30/min) |
| Anomaly detection | `lib/anomaly.ts` — payment_spike, webhook_failure_spike, automation_failure_spike, fraud_spike |
| Admin alert fan-out | `lib/admin-alerts.ts` — per-admin email/SMS prefs |
| Per-merchant kill-switches | `INTENT_SCORING_ENABLED`, `ADDRESS_QUALITY_ENABLED`, `FRAUD_NETWORK_ENABLED`, `COURIER_MOCK` (all `env.ts`) |
| Operational playbooks | `OPERATIONAL_PLAYBOOKS.md` shipped this milestone |
| Graceful shutdown | `apps/api/src/index.ts:270-278` — SIGINT/SIGTERM closes server, drains workers, closes Redis |

**Gap:** none. Master audit's flagged absence of `RUNBOOK.md` is
addressed by `OPERATIONAL_PLAYBOOKS.md` shipped this milestone.

---

## Roll-up

| # | Dimension | Status |
|---|---|---|
| 1 | Onboarding | ✅ READY |
| 2 | Support | 🟡 PARTIAL (admin UI) |
| 3 | Observability | 🟡 PARTIAL (log aggregator) |
| 4 | Billing | ✅ READY |
| 5 | Webhook reliability | ✅ READY |
| 6 | Replay durability | ✅ READY |
| 7 | Queue safety | ✅ READY (`orderSync` reg gap noted) |
| 8 | Backup / recovery | 🟡 PARTIAL (verify Atlas backup config) |
| 9 | Merchant communication | 🟡 PARTIAL (email cadence) |
| 10 | Incident handling | ✅ READY |

**6 READY, 4 PARTIAL, 0 BLOCKED.** The four PARTIAL items are all
fix-by-25-merchants concerns; none of them blocks the 5-merchant pilot.

**Pre-pilot must-do (next 2 hours):**

1. Verify Mongo Atlas backup config + run one test point-in-time restore.
2. Land the `orderSync` worker 3-line registration fix (also flagged in
   master audit).
3. Verify `STRIPE_WEBHOOK_SECRET`, `COURIER_ENC_KEY`, `JWT_SECRET`,
   `ADMIN_SECRET`, `SHOPIFY_APP_API_KEY/SECRET`, `SSL_WIRELESS_*` are
   actually set in the production env (env validation will refuse to boot
   without them; confirm by reading the boot logs).

**Pre-pilot should-do (next day):**

4. Flip CSP from Report-Only to enforce after one production-clean week
   of violation reports (master audit §15).
5. Verify the in-app `<IncidentBanner />` env (`NEXT_PUBLIC_INCIDENT_BANNER_TEXT`)
   is reachable from the deploy console — practice setting and clearing
   it once.
6. Confirm `gh pr create` / GitHub access works for the on-call engineer
   so emergency rollback PRs aren't blocked on credentials.

**Post-pilot must-do (before going to 25 merchants):**

7. Build the admin-side UI for `merchantSupportSnapshot` + the feedback
   queue (Item 2's open gap).
8. Wire structured logs into a real aggregator (Item 3's open gap).
9. Ship the 4-touch email activation cadence (Item 9's open gap).
10. Implement Shopify GDPR data redaction sweep — required for Public
    Distribution submission (master audit §15).

---

**End of readiness checklist.**

*Every file/line citation in this document was verified against the
current `main` branch.*
