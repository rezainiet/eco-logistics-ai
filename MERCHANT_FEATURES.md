# MERCHANT_FEATURES.md

**Audience:** merchants, sales conversations, demos, onboarding,
support team. Plain English. No engineering jargon.

This is a catalogue of what Cordon **does for the merchant**, not how
it does it. For the technical view see `PROJECT_ARCHITECTURE.md`.

---

## What Cordon is

Cordon is the **order operations OS** for COD-driven Shopify and
WooCommerce stores in Bangladesh. It sits between your storefront and
your couriers, watches every order from placement through delivery,
and gives you one trusted dashboard to spot trouble before it costs
you money.

**Trouble we help you avoid:**
- Fake / non-serious COD orders that ship and get refused.
- Addresses too vague to deliver — caught before the courier loses time
  on a doomed run.
- Orders stuck in transit with nobody chasing them.
- Customers who never pick up the phone for confirmation.

**Trouble we don't pretend to fix:**
- Real shipping problems on the courier's side.
- A buyer who genuinely changes their mind on a real product.
- Anything that's not a delivery / order-quality concern.

---

## 1. Connect your store

### Shopify integration
- Connect Shopify with one click — log in, click Approve, you're done.
- We see every order the moment it's placed.
- We cleanly handle reconnects when you rotate credentials, change
  scopes, or even uninstall and reinstall.
- GDPR / privacy webhooks are wired correctly so your Shopify Partner
  app submission can pass review.

**Why it matters:** the typical "missed order" panic in COD commerce
comes from a webhook the merchant never knew was failing. Cordon's
webhook reliability (described below) eliminates that class of issue.

### WooCommerce integration
- Connect Woo with consumer key + secret from your Woo admin.
- Same real-time order sync as Shopify.
- Cordon performs an SSRF check on the URL you provide so a
  misconfiguration can't expose your hosting environment.

### Custom-API integration
- Custom storefronts post orders to a Cordon-hosted endpoint and
  Cordon handles them like any other source.
- HMAC-signed for authenticity.

### CSV / bulk upload
- Drop a CSV; Cordon imports the orders, validates the addresses,
  and routes them through the same risk + delivery pipeline.

---

## 2. Webhook recovery (you'll never miss an order)

When your storefront sends an order to Cordon and something briefly
breaks (network blip, momentary outage, anything), Cordon doesn't
shrug — it remembers.

- Every order delivery from your storefront gets a permanent receipt.
  If we somehow process the same order twice, you don't get duplicate
  rows in your dashboard.
- If something goes wrong on our side, we keep the order on a
  recovery queue and try again automatically.
- If a delivery from your storefront somehow gets lost in flight, our
  retry sweep catches it within minutes.

**Why it matters:** in BD COD, "the order arrived in our admin but not
in Cordon" is the most expensive class of bug. We've designed it out
at the system level.

---

## 3. Fraud review (catch bad orders before you ship)

Every order that lands in Cordon is automatically scored for risk.
The score is not a black box — every contributing factor is named
clearly so you can verify the system's reasoning:

- "Same phone number returned 3 prior orders"
- "COD value is 4× this customer's average"
- "Address has no landmark or road number — rider has no anchor"
- "Customer has 6 orders in the last 10 minutes"
- "Phone number is on your block list"

**Three risk tiers:** low / medium / high. Medium and high orders flow
into your fraud-review queue. Each order shows you:
- the score
- every signal that fired
- the customer's prior history (delivered / RTO / cancelled / unreachable)
- a "trust badge" (safe / verify / risky)
- the calibrated probability of return-to-origin

**You decide.** Cordon never auto-cancels an order without your
permission — every action is your call.

### Cross-merchant fraud network

When the same buyer phone or address has caused returns on orders
from other Cordon merchants, that information feeds into the score —
**without** revealing which merchants those were. We share the
behavior pattern, not the merchant identities.

---

## 4. Buyer intent (how committed was the buyer?)

For each order we observe whether the buyer:
- visited your store more than once before ordering
- viewed multiple products
- spent real time on the page (not just a 12-second drive-by)
- arrived from organic search vs paid social
- returned across multiple days before placing the order
- replied to the SMS confirmation prompt

These observations roll up into one operator-readable badge:
**Verified · Implicit · Unverified · No data.**

Each tier comes with a one-sentence explanation of why — never an
opaque "AI score." For example:
- "Buyer visited your store across 2 sessions before placing this order."
- "Buyer scrolled 80% through the product page."
- "Buyer arrived from organic search."

**Why it matters:** in COD, intent is the strongest predictor of
"will this order actually accept delivery." Intent intelligence is
currently observation-only — it informs your decision; it does not
auto-block orders.

---

## 5. Address quality (deliverable address?)

Every order's address is automatically scored:
- **Complete** — has a road / house number AND a landmark.
- **Partial** — has one or the other.
- **Incomplete** — missing both, or too short, or mixes Bangla + Latin
  in ways couriers struggle with.

The dashboard shows the merchant exactly which signals fired:
- "Detected landmarks: mosque, bazar"
- "No road or house number — request one before dispatch"
- "Address mixes Bangla and English — couriers may interpret unevenly"

For Bangladesh-specific delivery, we extract the **thana** (police-
station-level subdistrict) from the address — that's the actual
delivery zone for Pathao, Steadfast, and RedX, and the granularity at
which couriers route.

**Why it matters:** 30–60% of BD COD returns trace to address
ambiguity, not buyer intent. Catching incomplete addresses **before**
you ship saves a courier round-trip per RTO avoided.

---

## 6. Operational hints (what does this order need from me?)

Open any order's detail and Cordon tells you what (if anything) needs
your attention. Eight states with one sentence and a suggested action:

| Hint | What it means |
|---|---|
| Address looks incomplete | Reach out for a landmark before shipping |
| Confirmation SMS didn't reach the buyer | Try a manual call or WhatsApp |
| Customer didn't answer call attempts | Try a different time, or SMS / WhatsApp |
| Awaiting customer confirmation | Customer was sent the SMS prompt; we're waiting |
| Delivery failed on most recent attempt | Contact the buyer to reschedule |
| Out for delivery — attempt in progress | Courier on the route — no action unless buyer reports |
| No tracking updates for 4 days | Courier may have lost scan visibility — open a ticket |
| Confirmed but not shipped after 36h | Either courier hasn't picked up, or auto-booking is blocked |

**Visibility-only.** Cordon never auto-cancels or auto-reschedules.
You see the state and decide.

---

## 7. Automated courier booking (when you want it)

Cordon picks the right courier for each order based on **your own
delivery history**:
- success rate per (courier, district)
- RTO rate
- average delivery hours
- recent booking failures

For the same order, Pathao might be the right pick in Mirpur and
Steadfast the right pick in Sylhet. Cordon picks per-order; you can
override.

**Three automation modes per merchant:**
- **Manual** — every order goes to your queue. Default for new merchants.
- **Semi-auto** — low-risk orders auto-confirm; medium / high go to
  pending confirmation. Auto-book is off by default.
- **Full auto** — low-risk orders auto-confirm AND auto-book through
  your preferred courier. Medium goes to pending confirmation; high
  always requires human review.

**Fallback chain:** if the chosen courier rejects the booking, Cordon
tries the next-best, up to 3 couriers. After that the order surfaces
to you for manual handoff with full context.

**Per-merchant courier configuration:** you provide your own Pathao /
Steadfast / RedX accounts. Cordon never bills couriers on your behalf
— you keep the courier relationship.

---

## 8. SMS verification (close the loop with the buyer)

Cordon can send the buyer a short SMS asking them to reply with a
6-digit code to confirm the order. This is the strongest commitment
signal we can observe before you ship.

- Sent through SSL Wireless (Bangladesh's standard transactional SMS).
- Delivery receipts (DLR) are tracked — we know whether the SMS
  actually reached the buyer's handset.
- Replies are parsed in English and Bangla transliteration ("YES",
  "NO", "ha", "na", etc.).
- If the SMS gateway hiccups, Cordon retries automatically.
- If delivery receipts confirm the SMS never landed, the order's
  operational hint flips to "Confirmation SMS didn't reach the buyer"
  so you can switch to a phone call.

---

## 9. Live tracking from your couriers

- Real-time push: Pathao, Steadfast, RedX webhooks deliver every
  status update.
- Fallback polling: every 60 minutes Cordon pulls courier status
  for any active shipment that hasn't pushed an update.
- Each tracking event is recorded with a stable normalized status
  (`pending`, `picked_up`, `in_transit`, `out_for_delivery`,
  `delivered`, `failed`, `rto`).
- The customer-facing tracking page (`/track/[code]`) is branded with
  YOUR logo, colours, and contact info — embeddable in your storefront.

---

## 10. Onboarding checklist (5 steps, ~8 minutes total)

A new merchant signing up sees five clearly-timed steps:

1. **Connect your store** (~3 min) — Shopify or WooCommerce.
2. **Import recent orders** (~1 min) — pulls your most recent orders so
   the dashboard isn't empty on day one.
3. **Add a courier** (~2 min) — Pathao, Steadfast, or RedX credentials.
4. **Choose your automation level** (~1 min) — manual / semi / full.
5. **Test SMS** (~1 min) — confirms your merchant SMS templates reach
   a real handset.

Each step has a clear "what's next" CTA, a realistic time estimate,
and the merchant always sees what's locked behind the previous step.

---

## 11. Billing flexibility

- **Stripe Subscriptions** — recurring auto-renew in BDT or USD.
- **Manual rails** — bKash / Nagad / bank transfer. Submit a receipt;
  the finance team reviews and approves.
- **Plans:** Starter (999 BDT) → Growth (2,499 BDT) → Scale (5,999 BDT)
  → Enterprise (14,999 BDT). USD pricing available.
- **Trial:** 14 days, no credit card required.
- **Plan-change preview:** before you downgrade, Cordon shows you
  exactly which integrations would be disabled — no surprises.
- **Self-serve cancel** via Stripe Customer Portal for subscription
  customers.

---

## 12. Operational visibility (you can see everything)

- **Webhook health card** — green / yellow / red per integration with
  last-event-received and last-error.
- **Integration health monitor** — automated test that pings each
  integration's connection daily.
- **Dashboard analytics** — order volume, RTO rate, courier
  performance, today's revenue, intent + address quality cohort
  breakdowns.
- **Sidebar status** — at-a-glance system-working indicator.

---

## 13. Trust + audit

Every state-changing decision Cordon makes (or you make through Cordon)
is recorded in an **append-only audit log** with cryptographic chain
verification. Anyone with admin access can:

- See exactly what happened to an order, when, and who decided it.
- Verify the chain hasn't been tampered with.

This isn't a marketing claim — Mongoose-level immutability hooks
prevent ex-post edits even from inside the platform itself.

**Why it matters:** when a merchant or auditor asks "who cancelled
this order at 3pm last Tuesday," there's a precise, verifiable answer.

---

## 14. Operational recovery + safety nets

- **Replay durability:** if our queue infrastructure has a bad day,
  no work is lost. Every accepted webhook is guaranteed to eventually
  process; the merchant's orders never silently disappear.
- **Per-merchant rate fairness:** one merchant's traffic burst can't
  starve another's queue.
- **Booking lock:** prevents accidentally creating two AWBs for the
  same order under any race condition.
- **Optimistic concurrency on every order mutation** — concurrent
  workers can never silently overwrite each other's state.
- **Dead-letter recovery sweep** — if a job lands in the dead letter
  due to a Redis hiccup, it's automatically retried as soon as the
  underlying issue clears.

---

## 15. Merchant-to-Cordon feedback loop

Every page in the dashboard has a **Feedback** button in the topbar.
Tell us what's working, what's not, what you wish was here. Each
submission goes to one queue our team triages directly.

**Why it matters:** during the design-partner phase the platform's
roadmap is driven by your real friction points, not roadmap intuition.
What you tell us becomes what we ship next.

---

## 16. Bangladesh-first, by design

- BDT pricing as the default; USD optional.
- Bangla + Latin transliteration in SMS reply parsing.
- Bangla landmark vocabulary ("masjid", "bazar", "mosque", "school" — and
  their Bangla equivalents) in address quality scoring.
- Thana / upazila vocabulary tuned for BD delivery zones (150+ thanas
  seeded; growing as merchant data uncovers gaps).
- District normalization handles common spelling drift (Dhaka / dhaka
  / DHAKA / Dhaka City / ঢাকা all resolve to the same canonical district).
- bKash / Nagad / bank-transfer billing rails as first-class.
- Local courier intelligence (Pathao, Steadfast, RedX) instead of
  "ship-to-a-warehouse" abstractions invented for Western markets.

---

## What Cordon is NOT

Honest disclaimers worth saying up front:

- Cordon does **not** ship your orders. Pathao / Steadfast / RedX do.
  We orchestrate; they deliver.
- Cordon does **not** auto-cancel or auto-block orders without your
  configured permission.
- Cordon does **not** use AI / LLMs to make risk decisions. Every
  signal is a named rule with a documented weight. The score is
  deterministic and explainable.
- Cordon does **not** replace your call center. The agent UX exists,
  but the actual conversation with the buyer is yours.

---

## How to talk about Cordon

Recommended one-liners for sales / demos:

- "Cordon is the operations layer between your storefront and your
  couriers — it stops bad orders from shipping and recovers good
  orders that get stuck."
- "Every signal is explainable. We'll show you exactly why an order
  is flagged, never just a risk number."
- "Bangladesh-native — bKash, Nagad, Pathao, Steadfast, RedX, Bangla
  addresses. Built for the BD COD economy from day one."
- "Trust at the system level: webhook recovery, append-only audit
  log, optimistic concurrency, per-merchant rate fairness."

Recommended one-liners to avoid:

- ❌ "AI-powered fraud detection" — we are not AI-powered, deliberately.
- ❌ "Predicts the future" — we score, we don't predict.
- ❌ "Eliminates RTO" — we reduce it; nobody eliminates it.
- ❌ "Replaces your team" — we make your team faster, not optional.

---

**End of merchant features document.**

*Every feature listed in this document is implemented in the current
`main` branch. Implementation paths are cited in the companion
`PROJECT_ARCHITECTURE.md` for technical readers.*
