# DESIGN_PARTNER_LAUNCH_REPORT.md

**Phase:** Design Partner Launch
**Repository:** `C:\devs\ecommerce-logistics` (Cordon)
**Date:** 2026-05-07
**Decision:** **GO for the 5-merchant pilot. Hold for 25-merchant expansion until 4 follow-ups land.**

---

## 1. Current launch readiness

### Verdict: **GO for 5-merchant design-partner pilot.**

Backed by:

- **Onboarding** is in genuinely good shape: 5-step checklist with realistic
  ETAs, benefit-framed step hints (refined this milestone), activation
  toaster, audit-stamped funnel signals, time-zone-aware empty states.
- **Reliability levers** are mature for this stage: permanent webhook
  idempotency, dead-letter durability across both BullMQ and Mongo,
  per-merchant token-bucket fairness, courier circuit breaker with 5s
  wall-time ceiling, optimistic concurrency on Order, audit hash chain
  with Mongoose immutability hooks.
- **Billing** covers both Stripe Subscriptions (auto-renew) AND BD-native
  manual rails (bKash / Nagad / bank receipts) with dual-approval for
  high-risk payments.
- **Operational visibility** has structured logs on every hot path
  (`webhook.acked` ack-latency, `webhook.signature_invalid`,
  `intent.scored`, `address.scored`, queue counters).
- **Per-merchant support snapshot** is one tRPC call away
  (`adminObservability.merchantSupportSnapshot`).
- **Operational hint surface** translates raw state into one-sentence
  merchant-readable labels with suggested actions.
- **Merchant feedback channel** ships this milestone — topbar button →
  `feedback.submit` → `MerchantFeedback` collection with admin triage.
- **Operational playbooks** (`OPERATIONAL_PLAYBOOKS.md`) cover all eight
  failure modes the team is likely to hit during the pilot.

### Hold gate for the 25-merchant expansion

These four follow-ups must land before scaling beyond the pilot:

1. **Wire `orderSync.worker.ts`** in `apps/api/src/index.ts` (3-line fix).
   Without it, polling fallback for missed Shopify/Woo deliveries is offline.
2. **Verify Mongo Atlas backup config + run one test point-in-time
   restore.** Out of repo; verify in production console and document
   in the playbook.
3. **Build the admin support UI** — backend procedures
   (`merchantSupportSnapshot`, `recentFeedback`, `triageFeedback`) exist;
   the frontend admin page that calls them does not. Half-day of work.
4. **Wire structured logs into a real aggregator** (Datadog / Grafana /
   self-hosted Loki). The `evt: ` prefixes are stable; the work is
   purely deployment.

---

## 2. Operational weaknesses

In priority order. None blocks the 5-merchant pilot; numbered for the
25-merchant expansion.

1. **`orderSync.worker.ts` registration gap** (master audit §2). Polling
   fallback is dead. Critical fix when the cohort grows past where
   Shopify/Woo's own retry loops can paper over a missed delivery.
2. **CSP is Report-Only** (master audit §10). After one production-clean
   week of violation reports, flip to enforce.
3. **Shopify GDPR data redaction sweep is stubbed** (master audit §10).
   Receiver verifies HMAC + writes audit; the actual deletion sweep is
   a TODO. Hard requirement before flipping the Shopify app to Public
   Distribution.
4. **No admin support UI yet.** Procedures exist; frontend page does not.
   Without it, ops calls procedures via curl/tsx — fine for 5 merchants,
   not for 25.
5. **No log aggregator wired.** Structured logs are emitted; nobody is
   centrally viewing them.
6. **Single Redis** (master audit §10). First hardware fault impact is
   total queue stoppage; PendingJob mitigates write-side loss; doesn't
   help workers consume. Plan for Sentinel/Cluster past 100 merchants.
7. **No automated email cadence beyond trial-ending warning.** Concierge
   onboarding from founders is fine for 5 merchants; for 25 ship a
   4-touch cadence (welcome / day 3 / day 7 / pre-trial-end).
8. **Build tolerates type errors on deploy path.** `apps/api/package.json:8`
   runs `tsc` with `--noEmitOnError false`. Strict variant exists;
   switch the deploy to `build:strict`.

---

## 3. Onboarding risks

The merchant journey audit (Step 1 of this milestone) found:

| Risk | Severity | Mitigation |
|---|---|---|
| **Shopify install path bifurcation** — without `SHOPIFY_APP_API_KEY` + `SHOPIFY_APP_API_SECRET` set in production env, merchants fall through to the manual custom-app flow with API-credential pasting | High | **Confirm both env vars are set before launch.** They unlock the one-click install path that's the #1 conversion driver. |
| **Custom-API integration has no setup wizard** — merchant must read docs, create a webhook on their side, paste URL | Low (rare path) | Concierge fix during pilot; document a small wizard as a follow-up |
| **WooCommerce connect requires manual API key generation in Woo admin** | Medium | Document the screenshots in onboarding help; defer to OAuth-for-Woo as a medium-term feature |
| **First-import "empty dashboard" feeling** — merchant connects Shopify, expects historical orders to appear, has to click "Import recent orders" | Medium | The `commerceImport` worker handles this; the dashboard CTA is in place. Make sure every onboarded merchant clicks it during concierge call |
| **Trial-ending without billing setup** | Medium | The `trialReminder` worker fires `TRIAL_WARNING_DAYS` (default 3) before expiry; founder-tier concierge should hand-hold the first 5 through this transition |

**Funnel signals already audit-stamped:** `auth.signup` →
`integration.connected` → `integration.first_event`. Watch the conversion
rate between each pair. Anything < 70% on the first → second hop signals
an integration friction point worth investigating.

---

## 4. Support risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Admin support UI doesn't exist yet.** Ops calls `merchantSupportSnapshot` via curl/tsx | Medium | Acceptable for 5 merchants; build before expanding. Quick win: `/admin/merchant/[id]` page that calls the procedure |
| **No log aggregator** | Low for pilot | Tail production stdout via Railway console; ship aggregator before 25 |
| **Single on-call engineer model** | Medium | Defined in `OPERATIONAL_PLAYBOOKS.md`. 30-min response SLA during BD business hours; best-effort overnight |
| **Merchant feedback channel is single-shot** — no notification to ops when a feedback row arrives | Low | Add a daily digest: "5 new feedback rows this morning, 1 marked blocker." Not blocking |
| **Critical-severity SMS fan-out depends on `merchant.adminAlertPrefs`** — defaults exist (`models/merchant.ts:330-340`) but a merchant who explicitly opts out won't see the platform-side critical alerts | Low | The default is informed-opt-in (info=in-app only, warning=in-app+email, critical=in-app+email+SMS). Document the override path in the playbook |

**Most-likely first ticket categories** based on the
`OPERATIONAL_PLAYBOOKS.md` mapping:

- "I connected Shopify but Cordon shows no orders" → Playbook 3
  (Delayed ingestion).
- "My fraud review queue is empty / not surfacing X" → typically
  resolved by reading `Order.fraud.signals[]` for the specific order.
- "I clicked send-SMS-test and the buyer never got it" → SSL Wireless DLR
  pipeline; check `Order.automation.confirmationDeliveryStatus`.

---

## 5. Recommended merchant cohort size

**Phase 1 — Closed pilot: 5 merchants.**

Selection criteria:
- 1 high-volume Shopify (>500 orders/month)
- 1 mid-volume WooCommerce (200–500 orders/month)
- 1 low-volume Shopify (50–200 orders/month) — easier to debug
- 1 BD-native using Pathao primarily
- 1 BD-native using Steadfast primarily

Run for 30 days with daily concierge from a founder. Goal: zero merchants
abandon mid-onboarding; ≥80% complete the 5-step checklist; ≥1 NPS
data point per merchant.

**Phase 2 — Open pilot: 10 merchants total.**

Open after the pilot's 4 hold-gate follow-ups land (from §1). Add 5 more
merchants. Goal: ops-team-led support (no founder hand-hold beyond
Slack); first cohort retains and refers.

**Phase 3 — Beta: 25 merchants total.**

Open after Phase 2's first 30 days. Expansion blockers: anything that
made Phase 2 painful must be fixed before opening Phase 3.

**Beyond 25:** revisit the master audit's scaling section. The single-
Redis SPOF and the worker-pod strategy become real concerns past
100 merchants.

---

## 6. Recommended launch strategy

### Week −1 (pre-launch verification)

1. Verify production env vars: `MONGODB_URI`, `REDIS_URL` (HA?),
   `JWT_SECRET`, `ADMIN_SECRET`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_*`, `SHOPIFY_APP_API_KEY`, `SHOPIFY_APP_API_SECRET`,
   `COURIER_ENC_KEY`, `SSL_WIRELESS_*`, `SMS_WEBHOOK_SHARED_SECRET`,
   `SENTRY_DSN`, `EMAIL_FROM`, `RESEND_API_KEY`,
   `PAY_BKASH_NUMBER` / `PAY_NAGAD_NUMBER` / `PAY_BANK_INFO`.
2. Verify Mongo Atlas backup config; run one test point-in-time
   restore against staging.
3. Land the `orderSync` 3-line registration fix.
4. Practice setting and clearing `NEXT_PUBLIC_INCIDENT_BANNER_TEXT`
   from the deploy console.
5. Read `OPERATIONAL_PLAYBOOKS.md` end-to-end with the on-call
   engineer.

### Week 0 (pilot launch)

- Onboard merchant 1. Founder concierge.
  - Watch `evt: ` log stream in real-time during their first 24h.
  - Capture every friction point in `MerchantFeedback` (or a Slack
    channel that gets converted to feedback rows).
- Wait 48h for stability before onboarding merchant 2.
- Onboard merchants 2–5 over the next 7 days at 1-merchant-per-day.

### Weeks 1–4 (pilot operations)

- Daily review of `adminObservability.systemHealth` + the feedback
  queue.
- Weekly merchant check-ins (15 min each). Record observations in a
  shared doc, not in product features yet.
- The next product milestone is decided by the cluster pattern in the
  feedback queue, not by the roadmap doc.

### Weeks 5–8 (assessment + Phase 2 prep)

- Honest readout: did all 5 merchants complete onboarding? Did any
  abandon? What was the most common friction point?
- Land the 4 hold-gate follow-ups from §1 if they aren't already in.
- Open Phase 2 (5 more merchants) only if the Phase 1 NPS is positive
  AND the support burden is manageable.

---

## 7. Recommended next milestone (after real merchant usage begins)

The honest answer is: **whichever cluster shows up first in the feedback
queue.** The polish-phase report already mapped this:

- **If support tickets cluster on "I don't know what Cordon is doing":**
  ship the trust-surface follow-ups (sidebar health pill,
  per-merchant support UI, integration-status timeline, daily ops
  digest).
- **If tickets cluster on "this order should have been flagged" /
  "this order shouldn't have been flagged":** populate the
  `[FILL]` placeholders in `INTENT_INTELLIGENCE_VALIDATION_REPORT.md`
  with real data, then proceed to the conditional `computeRisk`
  integration described there.
- **If tickets cluster on "an order failed and I didn't know":**
  the operational hint detection layer is in place; ship the NDR
  Engagement Engine (WhatsApp/SMS recovery flow) — this is the
  highest revenue-leverage layer in the master strategy.
- **If tickets cluster on courier-specific issues:** ship the
  per-(provider, error-code) admin observability card +
  provider-aware next-step copy from the polish-report §Step 7.

**Picking the milestone before the data lands would be guessing.**

In parallel — while the cluster pattern is forming — the team should
finish:

- The 4 hold-gate items from §1.
- The CSP enforce flip (master audit §15).
- The Shopify GDPR data-redaction sweep (master audit §15) if any
  of the 5 design partners is on Shopify (likely 4 of 5 are, since
  Shopify is the dominant BD storefront).

---

## 8. Validation evidence (this milestone)

| Check | Result |
|---|---|
| `npm --workspace apps/api run typecheck` | clean |
| `npm --workspace apps/web run typecheck` | clean |
| `npm --workspace packages/db run build` | clean |
| `npm --workspace apps/api test` (full suite) | **728/728 pass** (was 718 + 10 new feedback tests) |
| `npm run build` (production, all four workspaces) | all dists emitted |
| Replay durability | unchanged — `WebhookInbox`, `PendingJob` schemas + workers untouched |
| Queue safety | unchanged — `safeEnqueue`, replay sweeper, circuit breaker untouched |
| Webhook integrity | unchanged — HMAC + freshness gate + raw-body parser order untouched |
| Operational-hint rendering | unchanged — pure-function classifier from prior milestone untouched |
| Observability logs | extended only — added `evt: feedback.submitted`; existing logs unchanged |

### Files added this milestone

- `packages/db/src/models/merchantFeedback.ts` — new model (additive)
- `apps/api/src/server/routers/feedback.ts` — new tRPC router
- `apps/web/src/components/feedback/feedback-button.tsx` — new UI
- `apps/api/tests/feedback.test.ts` — 10 new tests
- `DESIGN_PARTNER_READINESS_CHECKLIST.md` — readiness audit
- `OPERATIONAL_PLAYBOOKS.md` — 8 playbooks + cross-cutting + on-call
- `DESIGN_PARTNER_LAUNCH_REPORT.md` — this document

### Files edited this milestone

- `packages/db/src/index.ts` — add `MerchantFeedback` to barrel
- `apps/api/src/server/routers/index.ts` — mount `feedbackRouter`
- `apps/api/src/server/routers/adminObservability.ts` — add admin
  procedures `recentFeedback` + `triageFeedback`
- `apps/web/src/components/shell/topbar.tsx` — mount `<FeedbackButton>`
- `apps/web/src/components/onboarding/onboarding-checklist.tsx` —
  benefit-framed `STEP_HINTS`

**Total LOC delta:** ~520 lines code + ~1100 lines documentation.

---

## 9. Closing

Cordon is in the strongest shape it has been in. The platform is mature
enough for real merchants; the operational tooling is mature enough to
support them; the playbooks are written so the on-call engineer doesn't
have to invent process during an incident.

The decision now is **discipline**, not engineering: onboard 5 merchants,
let them break things in ways nobody predicted, and let the next milestone
fall out of what real usage shows. The platform's job for the next 30 days
is to be boring — to surface the right signals, not to add new ones.

> "Real merchant signal beats roadmap intuition every time." That's the
> spirit of this phase. The team's instinct will be to ship more
> features when something looks fragile; resist it. Ship visibility,
> ship support, ship trust. Features come back later — once we know
> which ones actually matter.

---

**End of launch report.**

*Decision: GO for the 5-merchant pilot. Hold for 25-merchant expansion
until the four follow-ups in §1 land. The path forward is data, not
roadmap.*
