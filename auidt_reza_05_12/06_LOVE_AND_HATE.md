# 06 — Why merchants will love it / Why they will hate it

> Two sides of the same product. Grounded in what is actually in the code,
> not in pitch decks.

## Part A — Why they will LOVE it

### A1. The risk model explains itself
Most "fraud detection" products in this space are black boxes. ConfirmX names
its signals — `customer_repeat_success`, `address_clean_history`,
`courier_lane_strong`, `velocity_breach`, `blocked_phone` — and exposes
them in the audit log (`apps/api/src/lib/delivery-reliability.ts` +
`server/risk.ts`). When a merchant disagrees with a flag they can see the
reasoning. That single trait is rare in Bangladesh SaaS today and is
worth a paragraph in the pitch.

### A2. It actually understands Bangladeshi addresses
`apps/api/src/lib/address-intelligence.ts` + `thana-lexicon.ts` +
`gazetteer.ts` carry a real lexicon: mosque, bazar, thana, mor, hat, station,
dispensary, etc., in both English transliteration and Bangla script. A
landmark-relative address that a Google Maps lookup would mark "low quality"
gets correctly scored as high deliverability here. No other product targeting
this market reads addresses the way Bangladeshis actually write them.

### A3. Cross-merchant fraud intelligence, with privacy
`apps/api/src/lib/fraud-network.ts` shares only `phoneHash` and `addressHash`.
A merchant's first order *already benefits* from signals contributed by
1000s of orders across the network. New merchants don't suffer a cold-start
problem on fraud detection. And they don't have to trust that ConfirmX is
hoarding their customer list — it isn't, because the exchange is hash-only.

### A4. Courier-lane intelligence that explains itself
The system knows *Pathao → Dhaka metro* is different from
*Pathao → Sylhet hills*. `CourierPerformance` + `CourierLane` models track
delivery rate, RTO rate, transit days per lane. A merchant who wires this in
can routinely cut RTO by picking the right courier per district instead of
defaulting to one. The data shape exists today; surfacing it to merchants
(see `05` Tier 3) unlocks visible value.

### A5. Manual payment fraud detection that protects the merchant
`apps/api/src/lib/manual-payments.ts` cross-checks bKash/Nagad transaction
IDs, proof-file fingerprints, and metadata against every other merchant's
submissions. A coordinated scammer submitting the same fake receipt to 10
merchants gets caught on the second one. Most BD SaaS finance modules don't
even try.

### A6. Idempotency and outbox patterns
Every webhook is idempotent (`WebhookInbox` + provider-specific dedupe).
A `PendingJob` outbox + `pendingJobReplay` worker drains orphans back onto
BullMQ on Redis recovery. The merchant won't *see* this — but they will
never see a duplicate order created or a confirmation SMS sent twice.

### A7. Audit log records every automation decision
`AuditLog` + the admin audit search show: who confirmed, who rejected, when
the worker auto-confirmed, when a rule fired. For a co-founder operating
a 4-person ops team this is gold — they can review yesterday's automation
output every morning.

### A8. The public tracking page is genuinely branded
`apps/web/src/app/track/[code]/page.tsx` is server-rendered, picks up
the merchant logo + primary colour (auto-extracted from logo upload in
`components/branding/branding-section.tsx`), shows masked address, COD
amount, timeline, and the merchant's support contacts. A customer landing
on it sees the merchant brand, not "ConfirmX".

### A9. Bangladesh-first economics
BDT pricing on the pricing page. bKash + Nagad + bank transfer all real
(card via Stripe is the "coming soon" item). Pricing tiers (Starter / Growth
/ Scale / Enterprise) are wired to actual feature caps in
`apps/web/src/app/pricing/page.tsx` — the comment in the file says
*"Replaces the legacy static highlights array (which drifted from
`maxIntegrations` on Growth and caused real support tickets)."* That's
discipline.

### A10. The product is more than what the website claims
Every senior engineer who reads this codebase will say "huh, that's
surprisingly thoughtful." A founder who pivots their marketing to match the
actual depth — *"explainable BD-localised RTO reduction with shared-network
fraud signals"* — will close enterprise pilots that a "SMS confirmation tool"
pitch would never reach.

## Part B — Why they will HATE it

### B1. The SMS doesn't carry their brand
`apps/api/src/lib/sms/index.ts` — sender ID and body are not merchant-
configurable. A premium merchant signing up will see their customers receive
SMS branded as ConfirmX / SSL Wireless / BulkSMSBD, not their store. This is
the single biggest dealbreaker for any merchant with brand discipline.

### B2. IVR confirmation is a lie until BD-local goes live
The pricing page / sales pitch may mention voice confirmation. The runtime
returns 501. `apps/api/src/lib/voice/types.ts` admits in a comment that
*"Bangladeshi recipients largely ignore foreign caller IDs."* A merchant
who tries it once and hears nothing happen will not try again.

### B3. The first day is empty
After connecting Shopify, the merchant lands on a dashboard with zero
orders, zero confirmations sent, zero RTO data. They have to wait for the
*next* customer order before they see the product do anything. No
auto-backfill, no test-SMS button, no demo data.

### B4. "Coming Soon" stubs inside paid features
- `dashboard/settings/notifications` — admits "every alert is hard-coded."
- `dashboard/settings/team` — `<ComingSoon />`.
- `billing` — "Stripe coming soon."

A merchant on a paid plan reading these will assume the rest of the product
is also a beta.

### B5. They can't control the SMS they're paying to send
- No quiet hours.
- No template editing.
- No language preference.
- No frequency cap.
- No `STOP` reply support.

The merchant pays for SMS volume but has zero say in what gets sent.

### B6. The tracking page is English while the SMS is bilingual
A customer who reads only Bangla gets a bilingual SMS, taps the tracking
link, and lands on a fully English page. They WhatsApp the merchant asking
*"কি লেখা আছে এখানে?"* ("what does this say?"). The merchant blames the tool.

### B7. The Shopify embedded experience is broken
Shopify App Store visitors expect the app to live inside Shopify Admin. The
`(embedded)/` route exists but CSP still blocks the iframe. Merchant is
punted to standalone web. Feels old-school.

### B8. Support is a single feedback button
There's no in-app live chat, no WhatsApp link, no documented SLA outside
Enterprise, no status page. The feedback button submits a row in
`MerchantFeedback` and gives the merchant no expectation of a reply.

### B9. Manual payment first-time UX is awkward
A first-time bKash payer uploads a receipt screenshot, then waits while the
fraud check runs. There is no "auto-approve below score 30" lane. For an
honest first-time payer this looks like *"why are they checking me?"*

### B10. Documentation is invisible
There is no `/help`, no `/docs`, no in-app knowledge base, no embedded
walkthroughs. A merchant who hits a confusing setting has no self-serve
path. They email support, get no SLA, and churn.

### B11. The web app is English-only
The dashboard, the settings, the billing pages — all English. A merchant
operations team in a small-town store doesn't read English fluently. The
employees can't use the product even if the founder loves it.

### B12. The repo has 50+ root-level audit `*.md` files
Not visible to merchants, but visible to engineers being recruited. The
optics of "this team writes audit reports more than it writes code" can
shape who is willing to join. (Recommendation: move them to `docs/archive/`
before the next engineering hire.)

## Net

ConfirmX has **uncommon depth in the engine** (risk, address, fraud,
courier-lane intelligence) and **shallow polish in the perimeter** (SMS
branding, IVR, customer-facing surfaces, in-product self-serve, support
visibility).

The reason that's a problem: merchants buy the perimeter and stay for the
engine. Today they will bounce off the perimeter before they see the engine.

The reason that's also an opportunity: every item on the HATE list is small.
The hardest one (BD-local IVR) is a 2-week build. The easiest five together
(SMS branding, send-test button, Bangla on tracking page, hide ComingSoon
stubs, status page link) are a single sprint. Ship them and the same product
moves from *"interesting beta"* to *"why isn't every BD merchant using this."*
