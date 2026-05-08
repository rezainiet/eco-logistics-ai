# RTO_PREVENTION_STRATEGY_MASTERPLAN.md

**Repository:** `C:\devs\ecommerce-logistics` (Cordon)
**Strategic shift:** "fraud detection" → **RTO prevention infrastructure for COD commerce**
**Geography:** Bangladesh-first; design extensible to PK / IN / LK / NP / ID / PH / VN / MY / TH (per `packages/db/src/models/merchant.ts:9`).
**Date:** 2026-05-07

> "Fraud" is one input feature. **RTO is the outcome we are paid to lower.** This document re-frames the architecture around that outcome and grounds every recommendation in a specific file in the current monorepo.

---

# Phase 1 — Deep System Audit

## A. Existing RTO-related signals (what we already collect)

Each item below is verified at the listed `path:line`. The "Used in RTO scoring?" column is the load-bearing observation: many of these signals are collected today but never reach the risk decision.

| Signal class | Field / source | Used in risk today? | RTO-leverage gap |
|---|---|---|---|
| **Phone reputation** | `RiskHistory.phoneOrdersCount/returnedCount/cancelledCount/unreachableCount`, decay-weighted at half-life days (`apps/api/src/server/risk.ts:266-282`) | ✅ Yes — `priorReturns` (22), `priorCancelled` (14), `unreachableHistory` (20), `duplicatePhone[Heavy]` | Strong. Already cross-merchant-aware via `lib/fraud-network.ts`. |
| **Address fingerprint** | `hashAddress(address, district)` — token-sorted SHA-256, `risk.ts:160-170` | ✅ Yes — `duplicateAddress` (22), `addressReturnedCount` | Doesn't measure *quality* of the address (landmark presence, completeness, ambiguity). |
| **Customer tier** | `classifyCustomerTier` (new/standard/silver/gold) by delivered count + success rate, `risk.ts:374-394` | ✅ Yes — gold buyers bypass soft signals | Today only ONE merchant's history counts. Cross-merchant tier (network gold) is not surfaced in tier classification. |
| **COD value** | `highCod` / `extremeCod` with adaptive p75/avg thresholds, `risk.ts:328-365` | ✅ Yes — adaptive per-merchant | Doesn't account for COD-vs-prepaid mix; doesn't penalize "first order > merchant p99". |
| **District / area** | `normalizeDistrict` with Bangla aliases (`apps/api/src/lib/district.ts:22-55`) | ✅ Used in `suspiciousDistrict` signal + courier scoring | District-level only. **Thana/upazila granularity is the actual courier delivery unit in BD — not modeled.** |
| **Velocity** | `phoneVelocityCount` inside merchant-config window, `risk.ts:266-282` | ✅ Yes — `velocityBreach` (75, single-hit HIGH) | Strong. |
| **IP velocity** | `ipRecentCount` over 10-min window, `risk.ts:87-88` | ✅ Yes — `ipVelocity` (16) | Many BD COD buyers share NAT IPs (mobile networks); signal is weaker than for global ecommerce. |
| **Fake-name pattern** | `isFakeNamePattern` — keyboard walks, vowel-less tokens, Bangla placeholders, `risk.ts:104-147` | ✅ Yes — `fakeNamePattern` (25) | Strong + Bangla-aware. |
| **Garbage phone** | `isGarbagePhone` — all-same-digit, BD-canonical-shape check, `risk.ts:185-199` | ✅ Yes — `garbagePhone` (30) | Strong. |
| **Cross-merchant fraud network** | `FraudSignal` collection keyed `(phoneHash, addressHash)`, contributed via `contributeOutcome`, looked up via `lookupNetworkRisk` (`apps/api/src/lib/fraud-network.ts`) | ✅ Yes — bonus capped at +25, decayed at 180d | Powerful. **Scope is the moat.** |
| **Courier × district performance** | `CourierPerformance` keyed `(merchantId, courier, district)` + `_GLOBAL_` aggregate, with `totalDeliveryHours` + `recentFailureCount` (`packages/db/src/models/courierPerformance.ts`) | ✅ Yes — `selectBestCourier` reads it | Strong. **District granularity only — thana variance is invisible.** |
| **Courier circuit breaker** | Per `(provider, accountId)`, 5-failure trip / 30s open / 5s wall-time ceiling (`apps/api/src/lib/couriers/circuit-breaker.ts:51-55`) | ✅ Yes | Strong. |
| **Tracking events on Order** | `logistics.trackingEvents` array, `$slice`-capped 100, with `normalizedStatus`: pending/picked_up/in_transit/out_for_delivery/delivered/failed/rto/unknown (`packages/db/src/models/order.ts:68-90`) | ⚠️ Partial — fed by `trackingSync` worker + courier webhooks, surfaced on tracking page, **but `failed`/`rto` outcomes do NOT trigger any NDR recovery flow** | This is the single largest piece of unused operational leverage in the repo. |
| **Behavior sessions** | `TrackingSession` — pageViews, productViews, addToCart, checkout funnel counts, scroll depth, duration, repeatVisitor, abandonedCart, converted, riskHint, riskFlags (`packages/db/src/models/trackingSession.ts:28-73`) | ❌ **NOT used in `RiskHistory`.** Stitched to orders via `resolveIdentityForOrder`, but never feeds a signal into `computeRisk`. | **Massive untapped intelligence.** A buyer who scrolled the product page for 3 minutes, viewed reviews, then placed COD has very different RTO odds than a 12-second drive-by. We measure all of this and discard it for RTO scoring. |
| **Campaign / UTM** | `TrackingEvent.campaign.{source,medium,name,term,content}` captured server-side from URL (`packages/db/src/models/trackingEvent.ts:51-58`); `TrackingSession.campaign` snapshot | ❌ Not joined to RTO outcomes | "Facebook ads vs Google ads vs organic" is a known RTO-rate split in BD — we have the data, never compare. |
| **Device** | `device.{type,os,browser,viewport,language}` per event/session | ❌ Not used | Mobile-first BD makes device useful for fingerprinting buyer cohort, not just for fraud. |
| **Phone normalization** | `normalizePhoneOrRaw` + `phoneLookupVariants` (E.164 + locale-aware), `apps/api/src/lib/phone.ts` | ✅ Used at every ingest seam | Strong. |
| **Confirmation flow** | `automation.confirmationCode` (8-digit), `confirmationSentAt`, `confirmationDeliveryStatus` (pending/delivered/failed/unknown — DLR-driven), `confirmationDeliveryError` (`order.ts:285-305`) | ✅ Yes — pending_confirmation → confirmed/rejected/no_answer | Single channel (SMS). No WhatsApp. No agent escalation tier. |
| **Inbound SMS reply parsing** | `parseSmsInbound` — YES/NO + Bangla "ha"/"na" + 6-or-8-digit code (`apps/api/src/lib/sms-inbound.ts:22-75`) | ✅ Yes — `automation.sms_confirm` / `sms_reject` audit | Strong. The function is provider-agnostic and ready to plug WhatsApp into. |
| **Late reply** | `automation.lateReplyAcknowledgedAt` — once-per-order guard for "your order expired" courtesy reply (`order.ts:339-341`) | ✅ Yes | Strong. |
| **Manual payment risk** | `riskScore` + `riskReasons` on Payment + cross-merchant fingerprint hashes (txnIdNorm, proofHash, metadataHash) (`packages/db/src/models/payment.ts:121-148`) | Subscription billing only — orthogonal to RTO | — |
| **Stale-pending escalation** | `automation-stale` worker: 24h no-reply → escalate to `pending_call`; 72h → auto-cancel (`apps/api/src/workers/automationStale.ts:39-46`) | ✅ Yes | Strong, but the escalation today is "tell the merchant"; no proactive WhatsApp/call attempt. |
| **Watchdog** | Re-enqueues stuck `auto_confirmed`/`confirmed` orders past 10 min with no tracking number (`apps/api/src/workers/automationWatchdog.ts:38-52`) | ✅ Yes | Strong. |
| **Audit trail** | Hash-chained `AuditLog` covering every state transition (`packages/db/src/models/auditLog.ts`) | ✅ Tamper-evident | Strong — under-utilised as a source of operator-quality signals. |
| **Rejection snapshot** | `preActionSnapshot` for full state-restore on un-reject (`order.ts:386-399`) | ✅ Used by restoreOrder | Strong. |

### Where RTO signals originate / are stored / processed / surfaced

```
                                  ┌───────────────────────────┐
                                  │  Storefront SDK (track)   │
                                  └─────────────┬─────────────┘
                                                │  collector.ts
              ┌─────────────────────────────────┼────────────────────────────────┐
              ▼                                 ▼                                ▼
   Behavior sessions               Webhook delivery (Shopify/Woo)   Manual order create (dashboard/API)
   TrackingEvent + TrackingSession             │                                │
              │                                ▼                                │
              │                       WebhookInbox.received                      │
              │                                │                                │
              └──────► ingest.ts ◄─────────────┴────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────────┐
              │  computeRisk(...) in risk.ts    │   ← reads phone history, address hash, COD,
              │  produces RiskResult + signals  │     velocity, fraud network, fake-name, etc.
              └────────┬────────────────────────┘
                       │
                       ├──► Order (fraud.* + automation.* + source.*)
                       ├──► FraudPrediction (frozen snapshot for tuner)
                       └──► fireFraudAlert / Notification (high)
                       │
                       ▼
                 automation.state machine:
                 not_evaluated → auto_confirmed | pending_confirmation | requires_review
                       │
                       ▼
            AutoSms (SMS prompt, DLR-tracked) ─► customer reply parsed (parseSmsInbound)
                       │
                       ├─ confirm → AutoBook (courier intelligence + circuit breaker)
                       └─ reject  → snapshot + cancel
                       │
                       ▼
                bookSingleShipment → Order.logistics.trackingNumber
                       │
                       ▼
          tracking-sync worker (60m) + courier webhooks
                       │
                       ▼
       Order.logistics.trackingEvents → riskRecompute on RTO/no-answer
                       │
                       ▼
       FraudPrediction.outcome (delivered | rto | cancelled)
                       │
                       ▼
       fraudWeightTuning (monthly) → per-merchant signalWeightOverrides
```

The **gap**: between `bookSingleShipment` and `FraudPrediction.outcome` there is **no NDR loop, no second-attempt scheduling, no courier swap, no buyer re-engagement**. The pipeline is open-loop after dispatch.

---

## B. Existing operational workflows

### Order review flow
- Path: `dashboard/orders/page.tsx` → tRPC `orders.list` (filters by status, date, courier, fraud reviewStatus).
- Bulk actions: confirm, reject, restore.
- Audit-stamped via `automation.bulk_confirmed/rejected`.
- Friction: filter combinations are static; no saved views; no "show me orders likely to RTO this week" predictive list.

### Fraud review flow
- Path: `dashboard/fraud-review/page.tsx` → `fraud.list` queue ordered by `fraud.riskScore desc, _id desc` (`order.ts:438-447` index).
- States: `not_required → optional_review → pending_call → verified | rejected | no_answer`.
- Operator surface: per-order signals + reasons + customer history + call CTA.
- **Missing intervention point**: when a signal fires that the merchant could *fix at checkout* (e.g. "this customer has 3 RTOs cross-network"), the merchant gets no preventive nudge — only post-hoc review.

### Courier booking flow
- Per-order: `bookSingleShipment` (`apps/api/src/server/routers/orders.ts`, called from `automationBook.ts`).
- Selection: `selectBestCourier` reads `CourierPerformance` for (merchantId, courier, district), falls back to `_GLOBAL_`, applies cold-start / stale / preferred / recent-failure rules (`apps/api/src/lib/courier-intelligence.ts`).
- Booking lock + version CAS prevent double-book.
- Fallback chain: 3 couriers max, 1h decaying penalty per failure.
- **Missing**: no "switch courier mid-route" capability. Once an AWB is created, the order is committed to that courier even if it sits 4 days unprocessed.

### Tracking flow
- `tracking-sync` worker (every 60m default) calls courier adapter, normalizes status, dedupes events by `(at + providerStatus)` hash, slices array at 100 (`order.ts:65-90`).
- Courier webhooks push real-time updates (`apps/api/src/server/webhooks/courier.ts`).
- Customer-facing page at `/track/[code]` with merchant branding.
- **Missing**: tracking-status transitions don't fire downstream actions beyond `riskRecompute` (which fires on `order.rto` post-hoc). Specifically, **`failed` and `unknown` and "stuck in_transit > 5 days"** are silent.

### Webhook recovery flow
- WebhookInbox `received → processing → succeeded | failed | needs_attention`.
- `webhook-retry` sweep every 60s; cap 5 attempts → dead_letter alert.
- `needs_attention` is non-retried (storefront fix needed).
- **Strong**. Not the bottleneck.

### Merchant notifications
- In-app `Notification` collection with severity + dedupeKey (`packages/db/src/models/notification.ts`).
- Severity-tiered admin alert prefs (info/warning/critical).
- Push to merchant via dashboard inbox; admin alerts via email + SMS.
- **Missing**: no proactive RTO notifications ("3 of your orders this week look high-RTO; here's why and what you can do").

### SMS / WhatsApp flows
- SMS: SSL Wireless (BD) outbound (`apps/api/src/lib/sms/sslwireless.ts`).
- Outbound helpers: OTP, order confirmation, password-reset alert, critical alert.
- Inbound: parsed by `parseSmsInbound` — provider-agnostic, designed for WhatsApp drop-in (`apps/api/src/lib/sms-inbound.ts:1-20`).
- DLR: `automation.confirmationDeliveryStatus` updated from delivery-receipt webhook.
- **Missing**: WhatsApp Business adapter does not exist. No template-message library. No fallback chain (SMS → WhatsApp → call).

### Manual review flows
- Call-center surface at `dashboard/call-customer/page.tsx`.
- Per-order: log call, mark answered/unanswered/duration/notes (`packages/db/src/models/order.ts:205-214`).
- Bulk verify/reject.
- **Missing**: no script generation per (riskScore, customerTier, signals) — agents work from a generic UI.

### Dashboard operator workflows
- Multiple specialised surfaces (orders, fraud-review, recovery, integrations, billing, settings, analytics, call-customer, getting-started).
- Activation toaster fires once-per-merchant on key milestones.
- **Friction**: each surface is its own filter/sort UX; no unified "RTO control panel" that says "here are this week's most fixable RTOs."

---

## C. Existing data opportunities — hidden leverage

The signals below are **already collected** and **already indexed**, but **never feed the RTO decision**. Each line is a Sprint-or-less unlock.

### Behavioral signals (TrackingEvent / TrackingSession)
| Already collected | Already indexed | Used in RTO score? | Leverage if joined |
|---|---|---|---|
| `pageViews`, `productViews`, `durationMs` | `(merchantId, lastSeenAt:-1)` | ❌ | Engagement quality → commitment proxy |
| `addToCartCount`, `checkoutStartCount`, `checkoutSubmitCount` | same | ❌ | Funnel completion ratio is a strong intent signal |
| `maxScrollDepth` | same | ❌ | Read-the-product-page proxy |
| `repeatVisitor` (≥2 sessions same anonId/email/phone) | same | ❌ | Strong commitment signal — outweighs many soft fraud signals |
| `landingPath`, `referrer`, `campaign.{source,medium,name}` | snapshot on session | ❌ | Per-campaign RTO rate is the merchant ad-quality lever |
| `device.{type,os,browser}` | per event | ❌ | Cohort segmentation |

### Tracking outcomes
| Already collected | Surfaced? | Used to drive workflow? | Leverage |
|---|---|---|---|
| `logistics.trackingEvents[]` with `normalizedStatus: failed`/`out_for_delivery` | ✅ Tracking page | ❌ No NDR worker | **Highest single unlock**: an automated "courier marked failed → re-confirm with buyer → reschedule" loop |
| `logistics.shippedAt` / `deliveredAt` / `returnedAt` | ✅ | Used by courier-perf totalDeliveryHours | Not used to detect "this order has been in_transit longer than this courier × district average" |
| `logistics.pollErrorCount` / `pollError` | ✅ | Used by tracking-sync skip logic | Could flag couriers whose tracking endpoints flake (signal of operational stress) |

### Order timestamps
| Field | Indexed? | Used for RTO? |
|---|---|---|
| `createdAt` | ✅ | Listing only |
| `automation.confirmedAt` / `rejectedAt` / `confirmationSentAt` / `confirmationDeliveredAt` | partial | Stale-pending sweep only |
| `logistics.shippedAt` → `deliveredAt`/`returnedAt` | ✅ | Per-courier delivery hours |
| Time-of-day / day-of-week of order placement | ❌ | **Strongly RTO-correlated in BD** — late-night orders RTO at higher rates; not modeled |

### Address tokens
| Already in `hashAddress` | Not extracted yet |
|---|---|
| Token-sorted SHA-256 fingerprint | Token *count* (proxy for completeness) |
| | Presence of landmark words ("masjid", "mosque", "tower", "school", "hospital", "bazar", "market") |
| | Presence of road/house numbers |
| | Bangla vs Latin script ratio |
| | Length / token diversity |

### Audit log as a feature source
- Every `automation.confirmation_sms_undelivered`, `automation.escalated_no_reply`, `awb.reconcile.abandoned`, `integration.webhook_dead_lettered` is a per-merchant operational quality signal. Not aggregated into a merchant-quality score today.

### Merchant operational fingerprint
- We know per merchant: trial-to-active conversion time, time between connect and first event, courier mix, p75 / mean order value, fraud-config tunings, automation mode (manual/semi/full_auto), pause history.
- These compose into a "merchant operational maturity" scalar — never computed.

### Cross-merchant network (depth)
- Today: phone+address fingerprint with delivered/RTO/cancelled counts. Single time-decayed bonus.
- **Latent**: same fingerprint's *device fingerprint* ratio across merchants (same phone using 50 different devices = bot ring). We collect device on TrackingEvent, never propagate.
- **Latent**: fingerprint × campaign distribution (this phone keeps coming via the same FB campaign on 5 different merchants = single ad farm).

---

# Phase 2 — Strategic RTO Framework

The RTO Prevention Engine is six layers, each with explicit inputs from the audit above. The framework is intentionally **outcome-named** (Intent / Address / Commitment / Courier / NDR / Merchant) rather than signal-named — fraud is one feature inside Intent, not the whole product.

## Layer 1 — Intent Intelligence

### Goal
Measure *buyer commitment* at order time, before any courier action. The single best predictor of "buyer will accept the parcel" is "buyer behaved like they wanted the parcel."

### Inputs (already in the repo)
- `TrackingSession` for the anonId/phone/email tied to this order via `resolveIdentityForOrder` (`apps/api/src/server/ingest.ts:924-997`).
- `pageViews` / `productViews` / `addToCartCount` / `checkoutStartCount` / `durationMs` / `maxScrollDepth` / `repeatVisitor` (already on session).
- Funnel ratio: `checkoutSubmitCount / max(1, checkoutStartCount)`.
- `campaign.{source,medium,name}` of the session that converted.
- Time from session start → checkout submit (ms).

### Composition: `IntentScore` (0–100)
- **Commitment subscore** (0–40):
  - `repeatVisitor` → +10 baseline.
  - `productViews ≥ 3` → +5.
  - `maxScrollDepth ≥ 50` → +5.
  - `durationMs ≥ 60s` → +10.
  - `(checkoutSubmitCount / max(1, checkoutStartCount)) ≥ 0.5` → +10.
- **Engagement quality** (0–30):
  - Direct or organic landing → +10. Paid social → 0. Organic-search → +15.
  - Multi-session converter (anonId seen across days) → +15.
- **Confirmation quality** (0–30):
  - SMS prompt delivered (`confirmationDeliveryStatus = "delivered"`) → +5.
  - Customer replied with code → +20.
  - Customer replied within 1h → +5.

### Where it lives
- New: `apps/api/src/lib/intent.ts` — pure function `computeIntent(session, automation)` returning `{ score, contributions: [...] }`.
- Persisted: `Order.intent` subdoc with `score`, `commitment`, `engagement`, `confirmationQuality`, `signals: [{key, weight, detail}]`.
- Read at: `ingest.ts` (initial pre-confirm score using session data only) and `automationSms` post-DLR (re-score with confirmation quality once reply arrives).

### How it consumes existing systems
- `resolveIdentityForOrder` already stitches sessions to orders. We piggyback on that linkage — no new collection needed.
- Tracking session is permanent (no TTL), so historical commitment is queryable.

### What it is NOT
- It is **not invasive**. We don't add new client tracking — every input is already collected by the storefront SDK we already ship.
- It is **not a deterministic gate**. The score modifies risk weighting and surfaces in the agent UI; it does not by itself reject orders.

---

## Layer 2 — Address Intelligence

### Goal
Score the *deliverability* of each address before dispatch. In Bangladesh, 30–60% of RTOs trace to address ambiguity, not buyer intent.

### Inputs (already in the repo)
- Raw `customer.address` + `customer.district` on Order.
- Existing `hashAddress` fingerprint.
- `CourierPerformance` rows (delivered / rto / cancelled per `(merchant, courier, district)`).
- `normalizeDistrict` aliases (covers 14+ BD districts incl. Bangla).

### New components

#### 2a. Address completeness score (`AddressQuality`)
Pure function over `(address, district)`:
- **Token count**: addresses < 5 tokens are typically incomplete.
- **Landmark word presence** (BD-specific list; Latin + Bangla):
  - Latin: `road`, `house`, `flat`, `block`, `sector`, `tower`, `mosque`, `masjid`, `bazar`, `market`, `school`, `college`, `hospital`, `clinic`, `gate`, `more` (intersection), `circle`, `lane`, `bridge`, `pump`, `station`, `chairman`.
  - Bangla: `রোড`, `বাজার`, `মসজিদ`, `স্কুল`, `কলেজ`, `হাসপাতাল`, `চেয়ারম্যান`, `গেট`, `মোড়`, `টাওয়ার`, `ব্রিজ`, `পাম্প`.
- **Number presence**: at least one digit → +5 (house/road number).
- **Script ratio**: pure-Latin or pure-Bangla > mixed (mixed-script addresses are statistically harder to deliver).
- **Length floor**: < 15 chars = `incomplete`.

Output: `{ score: 0..100, completeness: "complete"|"partial"|"incomplete", missingHints: string[] }`. Surface `missingHints` to the merchant pre-ship: "No landmark detected — ask the buyer for a nearby mosque or bazar."

#### 2b. Thana/Upazila granularity
Today only `district` is captured — but Bangladesh delivery is coordinated at the **thana** (police station / urban subdistrict) level. Pathao / Steadfast / RedX zone fees, hub assignments, and rider routing happen at thana, not district.

- **Schema change**: `Order.customer.thana` (new field, optional, indexed under `(merchantId, thana, createdAt:-1)`).
- **Population strategy**:
  - Stage 1: extract from address with a thana lexicon (~500 known thana names per BD division).
  - Stage 2: courier APIs return zone IDs on AWB creation — store both.
  - Stage 3: merchant checkout integration emits thana directly (post-Shopify-app evolution).
- **Read path**: `CourierPerformance` extends to `(merchantId, courier, district, thana)` with `_GLOBAL_THANA_` sentinel for fallback. The selection engine is already set up for this — `district + _GLOBAL_` fallback exists; adding thana is one level deeper.

#### 2c. Area risk score
Per `(district, thana)`:
- 90-day rolling RTO rate across the platform (reuse `FraudPrediction.outcomeAt` aggregation pattern).
- Surface as Area Risk Index in agent UI: "Mirpur/Mirpur-1: 12% RTO (platform avg 18%)" — context the merchant doesn't get from a single risk score.

#### 2d. Courier-specific area success
Already partially modeled. **What's missing**: surface this *to the merchant pre-ship* via a `previewCourierForAddress(address, district, thana)` tRPC query that returns ranked courier success rates. Today the engine uses this internally; making it a UI primitive lets the merchant override before commit.

### Where it lives
- New: `apps/api/src/lib/address-intelligence.ts` (pure function).
- New schema field: `Order.address.quality` (subdoc with score + hints, set at ingest).
- New tRPC query: `addressIntelligence.previewForAddress`.

---

## Layer 3 — Delivery Commitment Layer

### Goal
Convert "buyer placed the order" into "buyer is actively committed to receive it" — *before* the courier picks up. Each step we add raises the cost of refusal.

### Today (verified)
The pipeline today does **only one** of the four commitment steps that high-performing BD merchants run:
1. SMS confirmation prompt with 6/8-digit code (`automationSms.ts`). ✅
2. Inbound parsing of YES/NO replies (`sms-inbound.ts`). ✅
3. Stale-pending sweep (24h notify, 72h cancel). ✅

### Proposed escalation ladder
A configurable, merchant-tunable ladder. Each step that lands lifts the commitment quality input to Intent Layer 1.

| Step | Channel | Trigger | Implementation footprint |
|---|---|---|---|
| 0 | (immediate) | Order confirmation SMS with order summary | Already exists |
| 1 | SMS | Confirmation prompt with code (existing) | Already exists |
| 2 | **WhatsApp** | If SMS DLR=`failed` OR no reply at T+30min | New: WhatsApp Business adapter (Meta Cloud API). `parseSmsInbound` is provider-agnostic and ready (`sms-inbound.ts:1-20`). Adapter is ~400 LOC + a new env var pair. |
| 3 | **Auto-call** (IVR with code playback) | If WhatsApp not delivered/replied at T+2h | New: Twilio is already a dep (`apps/api/package.json:39`), used by webhooks. Outbound TwiML flow + DTMF capture. ~600 LOC. |
| 4 | **Agent call** | If auto-call fails OR risk ≥ HIGH | Today: agent picks up `pending_call` from queue. Add: per-order auto-script with variables (`riskScore`, `customerTier`, `signals`, `missingAddressHints`). |
| 5 | **Soft-cancel + courtesy SMS** | T+72h no contact (existing) | Already exists |

### Pre-dispatch confirmation logic
- Today: low-risk auto-confirms; medium/high → SMS prompt; on confirm → AutoBook.
- Proposed: introduce a **commitment-tier gate** on the auto-book trigger.
  - `commitmentTier = "verified"` (replied with code) → AutoBook immediately.
  - `commitmentTier = "implicit"` (low risk + gold buyer + delivered SMS) → AutoBook after 1h cool-down (lets buyer cancel by SMS first).
  - `commitmentTier = "unverified"` (delivered SMS, no reply) → escalate to Step 2/3.
- This is a state-machine extension on `automation` — **no new top-level model**; one new enum value (`commitmentTier`) and the existing `automationConfig` mode (manual / semi_auto / full_auto) becomes orthogonal to commitment level.

### Delivery preference collection
- WhatsApp adapter (Step 2) is the natural seat for: "When would you like delivery? Reply 1 (today), 2 (tomorrow), 3 (specific time)." Captures `Order.automation.preferredDeliveryWindow`.
- Pass to courier via adapter `notes`/`scheduledDate` on AWB create — Pathao supports a delivery_preference field, RedX has `expected_delivery_date`.

### Psychological commitment
- Public order tracking page (`/track/[code]`) is already merchant-branded. Extend to show:
  - "You've committed to ৳1,250 COD. Cancel for free until 11:00 AM tomorrow."
  - "70 buyers in your area accepted similar deliveries this week."
  - One-tap "Confirm I'll be home" button → stamps `Order.automation.buyerConfirmedHomeAt` (lifts commitment subscore).
- Loss aversion + social proof, two well-documented commerce levers, with no extra data collection.

### Goal
**Reduce refusal before shipment.** Every dollar of refusal-at-door is RTO; every dollar of cancellation-pre-dispatch is shipping cost saved. Make cancellation cheaper than refusal.

---

## Layer 4 — Courier Intelligence Layer

### Already strong
- `CourierPerformance` per (merchant, courier, district) — `apps/api/src/lib/courier-intelligence.ts` is mature: 60·success − 30·rto + 10·speed + preferred bonus, with cold-start, stale, recent-failure penalty, and circuit breaker.

### What's missing
1. **Thana-level granularity** (covered in Layer 2). District is too coarse — Steadfast performs differently in Mirpur-1 vs Mirpur-12.
2. **Delivery-speed → RTO link**. We track `totalDeliveryHours` but never test the hypothesis "couriers that deliver in <36h have lower RTO." Likely true in BD: longer transit = more time for buyer regret.
3. **Failure-pattern fingerprinting**. Today recent failures are a single counter. Per-courier we should track failure *kinds* (`auth_failed`, `invalid_input`, `provider_error`, `timeout`) — `CourierError.code` already classifies this (`apps/api/src/lib/couriers/types.ts:5-14`), we just don't aggregate.
4. **Dynamic switching post-dispatch**. Once an AWB is issued, the order is locked to that courier — even if the package sits 5 days in their hub. Add a `tracking-stuck` worker:
   - Detect: order in `in_transit` for > P95 of (courier, district) deliveryHours × 1.5.
   - Action: surface to merchant with one-click cancel-and-rebook on next-best courier (if courier API supports cancellation). For couriers that don't, escalate to merchant call.
5. **Time-of-day / day-of-week bias**. Pathao Friday performance differs from Tuesday performance. Adding `(hourBucket, dayBucket)` to `CourierPerformance` makes the selection engine schedule-aware: "book this on Sunday morning if possible."

### Implementation footprint
- All four are **extensions of `CourierPerformance` + `selectBestCourier`** — no new models, no new workers. The schema gains 2-3 fields; `recordCourierOutcome` writes them; scoring reads them.
- Thana adds a fourth tuple component to the unique key — straightforward Mongo migration with `_GLOBAL_THANA_` fallback identical to the existing `_GLOBAL_` district fallback.

---

## Layer 5 — NDR Recovery Layer

### The single biggest gap in the codebase

When a courier marks delivery `failed`, today the only thing that happens is:
1. Tracking event lands in `Order.logistics.trackingEvents`.
2. The order's `order.status` transitions toward `rto` (eventually).
3. `riskRecompute` fans out to rescore the buyer's *other* orders.

**The buyer is never re-engaged. The merchant gets no actionable workflow. There is no second-attempt orchestration.**

In BD reality, 25–40% of "failed" deliveries are recoverable on second attempt with one phone call. We discard that revenue today.

### Design

#### 5a. NDR detection
- Source signals (already in `Order.logistics.trackingEvents`):
  - `normalizedStatus = "failed"`.
  - `normalizedStatus = "out_for_delivery"` followed by NOT `"delivered"` within 24h (silent failure — courier didn't bother to mark).
  - `normalizedStatus = "in_transit"` with no transition for > P90(courier × district deliveryHours).
- New worker: `ndr-detect` (every 30 min, batch 200) — flags these as `Order.logistics.ndrAt` and creates an `NdrTask`.
- New collection `NdrTask` (parallel to `RecoveryTask`):
  - `merchantId`, `orderId`, `kind: "failed_delivery" | "stuck_in_transit" | "buyer_unreachable"`, `firstDetectedAt`, `attempts`, `status: "pending" | "contacting" | "rescheduled" | "abandoned" | "recovered"`, `lastAttemptAt`, `nextActionAt`, `resolution`.

#### 5b. Buyer re-engagement
- Step 1 (T+0): Auto-WhatsApp/SMS — "Your parcel from <merchant> couldn't be delivered. Reply READY <code> when you'd like the next attempt."
- Step 2 (T+4h no reply): Auto-call with IVR.
- Step 3 (T+24h): Surface to merchant call queue with full context.

#### 5c. Reschedule API
- Pathao supports reschedule via API. Steadfast does not (must call). RedX is partial.
- Adapter extension: `adapter.rescheduleAWB(trackingNumber, newDate)` returning `{ supported: boolean, ok: boolean }`.
- For unsupported couriers, surface to merchant with a copy-paste-able script.

#### 5d. Smart retry timing
- Per `(district, thana, hourBucket)`, learn delivery success by retry slot. Today we have raw outcome data per courier-area; aggregating by retry-slot is the same query, sliced.
- Surface: "Buyer agreed to Friday afternoon — that slot has 78% success in this thana with this courier."

#### 5e. Communication escalation
- Per merchant: configurable max-attempts, between-attempt delay, escalation channel order.
- Merchant default: 2 retries, 24h between, SMS → WhatsApp → call → agent.

### Why this is the highest-ROI layer
- Pure recovery — every NDR we save is incremental revenue from already-paid-shipping orders. The merchant economics: a recovered NDR is worth the full order value × COD margin minus one extra delivery attempt's courier fee.
- Network-effect data: every NDR outcome (recovered / abandoned / cancelled-on-second-attempt) is a labeled training signal for the risk + intent + courier engines.
- Differentiator: nobody in BD COD ships a real NDR engine; today this is a person-on-WhatsApp doing it manually.

### Implementation footprint
- 1 new model (`NdrTask`).
- 1 new worker (`ndr-detect`).
- 1 new worker (`ndr-engagement`) — sends Step 1 messages, schedules Step 2/3 timers.
- 1 dashboard surface (`/dashboard/ndr` mirrors `/dashboard/recovery`).
- WhatsApp adapter (also serves Layer 3).

---

## Layer 6 — Merchant Intelligence Layer

### Goal
Score the *merchant's* operational quality. The dirtiest secret of BD COD: merchants with misleading ad creative drive their own RTO. The platform owns this data; the merchant doesn't see it.

### Already in the repo (sources)
- Per-merchant rolling order outcomes (delivered / rto / cancelled).
- `Integration.counts.{ordersImported, ordersFailed}`.
- `automationConfig.mode` and bypass thresholds.
- `fraudConfig.signalWeightOverrides` (post-tuner adjustments).
- Pause history (`pausedAt`, `pausedReason`).
- AuditLog flow (`automation.confirmation_sms_undelivered`, `awb.reconcile.abandoned`, `integration.webhook_dead_lettered` density).
- TrackingEvent.campaign per session — already segments orders by ad source.

### Composite: `MerchantOperationalQuality` (0–100)
- **Delivery hygiene**: 90-day delivered rate vs platform peer percentile.
- **Address quality**: average AddressQuality across last 90 days of orders.
- **Confirmation discipline**: % of orders with `confirmationDeliveryStatus = "delivered"`.
- **Cancellation rate**: a merchant with high cancel-on-call (>20%) is asking buyers to confirm orders they shouldn't have placed — likely a creative-misalignment signal.
- **Network reciprocity**: contributes outcome data ↔ benefits from network risk lookup.

### Campaign quality scoring
- Per (merchant, campaign.source, campaign.medium, campaign.name):
  - Order count, conversion rate, RTO rate, confirmation reply rate.
  - Surface as Campaign Health Card on merchant analytics: "Facebook / cpc / spring-sale: 142 orders, 38% RTO (your average 22%) — review creative."
- Joins three existing collections (TrackingSession, Order, FraudPrediction) on session→order link.

### Misleading-ad detection (heuristic)
Per merchant, cross-merchant baseline:
- Campaigns with: low session duration (< 20s), high checkout speed (< 90s from session start to submit), high cancellation rate on call, high "didn't read description" complaints (recoverable from `RecoveryTask.note` and call-log `notes`).
- Output: `MerchantSignal.suspiciousCampaign` with the offending source/medium/name.
- Surface as a soft warning, not a block — the merchant decides.

### Category-specific risk
- Today `Order.items[]` has `name`/`sku`/`quantity`/`price` but no `category`. Add optional `category` (free-form, populated from upstream when present — Shopify product_type, Woo categories).
- Per-(merchant, category): RTO rate, p75 order value, time-to-RTO. Surface in analytics.

### Operational quality scoring
- Computed weekly by a new lightweight worker (`merchant-quality:sweep`, repurpose existing `MerchantStats` model — `packages/db/src/models/merchantStats.ts` is the right anchor).
- Tier: Gold / Silver / Bronze / Watch.
- **Network bonus**: Gold-tier merchants' outcome contributions weight more in the cross-merchant fraud network. Silver counts as 1×, Watch counts as 0.5×. Closes a real risk: a low-quality merchant flooding the network with bad-quality outcome data.

---

# Phase 3 — Product Strategy

## A. What becomes the product moat?

1. **The cross-merchant outcome graph.** Phone+address+device+campaign fingerprints with delivered/RTO/cancelled outcomes, anonymized and capped, growing monotonically per merchant we onboard. This is the asset Shopify itself can't ship (they don't see courier outcomes); Pathao can't ship (they don't see merchant intent / behavior); Sheba can't ship (no SDK on storefronts). **Only a platform that sits between storefront, merchant, and courier can build it.**
2. **Address intelligence specific to BD landmarks + thana lexicon + courier-area mapping.** A real BD-native data set, accumulated through ingest, not a one-off scrape.
3. **The labeled training set.** `FraudPrediction.outcome` is a frozen prediction-vs-reality ledger with 13 months retention. Every new merchant grows this set; competitors start at zero.

## B. What is easy to copy?

- The risk score formula itself. Anyone who reads the spec can reproduce it.
- The webhook idempotency design. Standard practice.
- The courier-intelligence selection logic. Anyone with outcome data can implement.
- The dashboard UX. UX is copyable; the data behind it is not.

## C. What requires proprietary data accumulation?

- Cross-merchant fingerprint outcomes (Layer 1 + Layer 6).
- Per-(merchant, category, campaign) RTO baselines.
- Per-(courier, district, thana, hour, day) success rates.
- Buyer device-cohort tier propagation (gold buyers across merchants).
- Per-thana area risk index.

## D. What compounds over time?

- The fraud network: merchant N+1 makes the score better for everyone before them.
- The address lexicon: every order with a successful delivery teaches us "this token sequence works in this thana."
- The weight tuner: per-merchant adaptation today; per-(merchant × category) adaptation tomorrow; per-(merchant × category × campaign) adaptation when sample size allows.
- The NDR success ledger: every recovered NDR teaches the engagement-script generator.

## E. What becomes stronger with more merchants?

- **Network risk lookup**: stronger as merchant count grows (capped linkability is BY DESIGN — the cap doesn't cap the *signal*, only the *traceability*).
- **Area-risk index**: every new merchant per district adds observations.
- **Courier benchmarking**: Pathao at merchant X delivers 87%; the platform median is 92%; that's a number the merchant cares about and only we can compute.
- **Campaign-health scoring**: cross-merchant campaign fingerprints (same Facebook ad → 5 merchants → 4 of them have 30% RTO = bad ad).

---

# Phase 4 — Architecture Fit

## Reusable systems (touch lightly)

| System | Reuse for | Touch |
|---|---|---|
| `WebhookInbox` | NDR signals from courier webhooks (already there) | Zero |
| `safeEnqueue` + `PendingJob` | Every new worker queues via this | Zero |
| `Order.automation.*` | Add `commitmentTier`, `preferredDeliveryWindow` fields | Schema-additive |
| `Order.logistics.*` | Add `ndrAt`, `ndrAttempts` fields | Schema-additive |
| `CourierPerformance` | Add `thana` to compound key + per-hour buckets | **Migration required** (add field, fall back to district-level row) |
| `RecoveryTask` | Pattern-match for `NdrTask` (parallel collection) | Zero |
| `FraudPrediction` | Continues to feed weight tuner; add `intentScore` snapshot | Schema-additive |
| `AuditLog` | New action types (`ndr.detected`, `ndr.recovered`, `commitment.escalated`) | Enum extension only |
| `dispatchNotification` | Reuse for merchant NDR alerts + campaign warnings | Zero |
| `parseSmsInbound` | Provider-agnostic; route WhatsApp inbound through it | Adapter-level |
| `tracking-guard` (collector hardening) | No change needed | Zero |
| `lib/integrations/safe-fetch.ts` | Reuse for any external WhatsApp / map / lexicon fetch | Zero |

## Extension points (deliberate seams)

1. **`computeRisk` signal contributions** — already structured as `RiskSignal[]`. Adding `intent_low_commitment`, `address_incomplete`, `thana_high_rto` is a function-level change.
2. **Worker registration** in `apps/api/src/index.ts:139-173` — every new worker lands here. (Reminder: the existing `orderSync` worker has a registration gap noted in `MONOREPO_SAAS_MASTER_AUDIT.md` §2 — fix that first; the same wiring pattern applies to every new worker.)
3. **tRPC router composition** in `apps/api/src/server/routers/index.ts:19-38` — `addressIntelligence`, `ndr`, `intent`, `merchantQuality` slot in cleanly.
4. **`Order` schema** — additive subdocs (`Order.intent`, `Order.address.quality`, `Order.commitment`). The repo's optimistic-concurrency `version` field guards against concurrent writers (`apps/api/src/lib/orderConcurrency.ts`).
5. **Integration adapters** — WhatsApp Business adapter under `apps/api/src/lib/integrations/whatsapp.ts` follows the same `IntegrationAdapter` shape (`apps/api/src/lib/integrations/types.ts:126-151`).

## Dangerous refactors (DO NOT do)

1. **Don't rewrite `computeRisk`.** Add new contribution sources; keep the formula stable. The monthly tuner has a per-merchant frozen weights snapshot (`weightsVersion`) and breaking the schema invalidates the labeled dataset.
2. **Don't flatten `automation` into `Order` root.** Mongoose strict-mode + dot-notation has a known quirk on `_id: false` subdocs with enum-constrained fields (documented at `models/order.ts:184-202`). Stay in the existing subdoc shape.
3. **Don't replace `WebhookInbox` with a per-provider table.** The unified table is exactly the abstraction NDR needs — courier webhooks already land there.
4. **Don't introduce TTL on `WebhookInbox`.** The schema explicitly carries an "INFINITE idempotency keys" doc-comment block (`models/webhookInbox.ts:13-45`) — payload reaper bounds storage; row reaper would re-open the dedup window.
5. **Don't shard the audit log per merchant before the cross-cutting reads stop firing.** The chain is global; admin observability reads it across merchants.

## Queue impacts

| New worker | Queue | Cadence | Concurrency | Estimated load |
|---|---|---|---|---|
| `ndrDetect` | `ndr-detect` | every 30 min | 1 | Light — 200 candidate-orders per tick |
| `ndrEngagement` | `ndr-engagement` | event-driven on NdrTask creation | 4 | Medium — sends WhatsApp + schedules retry timers |
| `merchantQuality` | `merchant-quality` | weekly cron | 1 | Light — 1 row per merchant |
| `intentScore` | (no queue — pure function called from `ingest.ts`) | inline | n/a | Negligible |
| `addressQuality` | (no queue — pure function called from `ingest.ts`) | inline | n/a | Negligible |
| `whatsappOutbound` | `whatsapp-outbound` | event-driven | 4 | Medium |

Total: **~5 new queues + 4 new workers**. Within the existing pattern. Queue capacity comfortable on the current single-Redis assumption (see scaling implications below).

## DB impacts

| Change | Type | Risk |
|---|---|---|
| `Order.intent` subdoc | Additive | Low |
| `Order.address.quality` subdoc | Additive | Low |
| `Order.customer.thana` field | Additive | Low (sparse) |
| `Order.logistics.ndrAt` / `ndrAttempts` | Additive | Low |
| `Order.automation.commitmentTier` / `preferredDeliveryWindow` / `buyerConfirmedHomeAt` | Additive | Low |
| `CourierPerformance` adds `thana` to compound key | **Index migration** | Medium — write a one-shot to backfill `thana = "_GLOBAL_THANA_"` on existing rows so the new unique index doesn't collide |
| New `NdrTask` collection | New | Low — parallel to RecoveryTask |
| `FraudSignal` extended fields (device fingerprint, campaign hash) | Additive | Low |
| `Merchant.qualityTier` + `Merchant.lastQualityComputedAt` | Additive | Low |

All schema changes are *additive* except the CourierPerformance compound key. That migration is the only bit that needs a careful one-shot — the model already has a `dropLegacyXxx` pattern in `lib/db.ts:54-82` for boot-time idempotent migrations.

## Scaling implications

- New per-tick worker load: 30-min sweep × 200 orders + weekly per-merchant + event-driven NDR engagement. Adds ~300 jobs/day per merchant at scale → at 1k merchants, ~300k/day total. Within the existing per-queue `removeOnComplete: { count: 1000, age: 24h }` budget.
- Address quality is a pure function — no DB cost.
- Intent score reads `TrackingSession` (already indexed by `(merchantId, anonId, firstSeenAt:-1)`); one cheap read per ingest.
- Thana addition to CourierPerformance: 14 districts × ~10 thanas × 3 couriers × N merchants. At 1k merchants, ~420k rows — fine.
- WhatsApp adapter introduces an external API dep. Reuse the courier circuit-breaker pattern (`apps/api/src/lib/couriers/circuit-breaker.ts`) — 5s wall-time ceiling per call, fast-fail on outage, fall back to SMS.

## Observability requirements

Each layer surfaces metrics on `/admin/system`:
- Layer 1 (Intent): mean intent score, distribution by tier, % of orders with intent ≥ 70.
- Layer 2 (Address): incomplete-address rate, thana coverage %, area-risk-index recency.
- Layer 3 (Commitment): step-2 (WhatsApp) reach rate, step-3 (auto-call) reach rate, time-to-confirm distribution.
- Layer 4 (Courier): mean transit time per (courier, district, thana), failure-kind distribution.
- Layer 5 (NDR): NDR detection latency, recovery rate, recovered revenue.
- Layer 6 (Merchant): tier distribution, suspicious-campaign warnings issued.

All ride on the existing `_counters` infrastructure in `apps/api/src/lib/queue.ts:147-200` — no new observability platform required.

---

# Phase 5 — Prioritization

## Immediate Wins (1–2 weeks) — low risk, high impact

### 1. Wire `orderSync.worker.ts` ★★★
- Three lines in `apps/api/src/index.ts`. Polling fallback for missed Shopify/Woo webhooks is currently dead. Audited as Critical Gap §1 in `MONOREPO_SAAS_MASTER_AUDIT.md`.
- Not RTO-specific but everything else depends on order ingestion being durable.

### 2. Address Quality v1 ★★★
- Pure function `lib/address-intelligence.ts`. Token count + landmark words (Latin + Bangla) + number presence + length floor.
- Output: `Order.address.quality.{score, completeness, missingHints}`.
- Surface as a soft signal in `risk.ts` (no new weight; lift the existing flow).
- **Surface in the dashboard** (single banner: "12 of your 47 pending orders have incomplete addresses") — instant merchant-visible value.

### 3. Intent Score v1 ★★
- Pure function `lib/intent.ts`. Reads `TrackingSession` already stitched in `resolveIdentityForOrder`.
- Stamp `Order.intent.score` at ingest. **Don't yet wire into risk weights** — observe correlation for two weeks first using `FraudPrediction.outcome` as ground truth.
- Surface in agent UI as "Intent: Verified / Implicit / Unverified" badge.

### 4. NDR detection (Layer 5a only) ★★★
- New `ndr-detect` worker.
- Stamp `Order.logistics.ndrAt` on the three signals (failed normalizedStatus, stale out_for_delivery, stale in_transit).
- Create `NdrTask` rows (no engagement workflow yet — just the dashboard surface).
- One `/dashboard/ndr` page with `pending` queue and one-click "I called the buyer" / "Reschedule via courier" / "Mark abandoned" — manual recovery as v1.
- **Even at this stage, the merchant value is real**: today they don't even know their NDRs exist until weeks later.

### 5. Surface campaign × RTO split ★★
- One new tRPC query: `analytics.campaignRtoBreakdown` — joins `TrackingSession.campaign` (via `resolvedOrderId`) with order outcomes.
- One new analytics card. No new collection.
- **Likely highest emotional impact for merchant**: "Your top-RTO source is a Facebook campaign. Here's the data."

### 6. Switch deploy to `build:strict` ★
- Already covered in master audit. Catches type regressions before they ship.

---

## Medium-Term Systems (1–2 months) — foundational intelligence

### 1. WhatsApp Business adapter ★★★
- New `lib/integrations/whatsapp.ts` implementing outbound + inbound webhook.
- Inbound routes through existing `parseSmsInbound`.
- Per-merchant: optional, requires Meta WhatsApp Business account; falls back to SMS-only if absent.
- Unlocks: Layer 3 step 2, Layer 5 step 1, NDR engagement.

### 2. NDR engagement workflow (Layer 5b–c) ★★★
- New `ndr-engagement` worker.
- Step 1 (T+0): Auto-WhatsApp/SMS.
- Step 2 (T+4h): IVR auto-call via Twilio (already a dep).
- Step 3 (T+24h): Surface to merchant call queue with prefilled context.
- Reschedule API for Pathao; manual handoff for the rest.

### 3. Thana granularity (Layer 2b + 4 thana tier) ★★★
- Schema: `Order.customer.thana` (additive).
- Lexicon: 500-thana initial seed (BD divisions), grow from observations.
- Migration: extend `CourierPerformance` compound key to include thana with `_GLOBAL_THANA_` fallback.
- **Compounds with NDR layer**: thana-level retry success rates feed Layer 5d.

### 4. Pre-ship address fix flow ★★
- Detection: Layer 2 already flags incomplete addresses pre-dispatch.
- Action: send buyer a "Please confirm your address — reply with the nearest landmark" SMS/WhatsApp BEFORE booking.
- New automation state: `awaiting_address_confirm` (intermediate between pending and confirmed).

### 5. Intent score wired into risk weights ★★
- After 2-week observation period from immediate-win #3, integrate intent_low_commitment as a `RiskSignal` with conservative weight (start at 12).
- Goes through the existing weight-tuning loop monthly.

### 6. Merchant Operational Quality v1 (Layer 6) ★★
- Weekly worker computes per-merchant tier (Gold/Silver/Bronze/Watch).
- Surface in the merchant analytics page as an honest mirror.
- Not yet surfaced to other merchants; not yet weighted in network contributions.

### 7. Campaign quality scoring ★★
- Per-(merchant, source, medium, name) RTO breakdown — extend immediate-win #5 into a full campaign health card.

---

## Long-Term Moat (6–24 months) — hard-to-copy infrastructure

### 1. Cross-merchant device + campaign fingerprinting ★★★
- Extend `FraudSignal` to track:
  - Device fingerprint hash (already collected on TrackingEvent; needs propagation through identity-resolution).
  - Campaign fingerprint (UTM source/medium/name).
- "This buyer used 14 different devices to place orders at 6 merchants in 30 days" is an unfakeable signal.
- Privacy posture: same hash-only model as `phoneHash`/`addressHash` — store the hash, never the raw value.

### 2. Per-(merchant × category × campaign) RTO model ★★★
- Schema: `Order.items[].category` (optional, populated from upstream where possible).
- Model: `CategoryStats` per (merchantId, category) with delivered/rto/cancelled + p75 order value.
- Tuner: per-cell weights when sample size ≥ 50.
- Compounds: every merchant onboarding adds category-level data.

### 3. Smart retry-slot prediction ★★
- For each NDR, predict optimal next-attempt slot from historical (district, thana, hourBucket, courier) success rates.
- Surfaces as: "Wednesday 10am has 78% success in this thana — schedule next attempt then."

### 4. Network gold-tier propagation ★★
- A buyer with delivered ≥ 5 across the network (not just one merchant) is the highest-trust class. Bypass-soft-signals as today, but with platform-level data.
- Privacy: only the count crosses the boundary; merchants can't see the contributing merchant list.

### 5. Misleading-ad detection (Layer 6 advanced) ★★
- Cross-merchant campaign fingerprint × low-commitment-intent × high-RTO. The same Facebook ad creative driving high-RTO orders at five merchants is the platform's clearest "you have a creative-quality problem" signal.

### 6. Merchant API for partial COD / advance ★
- Schema + payment flow for "Reserve ৳100 by bKash to confirm; remaining ৳1,150 at delivery."
- Fits the existing manual payment infrastructure (`models/payment.ts`); new payment status `partial_received`.
- Strongest commitment lever in the playbook — most BD competitors don't ship it because the manual-payment plumbing isn't there. We have it.

### 7. Embedded receivables advance ★ (covered in MONOREPO audit §15.3)
- Once the order ledger is trusted, advance the merchant 70-80% of COD value at dispatch. Pay back from collected COD over 7-30 days.
- This is where the platform becomes the cheapest financing in the merchant's stack.

---

# Phase 6 — Bangladesh-First Insights

The strategy fails if it's pasted from generic ecommerce theory. Each insight below maps to either an observation from the codebase or to specific BD-market reality the codebase already partially encodes.

## COD psychology in BD

- **COD is not a payment method; it is a trust contract.** The buyer is committing to be physically present, awake, and reachable in 1-3 days, with cash. Every step of friction added pre-dispatch (SMS code, address-landmark ask, "confirm I'll be home" tap) raises the buyer's perceived investment and lowers refusal rate.
- **The 5pm–11pm order is the highest-RTO order.** Late-night impulsive ordering on Facebook ads correlates with morning regret. The codebase has `createdAt` indexed but no time-of-day signal in risk. Cheap to add.
- **Repeat buyers are the asset.** `customerTier: gold` already captures this; the gold-tier bypass for soft signals (`risk.ts:396-402`) is correct. **Network-gold (delivered ≥ 5 across platform) should bypass even more — these are platform power buyers.**
- **Buyer doesn't decide alone.** The household decides — wife, mother-in-law, sons. "I changed my mind" at the door is often "the family said no after I ordered." Layer 3 step 2 (WhatsApp with order summary + cancel-free window) gives the household time to align before shipping.

## Courier ecosystem problems

- **Pathao is fast in Dhaka, slow elsewhere.** Steadfast is the inverse. RedX is the swing vote. Per-district scoring (already in `CourierPerformance`) is necessary but not sufficient — within Dhaka, Pathao Mirpur ≠ Pathao Bashundhara. **Thana granularity is the next ring.**
- **Courier APIs are lossy.** `CourierError.code: "auth_failed" | "network" | "timeout" | "rate_limited" | "invalid_input" | "provider_error"` (`couriers/types.ts:5-14`) — the circuit breaker per (provider, accountId) is correct. The deeper observation: each courier's failure-kind *distribution* is itself a signal. Pathao trending toward `rate_limited` means peak-hour hub stress; Steadfast trending toward `provider_error` means a sandbox/prod config drift.
- **AWB ≠ shipped.** A booked AWB sits in a courier office until the rider picks it up. Today we treat AWB-issued as committed. Reality: ~10% of Bangladesh AWBs sit unscanned > 48h. The `tracking-stuck` worker (Layer 4 #4) catches this.
- **Reschedule is asymmetric.** Pathao rebooks via API. Steadfast rebooks via merchant phone call. RedX is partial. Layer 5c codifies this.

## Address behavior

- **Bangladesh addresses are landmark-relative, not coordinate-relative.** "Behind the green mosque, next to chairman's house, Jasmine Tower 3rd floor" is a *correct* address. Our `hashAddress` token-sort fingerprint loses this signal.
- **Mixed-script addresses are common and harder.** "Road 7, House 4, ধানমন্ডি" mixes Latin and Bangla — couriers interpret unevenly.
- **Many addresses lack road / house numbers.** Rural and semi-urban addresses use landmarks exclusively. Layer 2 must NOT penalize landmark-only addresses; it must reward landmark presence.
- **District spelling drift** is real and already mitigated by `normalizeDistrict` (Bangla aliases included). Same problem repeats at thana level — Mirpur-1, Mirpur 1, mirpur1. Same fix pattern applies.

## Trust patterns

- **The phone number IS the identity.** No buyer logs in to a Cordon-protected store; the COD relationship runs over the phone number. Phone normalization at every seam (already done; `phoneLookupVariants` for join robustness) is foundational.
- **Buyers trust SMS less than WhatsApp.** SSL Wireless SMS is "an automated text from a number I don't know." WhatsApp Business with a profile photo + verified-blue-tick is "the brand I bought from." Layer 3 step 2 is not optional; it's strictly better.
- **The merchant's brand DOES carry to the buyer's confirmation experience.** Already supported via `Merchant.branding.{displayName, logoUrl, primaryColor, supportPhone, supportEmail}` for the public tracking page (`merchant.ts:114-154`). Extend to confirmation SMS / WhatsApp — branded sender masks, branded message templates.

## Fake-order behavior

- **Fake orders are rarely from one buyer; they are from one *competitor*.** Order-bombing is a known BD competitor tactic — flooding a rival's checkout with addresses they'll refuse to deliver, eating shipping cost. Cross-merchant network catches this when the same hashed phone/address fans across competing merchants in 24h. Already partially modeled.
- **Fake orders cluster on creative cycles.** A merchant launches a viral ad → competitors order-bomb that day. Time-of-day + creative-cycle alerting is doable from existing data.

## Refusal behavior

- **"COD refusal" is rarely fraud and usually friction.** Buyer at door: "I changed my mind / my husband says no / I expected something cheaper / I expected today / I don't have cash today." Each cause has a different intervention:
  - "Changed my mind" → pre-ship cancel-free window (Layer 3 social-proof + loss-aversion language).
  - "Family said no" → WhatsApp confirmation includes order summary that the household can see.
  - "Cheaper than I expected" → merchant ad-quality issue (Layer 6 misleading-ad detection).
  - "Expected today" → courier transit transparency on tracking page.
  - "No cash today" → partial-COD/advance flow (Long-term #6).

## Timing behavior

- **Friday is special.** Jumma + family time → low pickup-from-courier success. The `(courier × dayBucket)` extension to CourierPerformance captures this.
- **Pre-Eid spike is bimodal.** Orders surge two weeks pre-Eid; RTOs surge in the post-Eid week as buyers who placed impulsively on credit-running-out evening orders refuse delivery. The platform should pre-warn merchants who have over-extended ad spend in this window.

## WhatsApp / SMS culture

- **WhatsApp is for "real" conversation; SMS is for "system" notifications.** Confirmation prompts should match: ORDER PLACEMENT confirmation can be SMS (system event); RECOVERY conversation should be WhatsApp (human-feeling).
- **Inbound `parseSmsInbound`** handles transliterated Bangla ("ha"/"na"/"han") which is the actual reply pattern of BD users typing in Latin alphabet — strongly correct.
- **Voice notes on WhatsApp** are the highest-trust escalation signal. Out of scope for v1 but worth designing for: "Reply with a voice note saying your address" as a soft commitment ritual.

## Landmark-based delivery reality

- **The rider asks for the landmark on arrival anyway.** "Where is the green mosque?" is the actual delivery dialogue. We can short-cut this by including the landmark in the AWB notes pre-emptively when the buyer provides one.
- **Landmark drift over time.** "The new market" was new in 2018. Some addresses still reference it. Address fingerprint normalization should be lenient on landmark age — token-sort + landmark-presence is fine; trying to canonicalize "new market" → "Mirpur Section 7" is over-engineering.

---

# Closing — The product becomes

> Cordon is the **operations layer between Bangladesh storefronts and Bangladesh couriers**, with a privacy-preserving cross-merchant outcome graph that compounds with every merchant onboarded.
>
> "Fraud detection" is one of six layers. The product **outcome we sell is RTO reduction**.
> The product **moat we accumulate is the labeled outcome graph** — which neither Shopify, nor any single courier, nor any single merchant, can replicate from their vantage point.

The current architecture is unusually well-positioned for this pivot. Most of the inputs are already collected, indexed, and stored — they simply haven't been joined to the RTO outcome yet. The strategy above is engineering, not invention.

### Next concrete artefact
1. Implement Immediate Wins #1–#5 (2-week sprint).
2. Pick one merchant cohort (10 design partners) for **Layer 5 (NDR Recovery) v1 manual flow** — measure recovery rate manually for 30 days. The data captured during that 30 days is what trains v2 automation.
3. Run the WhatsApp Business adapter in parallel — Meta's approval timeline is 1–4 weeks, so start the clock.

Everything else compounds from there.

---

**End of masterplan.**

*Every claim in this document maps to a specific path:line in the current monorepo or to a marked extension point. No fantasy systems were invented — every "new" component is an additive extension of existing infrastructure. The dead-worker observation (`orderSync`) and the pre-existing strengths (idempotency durability, audit hash chain, courier circuit breaker, fraud network privacy posture) carry forward from the master audit.*
