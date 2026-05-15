# 05 — Trust Gaps and What to Build

> The concrete list of "what we still need to implement / add so people trust
> this product." Ordered by trust-per-day-of-work.

Every item lists:
- **The gap** (what is missing today).
- **The trust harm** (what a merchant or customer thinks when they hit it).
- **The fix** (concrete, code-level).
- **Effort** (rough engineering days).

## Tier 0 — Cannot soft-launch without these

### 0.1 Per-merchant SMS sender ID + template
- **Gap.** `apps/api/src/lib/sms/index.ts` reads sender ID from env; templates
  are hardcoded.
- **Trust harm.** Merchant customers see *"ConfirmX: …"* on the SMS, not the
  merchant's brand. Merchant loses face. Stops sending.
- **Fix.** Add `Merchant.smsConfig` subdoc: `{ senderId, templates: { confirmation,
  expiry, deliveryUpdate, otp } }`. Render with mustache. Admin approval lane
  for sender-ID registration (BD telecom rule).
- **Effort.** 2–3 days incl. tests + admin UI.

### 0.2 IVR via BD-local provider
- **Gap.** `apps/api/src/lib/voice/twilio.ts` is demo-only;
  `initiateConfirmationCall` throws `NOT_IMPLEMENTED`. No BD adapter exists.
- **Trust harm.** Most direct: foreign caller IDs are ignored by BD numbers,
  so even the "Twilio works" claim is hollow. RTO reduction is bounded by
  SMS reply rate (20–40%) instead of SMS+call (60–75%).
- **Fix.** Integrate one of: Banglalink Engage, Robi voiceXML, or a custom
  SIP gateway over a BD telecom. Implement `initiateConfirmationCall` plus
  TwiML-equivalent IVR script host at `/api/voice/script/:callId`. DTMF
  capture maps `1` → confirm, `2` → cancel.
- **Effort.** 7–12 days incl. carrier paperwork.

### 0.3 Hide or honestly label the unfinished UI
- **Gap.** `dashboard/settings/notifications`, `dashboard/settings/team`,
  `(embedded)/` are visible to merchants but don't work.
- **Trust harm.** "This is a beta in disguise."
- **Fix.** Either implement v0 (notifications: 3 toggles + quiet hours; team:
  invite + role) or remove the navigation entries until v1.
- **Effort.** Hide path: 1 hour. Minimum-viable path: 3 days.

### 0.4 SMS opt-out / STOP semantics
- **Gap.** Inbound webhook routes confirmation replies only. No global
  unsubscribe. No compliance footer on outbound SMS.
- **Trust harm.** Regulatory + reputational. A complaint from a single
  customer can blow up sender-ID registration.
- **Fix.** Recognise `STOP`, `BAND`, `BONDHO`, `OFF` in inbound webhook;
  set `CustomerReliability.suppressed=true`; honour in `automationSms`.
  Append short compliance footer (`Reply STOP`).
- **Effort.** 1–2 days.

## Tier 1 — Trust accelerators (do within 30 days of soft launch)

### 1.1 Auto-backfill 50 recent orders on Shopify connect
- **Gap.** `orderSync.worker.ts` is recovery-only, not install-time backfill.
- **Trust harm.** First-day empty dashboard.
- **Fix.** In `integrations.completeShopifyInstall`, enqueue a one-shot
  `commerceImport` job for last-50 orders. Mark as `historical=true` so they
  don't trigger SMS.
- **Effort.** 1 day.

### 1.2 "Send me a test SMS" button on onboarding
- **Gap.** `scripts/sendTestConfirmation.ts` is CLI-only.
- **Trust harm.** Merchant has to wait for a real order to confirm the
  product works.
- **Fix.** Add `merchants.sendSelfTestSms` tRPC mutation (rate-limited
  1/min). Surface as a button on the getting-started page.
- **Effort.** 4 hours.

### 1.3 Demo merchant + `/demo` mode
- **Gap.** No sandbox path. Evaluators must connect a real Shopify store.
- **Trust harm.** Top-of-funnel evaluation drops off.
- **Fix.** Seed `demo-merchant` with 30 anonymised orders spanning low/med/
  high risk + various courier statuses. `/demo` signs into it read-only with
  banner.
- **Effort.** 1 day.

### 1.4 Bangla locale on `/track/[code]`
- **Gap.** Tracking page is English-only despite bilingual SMS.
- **Trust harm.** Customer arrives at a brand-named page in a language they
  don't read. Merchant looks worse.
- **Fix.** Add `lang=bn|en` query param + a small string table.
- **Effort.** Half a day.

### 1.5 Status page + WhatsApp support link
- **Gap.** No status surface, no in-app support contact other than feedback
  form.
- **Trust harm.** "What do I do when it's broken at 11 PM?"
- **Fix.** Add a footer support block: WhatsApp business number, support
  email, status URL. Status page can be a public GitHub Issues board initially.
- **Effort.** 2 hours setup + ongoing operational discipline.

### 1.6 Auto-approve manual payments below fraud-score 30
- **Gap.** `lib/manual-payments.ts` requires dual-approval at score ≥ 60
  but has no auto-approve lane at low scores.
- **Trust harm.** First-time bKash payers wait hours.
- **Fix.** Add `autoApproveBelowScore=30` config; on submit, when score < 30
  and no cross-merchant reuse, set status=`approved` immediately and grant
  entitlement.
- **Effort.** 1 day.

## Tier 2 — Compliance and credibility (within 60 days)

### 2.1 Bangladesh PDPA 2023 surface
- **Gap.** `legal/privacy/page.tsx` covers GDPR + CCPA only. No BD-specific
  language, no merchant DPA download.
- **Fix.** Add BD-PDPA section to privacy page; create downloadable DPA
  template; surface DPA acceptance in onboarding.
- **Effort.** 1–2 days + legal review.

### 2.2 SMS consent log
- **Gap.** No consent record. Merchants cannot prove opt-in.
- **Fix.** Record `CustomerConsent` row when a customer first interacts
  (first SMS reply OR explicit opt-in via storefront SDK).
- **Effort.** 2 days.

### 2.3 Shopify embedded — Phase D cutover
- **Gap.** `(embedded)/` route exists; CSP still `frame-ancestors 'none'`.
- **Fix.** Flip CSP for `/embedded/*` only. Wire App Bridge. Host the
  orders board inside Shopify Admin. Verify Shopify CLI partner review path.
- **Effort.** 3–5 days incl. Shopify review iteration.

### 2.4 Sentry + structured logs
- **Gap.** `SENTRY_DSN` optional, not active. Logs are console-shaped.
- **Fix.** Add `pino` (or pinned `winston`) with JSON output and request-id
  correlation; wire Sentry as required in production.
- **Effort.** 1–2 days.

### 2.5 In-app changelog / what's-new banner
- **Gap.** None.
- **Fix.** Static MDX entries served from `dashboard/changelog`. Dot indicator
  on the help icon on new entries.
- **Effort.** 1 day.

## Tier 3 — Delight (90 days+)

### 3.1 Explainability surfaces visible to the merchant
- **Gap.** The risk model is explainable in code (named signals), but the
  merchant UI shows "score 78" only.
- **Fix.** On the fraud-review page show the contributing signals: *"+22
  prior RTOs, +15 address quality low, –10 repeat customer."*
- **Effort.** 3 days.

### 3.2 Per-merchant risk threshold tuning
- **Gap.** `velocityThreshold` is per-merchant in code but not exposed in UI.
- **Fix.** Settings page: thresholds for auto-confirm / auto-reject /
  require-review; sliders with live preview against last-30-days orders.
- **Effort.** 4 days.

### 3.3 WhatsApp confirmation channel
- **Gap.** No WhatsApp adapter at all.
- **Fix.** Integrate Meta Cloud API. Template approval flow. Add to
  automation engine alongside SMS as a fallback or primary.
- **Effort.** 7–10 days incl. Meta verification.

### 3.4 Courier-lane explorer for merchants
- **Gap.** The lane intelligence exists but is admin-only.
- **Fix.** Merchant page that visualises *"Pathao to Dhaka South 92%
  delivered, 5% RTO, 3% cancelled — recommended"* and lets them lock a
  courier per district.
- **Effort.** 4 days.

### 3.5 Customer-reliability badge on Order detail
- **Gap.** Backend has it; UI doesn't surface it.
- **Fix.** Order detail header chip: *"Repeat customer — 7 successful
  deliveries, 0 RTO"* or *"New customer — verify carefully."*
- **Effort.** 1 day.

### 3.6 Webhook auto-registration with Pathao / Steadfast / RedX
- **Gap.** `webhook-registration.ts` returns paste-in instructions today.
- **Fix.** Where each courier exposes a webhook-management API, register
  programmatically.
- **Effort.** 2 days per courier (mostly waiting on courier API access).

## Cross-cutting investments

- **A real onboarding video.** 90 seconds, in Bangla, with subtitles. Embed
  on landing + onboarding shell. (Not in this repo, but missing.)
- **2 design-partner video testimonials.** Same.
- **A founder bio + LinkedIn link on the marketing page.** Yes, it matters
  in BD as much as anywhere.
- **A weekly product email** to design-partner merchants summarising
  changes. Build the muscle now while the cohort is small.

## How to read this list

Don't do them all. Do **Tier 0** before any external commitment, then **Tier 1**
in parallel with collecting design-partner feedback. Tier 2 is the gate for
opening the Shopify App Store listing. Tier 3 is what makes ConfirmX a
must-have rather than a nice-to-have.
