# RTO_ENGINE_EXECUTION_ROADMAP.md

**Repository:** `C:\devs\ecommerce-logistics` (Cordon)
**Milestone:** First operational layer of the RTO Prevention Engine
**Scope:** **Intent Intelligence v1**, **Address Intelligence v1**, **NDR Recovery Engine v1**
**Constraints:** additive only, reuse existing queues/workers, preserve replay durability and webhook integrity, no AI black-boxes — every signal explainable to the merchant.

This roadmap is execution-grade. Every change references a real path in the monorepo. No system is invented from scratch where an existing one can be extended.

---

# Phase 1 — Audit of the Systems We Will Touch

Each subsection below is a precise, verified picture of what exists today and where it ends. The boundary is what we extend; everything else is left alone.

## 1.1 TrackingSession lifecycle (Intent's data source)

**Source:** `apps/api/src/server/tracking/collector.ts` — public `/track` endpoint, hardened with rate limit / HMAC / spike flagging / concurrency cap (`apps/api/src/lib/tracking-guard.ts`).

**Lifecycle:**
1. Storefront SDK posts batched events (max 50 per batch) to `/track`.
2. Collector validates, deduplicates by `(merchantId, sessionId, clientEventId)` (partial unique index — `models/trackingEvent.ts:86-96`), persists `TrackingEvent` rows.
3. `upsertSessionAggregates` rolls events into `TrackingSession` (one row per `(merchantId, sessionId)` — unique, `models/trackingSession.ts:74`). Session counters: `pageViews`, `productViews`, `addToCartCount`, `checkoutStartCount`, `checkoutSubmitCount`, `clickCount`, `maxScrollDepth`, `firstSeenAt`, `lastSeenAt`, `durationMs`, `repeatVisitor`, `abandonedCart`, `converted`, `landingPath`, `referrer`, `campaign.{source,medium,name}`.
4. On `checkout_submit` (or explicit `identify()`), the session captures `phone` / `email` / `customerHash`.
5. **Identity resolution at order ingest** (`apps/api/src/server/ingest.ts:924-997`) sets `TrackingSession.resolvedOrderId` for every session matching the order's phone variants or email within a 30-day window. **This is the join we will read for Intent Intelligence — it already exists.**

**What we DON'T touch:** the collector hardening, the partial-unique idempotency keys, the `MAX_BATCH=50` ceiling, the per-merchant tracking secret + strict-HMAC toggle.

## 1.2 Courier tracking lifecycle (NDR's data source)

**Sources:**
- Polling: `apps/api/src/workers/trackingSync.ts` (every `TRACKING_SYNC_INTERVAL_MIN`, default 60). Picks orders to sync via `pickOrdersToSync`, calls courier adapters, writes events via `applyTrackingEvents`.
- Push: `apps/api/src/server/webhooks/courier.ts` — `/api/webhooks/courier/:provider/:merchantId` for Steadfast / Pathao / RedX. Synthesizes idempotency externalId from `(trackingCode, status, timestamp)` hash. Routes through the same `applyTrackingEvents`.

**`applyTrackingEvents`** (`apps/api/src/server/tracking.ts:24-76`):
- Maps provider statuses to `normalizedStatus` enum: `pending | picked_up | in_transit | out_for_delivery | delivered | failed | rto | unknown`.
- Mutates `Order.order.status` only on terminal transitions: `delivered → "delivered"`, `failed/rto → "rto"`.
- Stamps `logistics.shippedAt`, `deliveredAt`, `returnedAt`, `lastWebhookAt`, `lastPolledAt`.
- Returns `{ newEvents, statusTransition }` so callers can react to transitions.
- Already calls `recordCourierOutcome` (CourierPerformance) and `contributeOutcome` (cross-merchant fraud network) on terminal states.
- Already enqueues `riskRecompute` on `rto` to fan-out rescoring of the buyer's other orders.

**This is the seam we tap for NDR detection.** We need to react to additional patterns (`failed` event without recovery, stale `out_for_delivery`, stuck `in_transit`) — without altering `applyTrackingEvents` itself. The detection moves to a separate periodic worker that reads `Order.logistics.trackingEvents`.

## 1.3 Failed-delivery events today

The single most important fact: **`failed` events ARE captured but never trigger any merchant-visible recovery workflow.**

- `STATUS_MAP.failed = "rto"` in `apps/api/src/server/tracking.ts:30` — meaning a `failed` event flips order status straight to `rto`. This is operationally too aggressive for BD: most failed-delivery events are recoverable on second attempt with one phone call.
- `Order.logistics.trackingEvents[]` retains the `failed` event (with description / location).
- `riskRecompute` fans out across the buyer's other orders.
- **No NdrTask is created. No buyer is contacted. No reschedule is proposed.**

We will NOT change `STATUS_MAP` (every BD courier signals "failed" with very different intent — a rider's "couldn't deliver, will retry tomorrow" looks the same as "buyer refused"). The fix is to **detect the recovery opportunity from the trackingEvents history before the order status fully commits to `rto`** — this is the NDR engine's responsibility.

## 1.4 Notification system

**Source:** `apps/api/src/lib/notifications.ts` — `dispatchNotification({ merchantId, kind, severity, title, body, link, subjectType, subjectId, meta, dedupeKey, skipSms })`.

- In-app row in `Notification` collection (`models/notification.ts`).
- Severity-tiered: critical optionally fans out to SMS via `sendCriticalAlertSms`.
- Per-`dedupeKey` collapse so a stuck order can't spam.
- Reused by every layer (queue failures, fraud alerts, webhook dead-letters, plan downgrades).

**Reuse for NDR:** new notification kinds — `ndr.detected`, `ndr.recovered`, `ndr.unreachable`. Adds two enum entries; no new infrastructure.

## 1.5 SMS infrastructure

**Source:** `apps/api/src/lib/sms/index.ts` + `sslwireless.ts` (BD provider).

- Outbound helpers: `sendOtpSms`, `sendOrderConfirmationSms`, `sendCriticalAlertSms`, `sendPasswordResetAlertSms`. 160-char clamp; loud truncation warning.
- Inbound parsing: `apps/api/src/lib/sms-inbound.ts:22-75` — provider-agnostic, handles YES/NO/Bangla "ha"/"na" + 6-or-8-digit code. Designed to plug WhatsApp into.
- DLR webhook: `apps/api/src/server/webhooks/sms-dlr.ts` flips `automation.confirmationDeliveryStatus` to delivered/failed/unknown.
- Outbound retry-with-backoff already wired by `automationSms` worker (`workers/automationSms.ts`, attempts:5, exponential 15s).

**Reuse for NDR:** add ONE more outbound helper (`sendNdrRecoveryPromptSms`) that mirrors the order-confirmation template shape. Inbound replies will route through `parseSmsInbound` with a new intent token (`READY <code>` for "I'm ready for the next attempt"). No protocol change.

## 1.6 Queues / workers available

Inventoried in `MONOREPO_SAAS_MASTER_AUDIT.md` §6. Relevant ones for this milestone:
- `webhook-process` — event-driven, concurrency 8.
- `webhook-retry` — every 60s, batch 50.
- `automation-sms` — event-driven; existing `AutoSmsJobData` shape is reusable.
- `automation-stale` — hourly sweep pattern (precise mirror for NDR detect).
- `tracking-sync` — every 60m.
- `risk-recompute` — event-driven fan-out.
- `pending-job-replay` — every 30s; covers any new queue we add.
- `safeEnqueue` — every new enqueue MUST go through this for fairness + dead-letter durability (`apps/api/src/lib/queue.ts:328-390`).

**No new queue infrastructure is needed.** We add one new queue name + worker pair (`ndr-detect` + `ndr-engagement`) and one event-driven enqueue path. Both register in `apps/api/src/index.ts` alongside existing workers.

## 1.7 Merchant-facing order states

`Order.order.status`: `pending | confirmed | packed | shipped | in_transit | delivered | cancelled | rto` (`models/order.ts:5-14`).
`Order.automation.state`: `not_evaluated | auto_confirmed | pending_confirmation | confirmed | rejected | requires_review`.
`Order.fraud.reviewStatus`: `not_required | optional_review | pending_call | verified | rejected | no_answer`.

**We add NO new top-level status.** NDR is observable from existing states + a new sub-doc:
- `Order.logistics.ndrAt` (Date | undefined) — first NDR detection.
- `Order.logistics.ndrAttempts` (Number) — how many recovery attempts so far.
- `Order.logistics.ndrLastSignal` (string) — which signal fired (`failed_event`, `stale_in_transit`, `stale_out_for_delivery`).

Plus an additive `NdrTask` collection (parallel to `RecoveryTask`) for the operator queue.

## 1.8 Fraud review flows

Untouched. Intent score does NOT modify `fraud.reviewStatus` in v1 — it adds a parallel `Order.intent.{score, signals[]}` subdoc surfaced beside the fraud panel. Operators see both, the engine doesn't merge them yet.

## 1.9 Replay / recovery interactions (the safety constraints)

Three guarantees that the new layer MUST preserve:

1. **WebhookInbox idempotency** — keys live forever (`models/webhookInbox.ts:13-45`). No new TTL anywhere.
2. **`safeEnqueue` dead-letter durability** — every new enqueue must go through it; `PendingJob` replay sweeper covers our new queues automatically once we register them in `QUEUE_NAMES`.
3. **Order optimistic concurrency** — every Order mutation we add MUST use `updateOrderWithVersion` from `apps/api/src/lib/orderConcurrency.ts:71`. Two helpers: `updateOrderWithVersion` for one-shot CAS; `runWithOptimisticRetry` for read-modify-write loops.

## 1.10 Dangerous coupling risks (mapped, then avoided)

| Risk | Why dangerous | Mitigation |
|---|---|---|
| Mutating `STATUS_MAP` for `failed` events | Every courier adapter and every test asserts current behavior; would alter terminal-state semantics across the platform | Detect NDR from `trackingEvents` history, NOT by changing the status mapping |
| Inlining intent score into `computeRisk` | Invalidates `FraudPrediction` weight-tuner labels (frozen `weightsVersion` snapshots) | Add `Order.intent` as a parallel subdoc; observe correlation against `FraudPrediction.outcome` for 14 days BEFORE wiring into a `RiskSignal` |
| Adding fields to `Order.fraud` or `Order.automation` subdocs | Mongoose strict-mode + dot-notation has a known quirk on `_id: false` enum-constrained subdocs (`models/order.ts:184-202`) | New top-level subdocs (`Order.intent`, `Order.address.quality`); never touch `fraud` or `automation` schema enums |
| Re-using `RecoveryTask` for NDR | Different lifecycle, different SLAs, different escalation; conflating them clobbers existing dashboard semantics | Parallel collection `NdrTask` modeled on RecoveryTask's pattern (same indexes, same router shape) |
| Touching the BullMQ queue-init boot order | Workers must register BEFORE schedules; the `apps/api/CLAUDE.md` worker checklist exists for a reason | Add new worker calls to `apps/api/src/index.ts:139-173` in the same pattern as the existing 14 workers |
| Re-running `applyTrackingEvents` from the NDR worker | Could double-record courier outcomes / fraud-network contributions | NDR detect READS only; does not invoke `applyTrackingEvents` |
| Touching the audit chain | `selfHash` / `prevHash` chain serializes through a process-local cache (`apps/api/src/lib/audit.ts:212-236`); concurrent inserts are safe; deletes/updates throw | Only call `writeAudit({ action: "ndr.*", … })` after extending the AUDIT_ACTIONS enum |
| Forgetting to register a new worker | Verified gap exists today — `orderSync.worker.ts` defined, never registered (covered in `MONOREPO_SAAS_MASTER_AUDIT.md` §2). Same trap for any new worker | This roadmap explicitly lists each `register*()` call site (Phase 4). |

---

# Phase 2 — Minimal Viable RTO Engine (additive design)

## A. Intent Intelligence v1

### Inputs (already collected, already indexed)

All read from `TrackingSession` rows whose `resolvedOrderId === order._id` after `resolveIdentityForOrder` runs at ingest. Read pattern:

```ts
const sessions = await TrackingSession.find({
  merchantId: order.merchantId,
  resolvedOrderId: order._id,
}).lean();
```

Index in use: `(merchantId, sessionId)` unique; supplemented by an additive index `{ merchantId: 1, resolvedOrderId: 1 }` (sparse-partial — only sessions that actually resolved). New index — additive, low-risk.

### Score composition (`computeIntentScore`)

Pure function in a new file `apps/api/src/lib/intent.ts`. Inputs: `TrackingSession[]` for this order (usually 1, sometimes 2-3 if the buyer revisited). Output:

```ts
export interface IntentResult {
  score: number;           // 0-100
  tier: "verified" | "implicit" | "unverified" | "no_data";
  signals: IntentSignal[]; // explainable contributions
  computedAt: Date;
}

export interface IntentSignal {
  key:
    | "repeat_visitor"            // session.repeatVisitor === true
    | "deep_engagement"           // productViews >= 3 OR scroll >= 50
    | "long_dwell"                // durationMs >= 60_000
    | "funnel_completion"         // checkoutSubmit / checkoutStart >= 0.5
    | "organic_landing"           // landing was direct/organic, not paid social
    | "multi_session_converter"   // anonId observed across days before order
    | "confirmation_replied"      // SMS reply with code landed
    | "fast_confirmation"         // reply within 1h
    | "no_session_data";          // catch-all for orders we never saw on the storefront
  weight: number;                 // contribution to score
  detail: string;                 // human-readable; surfaced verbatim to merchant
}
```

### Tier mapping (so merchants don't need to read scores)

| Score | Tier | Display |
|---|---|---|
| ≥ 70 | **Verified** | "This buyer engaged with your store and confirmed the order." |
| 40–69 | **Implicit** | "This buyer placed the order with limited engagement signals." |
| 0–39 OR replied NO | **Unverified** | "This buyer did not engage with your store before checkout." |
| no session matched | **no_data** | "We didn't see this buyer on your storefront — likely placed via dashboard, CSV, or SDK not yet installed." |

### Why no_data is a tier, not a score
A merchant who imports orders from CSV won't have any session data. We don't penalise them — we say so. If/when the merchant installs the storefront SDK, the same orders' future siblings score normally.

### Observation-only window
Intent score is **stamped** at ingest and **observed against `FraudPrediction.outcome`** for 14 days. After that, if the correlation holds (we expect intent-tier `verified` to have ~half the RTO rate of `unverified`), Phase 6 wires it into `computeRisk` as a `RiskSignal`. NOT before.

### Schema impact

Additive — new subdoc on Order:

```ts
intent: {
  score: Number,            // 0-100
  tier: String enum["verified","implicit","unverified","no_data"],
  signals: [{ key, weight, detail }],
  computedAt: Date,
}
```

Plus the additive index on TrackingSession: `{ merchantId: 1, resolvedOrderId: 1 }` (sparse partial, only when `resolvedOrderId` exists).

### When it runs

In `ingestNormalizedOrder` (`apps/api/src/server/ingest.ts:316-321`), right after the `resolveIdentityForOrder` fire-and-forget. We **chain it after** the identity resolution because the join requires `resolvedOrderId` to be set:

```ts
// After: void resolveIdentityForOrder(...)
// New: void scoreIntentForOrder(...)  // also fire-and-forget
```

Failure to compute intent must NEVER block order creation. Pattern matches `resolveIdentityForOrder` exactly.

---

## B. Address Intelligence v1

### Schema impact

Additive — new subdoc on Order:

```ts
address: {
  quality: {
    score: Number,                    // 0-100
    completeness: String enum["complete","partial","incomplete"],
    landmarks: [String],              // detected landmark tokens
    hasNumber: Boolean,
    tokenCount: Number,
    scriptMix: String enum["latin","bangla","mixed"],
    missingHints: [String],           // human-readable: "no landmark detected"
    computedAt: Date,
  }
}
```

`Order.customer.thana` (additive, optional, sparse-indexed):

```ts
customer.thana: { type: String, trim: true, maxlength: 100, index: true }
```

### Pure function `lib/address-intelligence.ts`

Takes `(address: string, district?: string)`, returns the subdoc above.

#### Landmark lexicon (Bangladesh-first, Latin + Bangla)

```ts
const LANDMARK_TOKENS = {
  road: ["road", "rd", "lane", "street", "st", "avenue",
         "রোড", "সড়ক", "লেন"],
  house: ["house", "h#", "h/", "flat", "apt", "apartment", "tower",
          "বাড়ি", "ফ্ল্যাট", "টাওয়ার"],
  block: ["block", "sector", "section",
          "ব্লক", "সেক্টর"],
  worship: ["mosque", "masjid", "mandir", "temple", "church",
            "মসজিদ", "মন্দির"],
  education: ["school", "college", "university", "madrasa", "madrassa",
              "স্কুল", "কলেজ", "মাদ্রাসা", "বিশ্ববিদ্যালয়"],
  market: ["bazar", "bazaar", "market", "mall", "plaza",
           "বাজার", "মার্কেট"],
  health: ["hospital", "clinic", "medical",
           "হাসপাতাল", "ক্লিনিক"],
  intersection: ["more", "morh", "circle", "chowrasta", "junction",
                 "মোড়", "চৌরাস্তা"],
  transport: ["station", "bus stand", "bus stop", "bridge", "pump",
              "স্টেশন", "ব্রিজ", "পাম্প"],
  authority: ["chairman", "thana", "union", "upazila", "ward",
              "চেয়ারম্যান", "থানা", "ইউনিয়ন", "উপজেলা"],
};
```

#### Scoring rules (transparent, no ML)

```
base = 50
+ token_count >= 5         → +10  ("address has enough detail")
+ token_count >= 8         → +5   ("address is detailed")
+ has_number               → +10  ("includes road/house number")
+ landmark in any category → +10  ("references a landmark — riders use these")
+ landmark in 2+ categories→ +5   ("multi-landmark — easy to find")
+ district matches lexicon → +5   ("district recognized")
+ thana extracted          → +5   ("thana identified")
- mixed-script penalty     → -5   ("mixed Latin+Bangla — courier interpretation varies")
- length < 15 chars        → -20  (incomplete)
- token_count < 3          → -25  (incomplete)
- no landmark + no number  → -10  ("rider has no anchor point")
clamp [0, 100]
```

Tier mapping:
- **complete**: score ≥ 70 AND token_count ≥ 5 AND (has_number OR landmark)
- **partial**: 40 ≤ score < 70
- **incomplete**: < 40

`missingHints` is computed last — translates the negative deductions into actionable copy:
- `no_landmark`: "Ask the buyer for a nearby landmark (mosque, bazar, school)."
- `no_number`: "No road or house number — request one before dispatch."
- `too_short`: "Address is too short to deliver reliably."
- `mixed_script`: "Address mixes Bangla and English — couriers interpret unevenly."
- `no_thana`: "Couldn't extract a thana — delivery zone may be ambiguous."

### Thana extraction

Lexicon-based — a 500-thana seed list per BD division. Algorithm:
1. Tokenize the address.
2. Find any token (or 2-token bigram) that matches the thana lexicon (case-insensitive, accent-insensitive for Bangla).
3. If multiple matches, prefer the one that co-occurs with the order's `district` (e.g. "Mirpur" alongside `district = dhaka` is the Mirpur in Dhaka).
4. On ambiguity, leave `thana` unset — the address-quality score still surfaces a `no_thana` hint.

Lexicon stored as a frozen object in `apps/api/src/lib/thana-lexicon.ts`. Extending the lexicon is a code change (not a DB migration) — keeps it under code review.

### When it runs

Pure function — called inline at ingest, same site as intent (`apps/api/src/server/ingest.ts`):

```ts
const addressQuality = computeAddressQuality(
  normalized.customer.address,
  normalized.customer.district,
);
const thana = extractThana(
  normalized.customer.address,
  normalized.customer.district,
);
// stamp into the Order.create call:
//   address: { quality: addressQuality }
//   customer: { ..., thana }
```

No worker, no queue, no DB read — just a pure function. Adds < 1 ms to ingest.

### Migration

Existing orders have no `address.quality` subdoc and no `customer.thana`. Both are optional — we do NOT backfill historical orders. New orders score normally; the dashboard surfaces "address quality" for new orders only. A separate one-shot script (`apps/api/src/scripts/backfillAddressQuality.ts`) is OPTIONAL — only worth running once we want historical analytics over the field.

---

## C. NDR Recovery Engine v1

### Detection signals (all derived from existing data)

| Signal | Detection | Window |
|---|---|---|
| **explicit_failed** | A `trackingEvents[].normalizedStatus === "failed"` event exists AND no later `delivered` event | trigger immediately on the failed event |
| **stale_out_for_delivery** | The most recent event is `out_for_delivery` AND it's older than 24h with no follow-up | trigger 24h after the OFD event |
| **stale_in_transit** | The most recent event is `picked_up` or `in_transit` AND it's older than P75 of (courier × district) `totalDeliveryHours / deliveredCount` × 1.5 | trigger after the threshold |

Note: `STATUS_MAP.failed = "rto"` will still fire — the order still flips to `rto` status. We are NOT overriding that. We are using the failed event as an NDR-detection signal that runs IN PARALLEL with the existing tracking pipeline.

### Why this is safe

- Detection only READS `Order.logistics.trackingEvents`. No write to existing fields.
- Writes happen only on `Order.logistics.ndrAt/ndrAttempts/ndrLastSignal` (new fields) and on the new `NdrTask` collection.
- Even if NDR detection silently fails, every existing flow (status flip, `riskRecompute`, courier-performance recording) keeps working.

### `NdrTask` collection (new, parallel to `RecoveryTask`)

```ts
NdrTask {
  merchantId: ObjectId, indexed
  orderId: ObjectId,    indexed
  kind: enum["explicit_failed", "stale_out_for_delivery", "stale_in_transit"]
  firstDetectedAt: Date
  lastSignalAt: Date
  status: enum["pending","engaging","awaiting_buyer","rescheduled","recovered","abandoned"]
  attempts: Number
  lastAttemptAt?: Date
  nextActionAt?: Date    // when the engagement worker should fire next step
  channelLast?: enum["sms","whatsapp","ivr","agent"]
  buyerReplyAt?: Date
  rescheduleSlot?: Date
  resolution?: enum["delivered","cancelled","abandoned","manual"]
  notes?: String
}
```

Indexes:
- `(merchantId, orderId)` — unique, idempotency.
- `(merchantId, status, firstDetectedAt: -1)` — dashboard queue.
- `(status, nextActionAt: 1)` — engagement worker pickup, partial filter on `status === "engaging" || "awaiting_buyer"`.

### Communication ladder (v1 — SMS only; WhatsApp is the medium-term step)

```
T+0      Send SMS: "Your parcel from <merchant> couldn't be delivered.
                   Reply READY <code> when you'd like the next attempt,
                   or CANCEL <code> to cancel."
                   (uses existing SMS infra; new helper sendNdrRecoveryPromptSms)

T+4h     If no reply: surface NdrTask in merchant queue with status=awaiting_buyer
         (no auto-call yet — that's WhatsApp + IVR work, medium-term)

T+24h    If no reply: notification to merchant ("3 NDR tasks awaiting your call"),
         status=awaiting_buyer remains, attempts++

T+72h    Auto-mark abandoned IF merchant hasn't intervened.
         Notification to merchant.
```

The `parseSmsInbound` helper (`apps/api/src/lib/sms-inbound.ts:22-75`) needs ONE small extension: a third intent token `ready` mapped to `kind: "ready"`:

```ts
const READY_TOKENS = new Set(["ready", "r", "redeliver", "yes", "ha", "han", "1"]);
```

Reuses the same 6-or-8 digit code regex; same lookup pattern. The inbound webhook handler routes `kind: "ready"` to a new function `applyReadyIntent(code)` that flips the matching NdrTask to `status: "rescheduled"` and notifies the merchant.

### Reschedule API (per courier)

In v1 the system does NOT call courier reschedule APIs automatically. Reasons:
- Pathao supports it via API; Steadfast does not (manual phone call to courier); RedX is partial.
- Adding the auto-reschedule path requires courier-specific adapter work and per-merchant validation.

Instead, v1 surfaces reschedule as a merchant decision: the dashboard NDR card has buttons:
- "Buyer ready — reschedule via courier" → opens a copy-paste-able courier action card with the AWB number, buyer's reply, requested slot.
- "Cancel order" → existing reject path.
- "Mark abandoned" → terminal state.

This keeps the engagement loop working today while leaving auto-reschedule for medium-term work.

### Merchant escalation

- T+24h notification (`dispatchNotification({ kind: "ndr.unreachable", severity: "warning" })`).
- T+72h notification (`dispatchNotification({ kind: "ndr.abandoned", severity: "warning" })`).
- Critical-only path: NDR rate per merchant exceeds 2× their 30-day baseline → admin alert (reuses the existing anomaly engine pattern in `apps/api/src/lib/anomaly.ts`). Out of v1 scope; flagged for post-launch.

---

# Phase 3 — Operational UX

## Principle
Three surfaces, each scoped to one decision. **No new top-level dashboard.** All extensions to existing pages.

### A. NDR Queue page (new)
Path: `/dashboard/ndr` — modeled on the existing `/dashboard/recovery` page (per `apps/web/src/app/dashboard/recovery/page.tsx` pattern).

**Shows:** open NdrTasks, sorted by `firstDetectedAt desc`, filtered by status.

**Per row:**
- Order id + brand display
- Buyer phone (masked, click-to-reveal as the recovery page does today)
- Courier + tracking number
- Trigger reason ("Pathao reported failed delivery 2h ago")
- Buyer reply state ("No reply yet" / "Replied READY 14:32")
- Action buttons: Reschedule via courier · Cancel · Mark abandoned · Add note

**Navigation:** new sidebar entry "NDR" with a count badge (count of pending+engaging tasks). Sidebar lives in `apps/web/src/components/sidebar/Sidebar.tsx`.

**Empty state:** "No NDR tasks. Couriers are delivering cleanly." — never `null` rendering.

### B. Order Detail panel — Intent + Address (extension)
Path: existing `/dashboard/orders` order-detail drawer.

**New panel "Buyer Intent"**:
- Tier badge: Verified / Implicit / Unverified / No Data.
- One-sentence explanation (from `IntentResult.signals[]`).
- "Why?" expander showing the 3-5 signals with detail strings. **Every contribution is human-readable**; nothing surfaces as a bare weight.

**New panel "Address Quality"**:
- Tier badge: Complete / Partial / Incomplete.
- Detected landmarks chip list ("Mosque", "Tower", "Road #").
- `missingHints[]` rendered as actionable copy with a "Send buyer SMS for address" CTA when `missingHints` non-empty (button enqueues an SMS asking for the missing hint — reuses the SMS pipeline, no new infra).

### C. Analytics — Address quality cohort (extension)
Path: existing `/dashboard/analytics`.

One new card: "Address Quality vs RTO" — bar chart with three cohorts (complete / partial / incomplete) and the 90-day RTO rate per cohort. Reads from `FraudPrediction.outcome` joined to `Order.address.quality.completeness`.

### Anti-pattern guardrails

- **No "AI" language.** Every signal label is a fact — "Buyer scrolled deep on product page" not "Our AI determined high commitment."
- **No prediction percentages.** Tiers, not probabilities. "Verified" is a category; we already expose `pRto%` for those who want a number — we don't add another.
- **No alert flood.** All NDR notifications use `dedupeKey: "ndr_<status>:<orderId>"` so a single task fires one in-app row per status transition.
- **No sidebar acronym soup.** "NDR" with a tooltip "Non-delivery reports — orders that need merchant follow-up."

---

# Phase 4 — Execution Plan

## 4.1 Schema changes (all additive)

| Change | File | Risk |
|---|---|---|
| `Order.intent` subdoc | `packages/db/src/models/order.ts` | None (additive) |
| `Order.address.quality` subdoc | same | None (additive) |
| `Order.customer.thana` field | same | None (additive sparse-indexed) |
| `Order.logistics.ndrAt/ndrAttempts/ndrLastSignal` fields | same | None (additive) |
| New `NdrTask` collection | new file `packages/db/src/models/ndrTask.ts` | None |
| Index `TrackingSession.{merchantId:1, resolvedOrderId:1}` partial-sparse | `models/trackingSession.ts` | Low — index build runs in background via the existing boot syncIndexes pattern (`apps/api/src/index.ts:113-135`) |
| Index `NdrTask.{merchantId, orderId}` unique + queue indexes | new model | None |
| `AUDIT_ACTIONS` enum: `ndr.detected`, `ndr.engagement_sent`, `ndr.buyer_replied`, `ndr.rescheduled`, `ndr.recovered`, `ndr.abandoned` | `packages/db/src/models/auditLog.ts` + `apps/api/src/lib/audit.ts` | Low — enum extension matches existing pattern |
| `NOTIFICATION_KINDS` enum: `ndr.detected`, `ndr.unreachable`, `ndr.abandoned`, `ndr.recovered` | `packages/db/src/models/notification.ts` | Low — enum extension |

## 4.2 Queue / worker additions

| Queue name | Worker file | Cadence | Concurrency | Registration site |
|---|---|---|---|---|
| `ndr-detect` | `apps/api/src/workers/ndrDetect.ts` | every 30 min (sweep) | 1 | `apps/api/src/index.ts` alongside existing |
| `ndr-engagement` | `apps/api/src/workers/ndrEngagement.ts` | event-driven (jobs enqueued by detect) | 4 | same |

Add to `QUEUE_NAMES` in `apps/api/src/lib/queue.ts:11-32`:

```ts
ndrDetect: "ndr-detect",
ndrEngagement: "ndr-engagement",
```

Both queues automatically participate in:
- `safeEnqueue` per-merchant token bucket fairness.
- `PendingJob` dead-letter replay if Redis is down at enqueue time.
- The existing wait-time observability at the BullMQ Worker `active` event.

## 4.3 Worker boot wiring (CRITICAL — do not skip)

In `apps/api/src/index.ts` between lines 152-156 (alongside existing register calls):

```ts
registerNdrDetectWorker();
registerNdrEngagementWorker();
```

And after `await scheduleAwbReconcile();`:

```ts
await scheduleNdrDetect();
```

> **Reminder:** the audit (`MONOREPO_SAAS_MASTER_AUDIT.md` §2) flagged that `orderSync.worker.ts` exists but is never registered — that worker is currently dead in production. The exact same trap waits for any new worker. Both new workers above MUST land in `index.ts` in the same change as the worker files themselves. Confirm by grepping for `registerNdrDetectWorker` and `registerNdrEngagementWorker` after the change — the file count must be ≥ 2 (definition + registration) for each.

## 4.4 Code structure

```
apps/api/src/
  lib/
    intent.ts                    NEW — pure function computeIntentScore
    address-intelligence.ts      NEW — pure function computeAddressQuality
    thana-lexicon.ts             NEW — frozen 500-thana seed
    ndr/
      detection.ts               NEW — pure function classifyNdrSignal
      engagement.ts              NEW — orchestrates ladder transitions
      sms-templates.ts           NEW — sendNdrRecoveryPromptSms helpers
  workers/
    ndrDetect.ts                 NEW — sweeps Order, creates NdrTask
    ndrEngagement.ts             NEW — drains NdrTask state machine
  server/
    ingest.ts                    EDIT — call computeAddressQuality + scoreIntentForOrder fire-and-forget
    routers/
      ndr.ts                     NEW — list/update/note tRPC procedures
      orders.ts                  EDIT — surface intent + addressQuality on get/list responses
      analytics.ts               EDIT — addressQualityCohortRto query
      index.ts                   EDIT — register ndrRouter
    webhooks/
      sms-inbound.ts             EDIT — handle "READY" intent → flip NdrTask
packages/db/src/models/
  order.ts                       EDIT — add intent + address.quality + customer.thana + logistics.ndr*
  ndrTask.ts                     NEW
  auditLog.ts                    EDIT — add ndr.* actions
  notification.ts                EDIT — add ndr.* kinds
apps/web/src/
  app/dashboard/
    ndr/page.tsx                 NEW
    orders/[id]/(panels)/intent.tsx        NEW (or inline in detail drawer)
    orders/[id]/(panels)/address-quality.tsx  NEW
    analytics/(cards)/address-quality.tsx  NEW
  components/sidebar/Sidebar.tsx EDIT — add NDR entry
```

## 4.5 Engineering complexity (rough estimates)

| Component | Complexity | Effort |
|---|---|---|
| `computeAddressQuality` + thana lexicon | Low (pure function, lots of test data) | 1.5 days |
| `computeIntentScore` + signal explanations | Low (pure function, single TrackingSession read) | 1 day |
| Schema additions + index migrations | Low | 0.5 day |
| `NdrTask` model + indexes | Low | 0.5 day |
| `ndrDetect` worker | Medium (multi-signal classification, courier-perf P75 lookup) | 2 days |
| `ndrEngagement` worker + state machine | Medium (timer-driven transitions; uses `nextActionAt` like `webhook-retry`) | 2 days |
| SMS templates + inbound parser extension | Low | 1 day |
| `ndr` tRPC router | Low (mirrors `recovery.ts`) | 1 day |
| `orders` router patches (intent + address) | Low | 0.5 day |
| Analytics cohort card | Low | 0.5 day |
| `/dashboard/ndr` page | Medium | 2 days |
| Order-detail panels | Low | 1 day |
| Sidebar entry + i18n | Low | 0.25 day |
| Tests (vitest + 1 playwright e2e) | Medium | 2 days |
| **Total** | | **~15.75 dev-days = ~3 weeks for one engineer** |

## 4.6 Operational impact

- **Order ingest path adds < 2ms** (intent score reads 1-3 TrackingSession rows; address quality is in-memory).
- **`ndr-detect` sweep** costs one indexed Order scan every 30 min. Index used: `(merchantId, order.status, createdAt:-1)` — already exists. Bound: orders in `in_transit`/`shipped` status with `logistics.ndrAt` unset, batch 200. At 1k merchants × 100 active shipments = 100k candidate rows scanned every 30 min — well within Mongo's working set for an indexed sweep.
- **`ndr-engagement` outbound** costs 1 SMS per detected NDR. SSL Wireless billing is per segment; templates fit in one segment.
- **Storage**: `NdrTask` ~300 bytes × NDR rate. At 18% RTO baseline, expect ~5-10% of orders to enter NDR (not all RTOs are NDR — some refuse on first attempt). At 1k merchants × 1k orders/month × 8% = 80k NdrTasks/month × 300B = ~25MB/month. Negligible.

## 4.7 Regression risk

| Path | Risk | Mitigation |
|---|---|---|
| Order ingest | Low — both new functions are fire-and-forget; ingest cannot fail because of them | `void scoreIntent(...).catch(log)` pattern matches the existing `resolveIdentityForOrder` |
| Tracking lifecycle | None — NDR detect READS only | No edits to `applyTrackingEvents` |
| Webhook delivery | None | No edits to webhook receivers |
| Audit chain | Low — adding enum entries; chain hash-canonicalization is field-name-agnostic | Tests in existing `audit-funnel.test.ts` validate enum extensions |
| Existing risk-scoring | None in v1 | Intent is parallel; not wired into `RiskSignal[]` until Phase 6 (post-observation) |
| Existing recovery flow | None | NdrTask is a parallel collection; RecoveryTask untouched |
| Index build at boot | Low | New indexes run inside the existing fire-and-forget `syncIndexes` block (`index.ts:113-135`); production tolerates background rebuilds |

## 4.8 Rollout order (single deployment to staging, then prod)

1. **Day 1:** schema additions (Order subdocs, NdrTask model, AUDIT/NOTIFICATION enum extensions) + pure functions (`intent.ts`, `address-intelligence.ts`, `thana-lexicon.ts`). Tests for both pure functions. **No worker registration yet.** Data starts populating on new orders only — observable but inert.
2. **Day 2-3:** `ndrDetect` worker implementation + tests. Register in `index.ts` BUT with a feature flag (`NDR_ENGINE_ENABLED=0` default). Worker runs but writes nothing while flag is off — observe candidate-row counts in logs first.
3. **Day 4:** flip `NDR_ENGINE_ENABLED=1` on staging only. Watch counters for 24h. Verify NdrTask rows are created where expected and NOT where they shouldn't be (e.g. delivered orders).
4. **Day 5-6:** `ndrEngagement` worker + SMS templates + `parseSmsInbound` extension. Enable on staging. Test inbound replies with the existing test phone number.
5. **Day 7:** UI surfaces — `/dashboard/ndr`, order-detail panels, sidebar entry. Test on staging with seeded NDR tasks.
6. **Day 8:** flip prod with `NDR_ENGINE_ENABLED=1`. **Coordinate with one design-partner merchant** for first 48h so we can react to surprises with the merchant in the loop.
7. **Day 9-14:** observation window. No code changes; only log inspection + metric review.

## 4.9 Migration safety plan

- All schema additions are **optional fields** — existing documents validate without backfill.
- New TrackingSession index is built in background via the existing `syncIndexes` (`apps/api/src/index.ts:113-135`); the API binds to its port BEFORE the index build completes. Railway healthcheck unaffected.
- Worker registration is gated by `env.NDR_ENGINE_ENABLED`. A bad release is rolled back by setting the flag to `0` without redeploy.
- `dispatchNotification` retains its dedupeKey contract — even a runaway detect worker cannot spam the merchant.
- The intent-scoring fire-and-forget never throws back into ingest. We have telemetry coverage on `tRPC INTERNAL_SERVER_ERROR` already (`apps/api/src/server/trpc.ts:172-187`); any failure surfaces in Sentry without affecting orders.

## 4.10 Test coverage (vitest + one playwright e2e)

- `apps/api/tests/intent.test.ts` — 12 cases covering all signal combinations + no_data fallback.
- `apps/api/tests/address-intelligence.test.ts` — 20 cases covering Latin / Bangla / mixed-script / landmark presence / token-count edge cases / missing-hint generation.
- `apps/api/tests/thana-extraction.test.ts` — 15 thana ambiguity cases (Mirpur in Dhaka vs other Mirpurs).
- `apps/api/tests/ndr-detection.test.ts` — explicit_failed / stale_out_for_delivery / stale_in_transit + idempotency (re-detection doesn't double-create).
- `apps/api/tests/ndr-engagement.test.ts` — state machine transitions + SMS dispatch + `parseSmsInbound` ready intent.
- `apps/api/tests/sms-inbound.test.ts` — extend existing test file with READY intent cases.
- One Playwright e2e: merchant logs in → sees NDR queue with seeded task → marks abandoned → notification appears.

---

# Phase 5 — Validation Plan

## 5.1 Success metrics

### Engine-level

| Metric | Source | Target (60 days post-launch) |
|---|---|---|
| **NDR detection latency** (failed event → NdrTask created) | log `evt: ndr.detected` with `latencyMs` | P95 < 60s for explicit_failed; P95 < 5min for stale signals |
| **NDR detection precision** | manual sample of 50 NdrTasks/week, classified by ops as legitimate / not | ≥ 90% legitimate |
| **Intent tier vs RTO correlation** | join `Order.intent.tier` × `FraudPrediction.outcome` over 60d | `verified` tier RTO ≤ 0.5 × `unverified` tier RTO |
| **Address-quality vs RTO correlation** | similar join on `Order.address.quality.completeness` | `incomplete` cohort RTO ≥ 1.5 × `complete` cohort RTO |

### Recovery-level

| Metric | Source | Target |
|---|---|---|
| **NDR engagement reach rate** | NdrTasks with `lastSignalAt` → `buyerReplyAt` ratio | ≥ 30% reply within 24h (SMS-only baseline) |
| **NDR recovery rate** | NdrTasks with status=recovered / total NdrTasks | ≥ 15% in v1 (pre-WhatsApp); benchmark for medium-term |
| **Time-to-resolution** | `firstDetectedAt → resolution` | P50 ≤ 36h |

### RTO-outcome level

| Metric | Source | Target |
|---|---|---|
| **Per-merchant 30-day RTO rate** | `FraudPrediction.outcome` aggregation | Down 5-10% in design-partner merchants within 60 days |
| **Recovered revenue** | sum of (orderTotal) where NdrTask.resolution = "delivered" | Reported per-merchant on dashboard |
| **Avoided shipping cost** | sum of (estimated courier fee) for NdrTasks resolved before second-attempt failure | Reported per-merchant |

> RTO-outcome targets are **directional**, not contractual. Pure intent + address awareness without WhatsApp + IVR (medium-term work) caps achievable RTO reduction at ~10%. The bigger wins land with Phase 7 (WhatsApp adapter + IVR). v1 is the foundation that makes those gains measurable.

## 5.2 Analytics surfaces

- **`/dashboard/ndr`** — operator view (covered in Phase 3).
- **`/dashboard/analytics` Address Quality card** — cohort RTO breakdown.
- **`/dashboard/analytics` Intent Tier card** — order distribution by tier + RTO rate per tier.
- **`/admin/system`** — engine-health metrics: detection latency, queue depth on `ndr-detect`, engagement reach rate, exhausted/dead-lettered counters from existing `snapshotEnqueueCounters` (`apps/api/src/lib/queue.ts:181-200`).

## 5.3 Logging signals (every observable event)

- `evt: "ndr.detected"` — payload: orderId, merchantId, signal kind, latencyMs since the original tracking event.
- `evt: "ndr.engagement_sent"` — payload: ndrTaskId, channel, dlrStatus.
- `evt: "ndr.buyer_replied"` — payload: ndrTaskId, intent (ready / cancel / unknown).
- `evt: "ndr.rescheduled"` — payload: ndrTaskId, slot.
- `evt: "ndr.recovered"` — payload: ndrTaskId, resolution, latencyHours.
- `evt: "ndr.abandoned"` — payload: ndrTaskId, attempts.
- `evt: "intent.scored"` — payload: orderId, score, tier, signalsCount.
- `evt: "address.quality_scored"` — payload: orderId, completeness, score, missingHintsCount.

All structured JSON, single-line — fits the existing log-line format in `apps/api/src/lib/queue.ts:90-104`.

## 5.4 Merchant feedback loop

- Per `NdrTask`, the merchant can add a `note` and select a `resolution` reason from a fixed list (`buyer_unreachable | wrong_address | buyer_changed_mind | buyer_no_money | other`). This is the labeled training signal for Phase 7+.
- Address-quality merchant override: if a merchant marks an order's address as "actually fine, courier just messed up" via a one-click action, it stamps a `Order.address.quality.merchantOverride: true` and feeds the address-quality tuner long-term.
- Quarterly survey to design partners: "Which of these signals helped most?" — 5-question Typeform, results inform the medium-term roadmap.

## 5.5 Kill-switches

Three independent rollback levers, no redeploy needed:

1. `NDR_ENGINE_ENABLED=0` — turns off both workers; existing data preserved; UI surfaces show empty state.
2. `INTENT_SCORING_ENABLED=0` — turns off the fire-and-forget intent score at ingest; existing intent values preserved.
3. `ADDRESS_QUALITY_ENABLED=0` — same for address quality.

Each gates the *write*, not the *read*. So even if we kill all three, existing values continue to surface in the UI; we only stop minting new ones.

---

# Closing — What ships in this milestone

A merchant logs into Cordon and sees, on every order, **two facts they didn't have before**:
- **how committed the buyer was** before checkout (Intent tier);
- **how deliverable the address is** (Address Quality + thana).

When a parcel goes wrong post-dispatch, **the engine notices automatically**, contacts the buyer once via SMS, and surfaces the conversation to the merchant with a one-click reschedule path — instead of the order silently rotting in `rto` status.

None of this required a new database technology, a new queue infrastructure, a new auth model, or any AI black-box. **All three layers are additive extensions of systems that already work.**

The single most important hygiene step that came out of the audit — wiring the dormant `orderSync.worker.ts` — is required for this milestone to deliver its full value. Without polling fallback, missed Shopify/Woo deliveries are still our biggest silent risk; the NDR engine cannot recover an order it never ingested.

After 60 days of observation we have:
- Two pure-function classifiers with measured correlation against RTO outcomes — the inputs to Phase 7's risk-engine integration.
- A working NDR ledger with labeled resolution reasons — the training data for WhatsApp/IVR engagement.
- A merchant-visible operations surface — the conversion driver for "why pay for Cordon."

Everything compounds from there.

---

**End of execution roadmap.**

*Every file path, queue name, schema field, and dependency referenced in this document maps to a real location in the current monorepo OR is explicitly marked as new with its target path. No hallucinated systems. The boundaries between "extend" and "preserve" are explicit so the engineer reading this knows exactly what is in scope and what is not.*
