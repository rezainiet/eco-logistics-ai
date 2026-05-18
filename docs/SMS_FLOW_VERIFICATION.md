# SMS Flow Verification (pre-beta)

Audited on the beta line (the SMS-provider migration is quarantined on
`wip/sms-migration`, so beta runs **SSL Wireless only** — `lib/sms/
sslwireless.ts`; BulkSMSBD/voice/Twilio are NOT in this build).

The point of this doc: **separate what the code guarantees from what
only a real BD number on a real gateway can confirm.** Local green ≠
production green.

## ✅ VERIFIED (code-evident / unit-tested)

- **Outbound never crashes the request path.** `sendSms` returns a
  result object, never throws. If `SSL_WIRELESS_API_KEY/USER/SID` are
  unset, `loadTransport()` returns null and the call returns
  `{ ok:false, providerStatus:"no_provider" }` with a loud warning —
  no exception into automation.
- **Phone normalisation to 13-digit BD form** before send
  (`normalizeBdPhone`), invalid → `client_invalid_phone`, no send.
- **Confirmation template** is bilingual EN+Bangla with the reply code
  (covered by the `merchants.sendTestSms` test).
- **DLR webhook is HMAC-verified** (`SMS_WEBHOOK_SHARED_SECRET`,
  `timingSafeEqual`). Prod: bad signature → 401. Dev w/o secret →
  process continues with a loud warning. Maps delivered / failed /
  pending; `failed` escalates the order to review; unparseable/unknown
  → 200 (no provider retry storm).
- **Inbound webhook is HMAC-verified** (same scheme) and the reply
  parser is unit-tested (12 cases): informal EN, transliteration,
  Bangla script, emoji, conflicting→ignore, code-optional with
  single-pending-order binding, bare-code→ignore. Every decision is in
  the audit log (`matchedOn`, `codeless`).
- **State-machine guarded**: confirm/reject only from
  `pending_confirmation`; idempotent re-delivery is a 200 no-op;
  late-reply sends a one-time courtesy SMS.

## ⚠ ASSUMED (coded to an assumption, NOT validated against the live gateway)

- **SSL Wireless API contract.** Request body fields (`api_token`,
  `sid`, `msisdn`, `mask`) and the success/`status_code`/`sms_status`
  parsing are written to the documented "SMS Plus" shape. No live call
  has ever been made from this branch. If their contract differs,
  every send fails `ok:false` and orders silently stall in
  `pending_confirmation`.
- **DLR payload shape.** The fields the DLR webhook reads are assumed;
  a real delivery receipt is needed to confirm the parser matches.
- **Inbound MO payload shape.** We accept `from|msisdn|sender` and
  `body|text|message|sms`. The real gateway's MO field names are
  unconfirmed.
- **Webhook signing.** Biggest assumption: that SSL Wireless DLR/MO
  callbacks are HMAC-signed with our shared secret in the header
  `checkSmsWebhookAuth` expects. **If SSL Wireless does not sign (many
  BD gateways don't), every real DLR/MO will 401 in production and be
  silently dropped** — confirmations would never register. This must
  be resolved before onboarding, not after.
- **Sender mask / masking-ID registration.** The mask = configured
  sender or SID. It's assumed to be a *registered* masking ID with the
  operator (BD regulation). If unregistered, the provider may reject or
  rewrite the sender — and there is **no per-merchant sender branding**
  (system-wide sender only; known limitation).
- **Outbound retry.** `sendSms` is a single attempt; retry/backoff is
  owned by the `automationSms` worker, not re-verified in this audit.

## 🔴 REQUIRES LIVE PRODUCTION TRAFFIC (cannot be settled in code)

1. One real BD handset: receive the bilingual SMS, reply informally,
   confirm DLR + MO land and the order flips. **Never run end-to-end
   against the live gateway from this branch.**
2. Whether SSL Wireless actually signs DLR/MO callbacks, and how —
   this determines if our webhook auth accepts or rejects ALL real
   traffic (see assumption above).
3. The real distribution of customer reply phrasing vs the lexicon
   (watch `sms_inbound` `intent_without_unique_order` / `no_match`).
4. Masking-ID registration status with the BD operator.
5. Deliverability + latency across BD carriers (Grameenphone, Robi,
   Banglalink, Teletalk).

## Pre-onboarding action

- [ ] Confirm with SSL Wireless: exact send contract, DLR/MO payload,
      and **whether/how callbacks are signed**. Adjust
      `webhook-verify` / parsers to the real contract.
- [ ] Confirm the masking ID is registered and active.
- [ ] Run one real send→reply→DLR loop with a test number; watch the
      structured `sms_*` logs end to end before merchant #1.

Engineering confidence: the *logic and failure handling* are sound and
tested. Market/integration certainty: **unproven against the live SSL
Wireless contract** — that gap is the single biggest beta risk in the
SMS path and is an integration question, not a code-quality one.
