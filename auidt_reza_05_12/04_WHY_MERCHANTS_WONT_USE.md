# 04 — Why Merchants Won't Use This (Yet)

> Read this when you need to be honest with yourself about why a Shopify
> merchant in Dhaka, Chittagong, or Sylhet will try ConfirmX, get to step 4
> of onboarding, and quietly close the tab.

Each blocker is grounded in a file in the repo. None of this is speculation.

## 1. The first-day experience does not produce a "wow"

A merchant signs up. They go through the onboarding checklist
(`components/onboarding/onboarding-checklist.tsx`). They:

1. Connect Shopify  (~3 min)
2. Import orders   (~1 min, but **no historical backfill triggers automatically**)
3. Add a courier   (~2 min — they have to paste API keys)
4. Enable automation (~1 min — toggle)
5. Test SMS         (~1 min — but there is **no in-product "send test SMS" button**)

Then they sit on a dashboard waiting for a real customer order to arrive.

**Why this kills adoption:** the merchant has 6 SaaS tools open at once.
Whichever one shows value in the first 10 minutes wins. ConfirmX shows value
only when the *next* customer places an order — which on a slow weekday
afternoon could be hours away.

Evidence:
- `apps/api/src/workers/orderSync.worker.ts:47` comment: *"This worker is the
  recovery rail"* — it is not an install-time backfill.
- `apps/api/src/scripts/sendTestConfirmation.ts` is a CLI script (untracked)
  and not surfaced in the UI.

**Fix:** automatic 50-order historical import on Shopify connect, plus a
"send me a test confirmation SMS to my own number" button on the onboarding
checklist. Both are small. Both are missing.

## 2. The SMS that goes out is not their brand

Look at `apps/api/src/lib/sms/index.ts` lines 265–295. The order-confirmation
SMS is bilingual EN/Bangla — good. But:

- The **sender ID** is whatever the SSL Wireless / BulkSMSBD account is
  registered under, system-wide, **not configurable per merchant**.
- The **body** is hard-coded ("Brand: Confirm order #X. Reply YES <code>…").
  The merchant cannot change tone, add a thank-you, include their own URL,
  or drop the confirmation-code hint.

**Why this kills adoption for serious merchants:** a high-AOV merchant lives
or dies on brand voice. If the SMS their customers receive says
*"ConfirmX: Confirm order…"* — they will not adopt. Period.

**Fix:** per-merchant `SmsTemplate` schema, sender-id field on the Merchant
model, admin review for sender IDs (BD regulation requires registered
masking IDs). This is roughly 2–3 days of work — but it doesn't exist today.

## 3. IVR voice confirmation does not work in Bangladesh

This is the biggest single trust gap. From `apps/api/src/lib/voice/types.ts`
line 8:

> *"Bangladeshi recipients largely ignore foreign caller IDs — real
> production traffic must terminate on a BD-local provider."*

And line 25:

> *"The legacy Twilio adapter does NOT implement [initiateConfirmationCall]
> (no TwiML for the IVR script is hosted yet). PR 2 wires the BD adapter."*

PR 2 is not done. The pricing page and feature lists may mention call
confirmation. The runtime returns 501.

**Why this kills adoption:** the *whole point* of an RTO-reduction tool in
Bangladesh is that SMS reply rates are 20–40%. The lift comes from a phone
call. Without IVR, ConfirmX is "SMS confirmation as a service" — which
several local players already do.

**Fix:** integrate a BD-local CPaaS (Banglalink Engage, Robi, Alpha Net,
or a small custom SIP setup). Until that is done, **do not market IVR**.

## 4. "Coming Soon" stubs are visible in the dashboard

Merchants who click around will hit these surfaces today:

| Route | What they see |
|-------|---------------|
| `dashboard/settings/notifications` | *"Notification preferences are on the way — Today every operational alert is hard-coded."* |
| `dashboard/settings/team` | `<ComingSoon />` |
| `dashboard/billing` | *"Manual card receipt (Stripe coming soon)."* |

A merchant who is paying 3,000 BDT/month wants to see "Pro" features. Three
"Coming Soon" tiles inside *Settings* signal to them: "this is a beta; come
back next quarter."

**Fix:** either ship a minimum viable version of each, or remove the
navigation entries entirely. Half-shipped UI is worse than no UI.

## 5. There is no sandbox, no demo data, no try-before-connect

A founder in BD evaluating a logistics tool will not connect their live
Shopify store on first visit. They want to **click around with fake orders**
to feel the product.

The repo has zero of:
- A `?demo=1` flag that seeds a demo merchant with sample orders.
- A "Watch a 90-second video" embed in the onboarding shell.
- A guided tour overlay.

**Why this kills adoption:** evaluation is the funnel. If you can't be
evaluated in 5 minutes you lose to whoever can.

**Fix:** seed a `demo-merchant` Mongo fixture with 30 anonymised orders
across the risk spectrum. Add a `/demo` route that signs in as the demo
merchant read-only. Half a day's work.

## 6. The merchant has zero notification control

Today, every operational alert is hard-coded. Look at
`apps/web/src/app/dashboard/settings/notifications/page.tsx` — it admits this
out loud.

Merchants react badly to "your system decides when to bother me." They want:
- Quiet hours (no SMS to customers between 10 PM – 8 AM).
- Critical-only alerts.
- Channel preference (in-app vs email vs SMS).

None of these exist.

**Fix:** Notification preferences schema on the Merchant model.
Honour `quietHours` in `automationSms` worker before dispatching.

## 7. The customer-facing tracking page is English-only

`apps/web/src/app/track/[code]/page.tsx` renders fully in English. The SMS
the customer received was bilingual. They land on the tracking page and the
language flips.

This is a small bug that **looks unprofessional** to a Bangladeshi customer
and reflects badly on the merchant — which means the merchant won't promote
the link.

**Fix:** add a Bangla locale to the tracking page. The strings are few; one
afternoon.

## 8. Pricing is in BDT but the payment journey is awkward

- bKash and Nagad work (`lib/manual-payments.ts`).
- Stripe card is *"coming soon."*
- Bank transfer is supported but slow.

A BD merchant comparing 3 tools wants to **pay by bKash in 30 seconds** with
auto-credit. The current manual-payment flow requires uploading a screenshot
and waiting for admin approval (because of the cross-merchant fraud check).

The cross-merchant fraud check is **excellent engineering** but **terrible
onboarding UX** for a first-time payer who is below the fraud-score threshold
on every signal. There is no "auto-approve below score 30" lane visible in
the code.

**Fix:** add a low-risk auto-approve lane to `lib/manual-payments.ts` so
first-pay merchants with clean signals get instant activation.

## 9. Trust signals on the marketing site are thin

`apps/web/src/app/(marketing)/` exists but the public site has:
- No customer logos.
- No real testimonials.
- No Bangla version.
- No founder-by-name authority bio.

A merchant who Googles "ConfirmX" and lands on `landing.html` sees a clean
page with no proof. The lift of the actual product never reaches them.

**Fix:** before launch — even soft — record 2 short video testimonials with
2 design partners (in Bangla). Add real logos. Add founder name + LinkedIn.

## 10. Support is invisible

Search the repo for "status.confirmx" — nothing. For "help.confirmx" —
nothing. The feedback button exists
(`apps/web/src/components/feedback/feedback-button.tsx`) but it sends a
message into a queue and does not promise SLA.

Bangladeshi merchants want a WhatsApp / Messenger / Imo number to ping when
something breaks. The dashboard has no such surface.

**Fix:** add a footer block with a real WhatsApp business number, a
documented response time, and a status page link — even if the status page
is just GitHub Issues for now.

## 11. The Shopify embedded path doesn't work yet

A merchant who finds you in the Shopify App Store expects the app to live
inside Shopify Admin. Today the iframe is **blocked** by CSP
(`frame-ancestors 'none'`). They will be punted out to your standalone web
app — which is fine functionally, but feels like a 2018 integration.

**Fix:** finish Phase D — flip CSP for `/embedded/*`, ensure App Bridge is
wired, host the embedded orders board.

## 12. The product is generic on the *outside*, brilliant on the *inside*

A merchant on the homepage cannot tell that you have:
- A BD landmark lexicon for address quality scoring.
- A cross-merchant fraud signal network.
- A courier-lane intelligence layer that explains *why* Pathao is 92% in
  Dhaka but 78% in Sylhet.
- An audit trail that records every automation decision.

The product is doing more than the website claims, but the merchant only
sees the dashboard chrome and the SMS that doesn't have their brand on it.

**Fix:** write three short product pages (`/why-bd`, `/why-network`,
`/why-explainable`) and link them from the dashboard's empty states.

---

## Ranked: top 5 reasons adoption will stall **this month**

1. **SMS is not branded as the merchant.** (Item 2)
2. **IVR doesn't actually call BD customers.** (Item 3)
3. **No sandbox / demo path for evaluation.** (Item 5)
4. **Three "Coming Soon" stubs visible inside Settings.** (Item 4)
5. **First-day dashboard is empty until a real order arrives.** (Item 1)

Fix these five and you go from "interesting beta" to "credibly purchasable."
