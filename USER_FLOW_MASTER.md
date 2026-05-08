# USER FLOW MASTER

End-to-end user journeys grounded in real code. Every flow lists states,
transitions, the backend procedures it triggers, the queues it touches, and
the failure + recovery paths.

---

## 1. Merchant signup → first order ingested

```
[anon] ─► /signup ──► POST /auth/signup (REST)
                        │
                        ├─► Merchant.create (subscription.status=trial,
                        │                   trialEndsAt = now + TRIAL_DAYS)
                        ├─► AuditLog.action = merchant.signup
                        ├─► email verification token minted (single-use, expiresAt)
                        └─► Resend.send(VerificationEmail) [fire-and-forget]
                        │
[unverified] ◄──────────┘
        │
        │ click email link ─► /verify-email?token=...
        │
        ▼
POST /auth/verify-email ─► consume token (set consumedAt) ─► emailVerified=true
        │
        ▼
[merchant signed in] ─► /dashboard ─► NewMerchantRedirect ─► /dashboard/getting-started
        │
        ▼
Step 1: Connect store
  ─► /dashboard/integrations ─► tRPC integrations.connect
     ─► Shopify OAuth round-trip ────────► Integration.status=connected
                                      │
                                      └─► auto webhook subscribe (orders/create, orders/updated, app/uninstalled)
        │
        ▼
Step 2: Import sample orders
  ─► tRPC integrations.importOrders ─► ImportJob row + safeEnqueue(commerceImport)
     ─► commerceImport worker ─► fetchSampleOrders ─► per-order ingestNormalizedOrder
        │
        ▼
Step 3: Add courier
  ─► /dashboard/settings (couriers tab) ─► tRPC merchants.upsertCourier
     ─► encrypt credentials (v1:iv:tag:ct AES-256-GCM)
     ─► validate (testCredentials) ─► lastValidatedAt stamped
        │
        ▼
Step 4: Enable automation
  ─► /dashboard/settings (automation tab) ─► tRPC merchants.updateAutomationConfig
     ─► automationConfig.enabled=true, mode=manual|semi_auto|full_auto
        │
        ▼
Step 5: Test SMS (test order via dashboard or webhook arrives)
```

States:
- Merchant: `trial` (default 14 days)
- Integration: `pending → connected`
- Order: enters at `automation.state ∈ {auto_confirmed, pending_confirmation, requires_review}`

Failures:
- Email send fails → onboarding still completes; merchant can request resend.
- OAuth redirect mismatch → `state` cookie verification rejects; merchant retries.
- Courier validation fails → row remains; `validationError` surfaced in UI.
- ImportJob fails mid-stream → row marked `failed` with `lastError`; partial import retained.

Recovery:
- Resend verification (`/verify-email-sent` page).
- Reconnect Shopify (re-OAuth).
- Re-validate courier credentials.
- Manual re-import from `/dashboard/integrations/issues`.

---

## 2. Customer places order on merchant storefront → webhook → ingest

```
[customer]
   │ adds items to cart   ──► JS SDK ──► POST /track ──► TrackingEvent + TrackingSession
   │ checkout submit
   │
   ▼
Shopify ──► POST /api/integrations/webhook/shopify (raw body)
   │
   ▼
webhookLimiter ─► HMAC verify (x-shopify-hmac-sha256)
                                       │
                  invalid? ─► 401      │ valid
                                       ▼
   ┌─ freshness gate: x-shopify-triggered-at within 5 min ─► proceed
   │                                          stale ─► 401
   ▼
WebhookInbox.create({ merchantId, provider:"shopify", externalId: x-shopify-webhook-id })
   │
   E11000? ─► return prior row's resolvedOrderId (200, duplicate=true)
   │
   ▼
safeEnqueue(QUEUE_NAMES.webhookProcess, { inboxId })
   │
   ▼ (async)
webhookProcess worker ─► replayWebhookInbox(inboxId) ─► ingestNormalizedOrder(payload, ctx)
   │
   ▼
1. phone canonicalize (E.164)
2. address normalize + extractThana (env-gated)
3. duplicate guard: Order.findOne((merchantId, source.externalId))
4. reserveQuota(merchantId, "ordersCreated")
5. computeAddressQuality (env-gated, observation-only)
6. computeRisk(order, merchantConfig, history, networkSignal)
   ├─► reads cross-merchant FraudSignal (FRAUD_NETWORK_ENABLED)
   └─► outputs riskScore, level, signals[], reasons[], pRto
7. Order.create (in tx) ─► post-save: MerchantStats $inc (in same session)
8. FraudPrediction.create (best-effort)
9. Integration.counts.ordersImported $inc
10. identityResolution(order) (fire-and-forget) ─► TrackingSession.resolvedOrderId
11. scoreIntentForOrder(order) (fire-and-forget, env-gated) ─► Order.intent
12. automation engine decision based on Merchant.automationConfig
   ├─► full_auto + low risk + score ≤ threshold ─► auto_confirmed + safeEnqueue(automationBook)
   ├─► semi_auto + low risk ─► auto_confirmed
   ├─► medium ─► pending_confirmation + safeEnqueue(automationSms)
   └─► high ─► requires_review (fraud queue)
   │
   ▼
WebhookInbox.status=succeeded; resolvedOrderId stamped
```

States:
- WebhookInbox: `received → processing → succeeded` (or `failed → received` retry, or `needs_attention` for missing-phone)
- Order automation: `not_evaluated → {auto_confirmed | pending_confirmation | requires_review}`
- Order fraud: `not_required | optional_review | pending_call`

Failures:
- HMAC mismatch → 401, no inbox row.
- Phone missing → `needs_attention`, merchant alert via `integration.webhook_needs_attention`.
- Quota exhausted → release, `needs_attention` with reason.
- Transient (DB blip) → `failed` + `nextRetryAt`; webhookRetry sweep retries.

Recovery:
- `/dashboard/integrations/issues` — manual replay.
- `pendingJobReplay` — automatic replay if Redis was the failure point.
- `orderSync` polling fallback — re-fetches if webhook was never delivered.

---

## 3. Order auto-confirm → auto-book (full_auto path)

```
[Order.automation.state=auto_confirmed, autoBookEnabled=true]
   │
   ▼
safeEnqueue(automationBook, { orderId, attempt: 0 })
   │
   ▼
automationBook worker
   ├─► verify status ∈ {pending, confirmed, packed} (else: no-op success)
   ├─► selectBestCourier(merchantId, district, candidates, pinnedCourier?)
   │      ├─► reads CourierPerformance per-district + _GLOBAL_ fallback
   │      ├─► applies recent-failure penalty (rolling 1h)
   │      └─► returns ranked list
   │
   ▼
bookSingleShipment(order, courier)
   ├─► acquire lock: findOneAndUpdate({_id, version, bookingInFlight!=true},
   │                                  {$set:{bookingInFlight:true, bookingLockedAt}})
   │      ├─► null? (lock held / version mismatch) ─► skip silently
   │      └─► acquired
   ├─► PendingAwb.create({ orderId, attempt, idempotencyKey: sha256(orderId:attempt) })
   ├─► courier.createAWB(order, idempotencyKey: sent as upstream header)
   │      ├─► upstream success? ─► return AWB
   │      └─► upstream failure  ─► throw
   │
   success path:
   ├─► Order: trackingNumber, courier, shippedAt, bookingInFlight=false (CAS via version)
   │   automation: selectedCourier, selectionReason, bookedByAutomation=true
   ├─► PendingAwb.status=succeeded
   └─► AuditLog: order.booked
   │
   failure path:
   ├─► PendingAwb.status=failed, lastError captured
   ├─► Order.bookingInFlight=false (release)
   ├─► recordCourierBookFailure → recent-failure window bumped
   ├─► attempt < MAX_ATTEMPTED_COURIERS=3?
   │      ├─► yes: enqueue fallback with next-best courier, attempt+1
   │      └─► no:  emit critical Notification (automation.watchdog_exhausted)
   │
   crash path (process dies after upstream call):
   └─► PendingAwb stays pending; awbReconcile (60s cron) sweeps:
        ├─► Order has trackingNumber? ─► PendingAwb=succeeded (catchup)
        ├─► no, attempts < 5 ─► retry next sweep
        └─► no, exhausted    ─► PendingAwb=abandoned; release booking lock
```

---

## 4. Order pending_confirmation → SMS + customer reply → confirm

```
[Order.automation.state=pending_confirmation]
   │
   ▼
safeEnqueue(automationSms, { orderId }, jobId="auto-sms:{orderId}")
   │
   ▼
automationSms worker
   ├─► verify state still pending_confirmation
   ├─► sendOrderConfirmationSms (SSL Wireless)
   ├─► success: Order.automation.{confirmationSentAt, confirmationChannel="sms"}
   └─► failure: throw → BullMQ retry (5 attempts, 15s exp backoff)
   │
   ▼
[customer replies "YES <code>"]
   │
   ▼
SSL Wireless POST /api/webhooks/sms-inbound
   │
   ├─► HMAC verify (SMS_WEBHOOK_SHARED_SECRET)
   ├─► parse body, extract code
   ├─► Order.findOne({automation.confirmationCode: code, status: pending})
   │
   match within window:
   ├─► automation.state=confirmed, decidedBy=merchant, confirmedAt=now
   ├─► automation.confirmationDeliveryStatus=delivered (DLR may also stamp)
   ├─► full_auto? safeEnqueue(automationBook)
   └─► AuditLog: automation.confirmed_via_sms
   │
   late reply (past 72h auto-cancel window):
   ├─► automation.lateReplyAcknowledgedAt set (once-per-order guard)
   └─► reply with courtesy "order expired" SMS
   │
   ▼
[no reply]
   │
   ▼
automationStale (cron 1h)
   ├─► 24h stale: Notification (automation.stale_pending) + fraud.reviewStatus=pending_call
   └─► 72h stale: order.status=cancelled, automation.state=rejected, fraud.smsFeedback=no_reply
```

States touched:
- `Order.automation.state`: `pending_confirmation → confirmed | rejected`
- `Order.automation.confirmationDeliveryStatus`: `pending → delivered | failed | unknown`
- `Order.fraud.reviewStatus`: `not_required → pending_call` (24h escalation)
- `Order.order.status`: `pending → cancelled` (72h escalation)

---

## 5. Fraud review (manual)

```
[Merchant browses /dashboard/fraud-review]
   │
   ▼
tRPC fraud.listPendingReviews
   ├─► query: (merchantId, fraud.reviewStatus=pending_call)
   ├─► sort: (fraud.riskScore desc, _id desc) — uses dedicated index
   └─► returns paginated rows + signals breakdown
   │
   ▼
[Merchant clicks Reject on an order]
   │
   ▼
tRPC fraud.markRejected(orderId, note)
   ├─► loadOrder(version)
   ├─► buildPreActionSnapshot(order, "reject")
   │      ├─► strips automation metadata fields
   │      └─► returns {order, automation, fraud} pre-state
   ├─► Order.findOneAndUpdate({_id, version}, {
   │      $set: { preActionSnapshot, order.status: "cancelled",
   │              automation.state: "rejected", fraud.reviewStatus: "rejected",
   │              fraud.preRejectReviewStatus: priorReviewStatus,
   │              fraud.preRejectLevel: priorLevel },
   │      $inc: { version: 1 }
   │   })
   ├─► AuditLog: fraud.rejected
   ├─► contributeOutcome(phoneHash, addressHash, "rto") (cross-merchant network, env-gated)
   └─► safeEnqueue(risk, "rescore", { phone, merchantId }) — fan out to phone cohort
   │
   ▼
[Merchant later realizes mistake → clicks Restore]
   │
   ▼
tRPC orders.restore(orderId)
   ├─► loadOrder(version + preActionSnapshot)
   ├─► Order.findOneAndUpdate({_id, version}, {
   │      $set: { order.status: snapshot.order.status,
   │              automation.state: snapshot.automation.state,
   │              automation.<subdocFields>: snapshot.automation.subdoc,
   │              fraud.reviewStatus: snapshot.fraud.reviewStatus,
   │              fraud.level: snapshot.fraud.level },
   │      $unset: { preActionSnapshot: "" },
   │      $inc: { version: 1 }
   │   })
   └─► AuditLog: order.restored
```

Idempotency: CAS via `version`. A second restore attempt finds no `preActionSnapshot` (already cleared) → returns "nothing to restore".

---

## 6. Tracking outcome → fraud rescore fan-out

```
[Courier marks shipment delivered or RTO]
   │
   ▼
EITHER courier webhook (push, sub-second):
   POST /api/webhooks/courier/{merchantId}/{provider}
   ├─► HMAC verify per-courier
   ├─► append to Order.logistics.trackingEvents (sliced -100)
   ├─► dedupe via SHA1(trackingCode + providerStatus + timestamp)
   └─► if normalizedStatus ∈ {rto, cancelled, delivered}: terminal handling
OR trackingSync poll (cron, fallback):
   ├─► picks orders with stale lastPolledAt
   ├─► same write path
   └─► same terminal handling
   │
   ▼
on terminal status:
   ├─► Order.logistics.{deliveredAt or returnedAt} stamped
   ├─► recordCourierOutcome(merchantId, courier, district, outcome, deliveryHours)
   │      └─► CourierPerformance per-district + _GLOBAL_ counters
   ├─► contributeOutcome(phoneHash, addressHash, outcome) (cross-merchant network)
   ├─► FraudPrediction.outcome stamped (feeds monthly weight tuning)
   └─► enqueueRescore({merchantId, phone, trigger: "tracking_outcome"})
   │
   ▼
riskRecompute worker (jobId=merchantId:phone:trigger:10sBucket)
   ├─► load all open Orders for (merchantId, phone)
   ├─► computeRisk per order
   ├─► update Order.fraud.{riskScore, level, reasons, signals, scoredAt}
   ├─► never override terminal review (verified | rejected)
   └─► first elevation to HIGH? → Notification (fraud.rescored_high)
```

---

## 7. Stripe subscription billing

```
[Merchant clicks Upgrade plan on /dashboard/billing]
   │
   ▼
tRPC billing.createSubscriptionCheckout(plan)
   ├─► resolve STRIPE_PRICE_<plan> from env
   ├─► stripe.checkout.sessions.create({mode:"subscription", success_url, cancel_url})
   └─► return URL
   │
   ▼
[merchant redirected to Stripe Checkout, completes payment]
   │
   ▼
Stripe POST /api/webhooks/stripe (event: checkout.session.completed)
   ├─► verify with constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET)
   ├─► Payment.create({providerEventId, providerSessionId, status:"approved"})
   │      └─► partial-unique on providerEventId catches replays
   └─► Merchant.{stripeCustomerId, stripeSubscriptionId, subscription.status="active"}
   │
   ▼
[recurring invoices]
Stripe POST /api/webhooks/stripe (event: invoice.payment_succeeded)
   ├─► Payment.create({invoiceId, ...}) — partial-unique on invoiceId
   ├─► Merchant.subscription.{currentPeriodEnd advanced, gracePeriodEndsAt cleared}
   └─► entitlements re-cached
   │
[invoice fails]
Stripe POST /api/webhooks/stripe (event: invoice.payment_failed)
   ├─► Merchant.subscription.{status: "past_due", gracePeriodEndsAt: now + STRIPE_GRACE_DAYS}
   └─► Notification (subscription.payment_failed)
   │
   ▼ (cron 1h)
subscriptionGrace worker
   ├─► targets (status=past_due AND gracePeriodEndsAt<=now)
   ├─► flips status=suspended atomically
   └─► sends suspended email
   │
[merchant updates card → next invoice succeeds]
   ├─► subscription.status flips back to active
   └─► gracePeriodEndsAt cleared
```

States:
- `Merchant.subscription.status`: `trial → active → past_due → suspended → active` (round-trip)

---

## 8. Manual payment (BD: bKash / Nagad / bank)

```
[Merchant on /dashboard/billing, picks plan + Bangladesh rail]
   │
   ▼
tRPC billing.uploadPaymentProof (mutation)
   ├─► validates file (size cap, MIME guard)
   ├─► returns proof handle
   │
tRPC billing.submitManualPayment({plan, amount, txnId, senderPhone, proofHandle, clientRequestId})
   ├─► Payment.create({
   │      method:"bkash"|"nagad"|"bank_transfer",
   │      status:"pending", clientRequestId (partial-unique),
   │      proofFile: {data, contentType, sizeBytes, filename, uploadedAt},
   │      txnIdNorm, proofHash, metadataHash, riskScore, riskReasons[], requiresDualApproval
   │   })
   │      └─► clientRequestId partial-unique catches double-click
   ├─► Notification (billing.proof_submitted) to admin
   └─► AuditLog: payment.submitted
   │
[admin opens /admin/billing]
   │
   ▼
tRPC adminBilling.list(status="pending")
   │
   ▼
[finance_admin clicks Approve (riskScore < 60)]
   │
   ▼
tRPC adminBilling.approve(paymentId)
   ├─► step-up token check (5-min TTL)
   ├─► Payment.status="approved", reviewerId, reviewedAt
   ├─► Merchant.subscription.{status:"active", currentPeriodEnd, billingProvider:"manual"}
   ├─► AuditLog: payment.approved
   └─► Notification (subscription.activated) to merchant
   │
[high-risk path (riskScore ≥ 60)]
   │
   ▼
adminBilling.markReviewed (4-eyes first stage)
   ├─► Payment.firstApprovalBy, firstApprovalAt, firstApprovalNote
   │
adminBilling.approve (second admin, distinct from first)
   ├─► distinct-user check enforced
   └─► same activation path as above
```

---

## 9. Cart recovery flow

```
[customer adds items but doesn't check out]
   │
   ▼
JS SDK fires: add_to_cart, page_view... (no checkout_submit)
   ├─► TrackingEvent rows
   └─► TrackingSession upsert (abandonedCart=true if ≥2 add_to_cart no checkout)
   │
   ▼ (cron 5m)
cartRecovery worker
   ├─► query: (abandonedCart=true, converted=false, phone OR email known,
   │           lastSeenAt > 30min, lastSeenAt < 7d, no resolvedOrderId,
   │           no later converted session for same identity)
   ├─► RecoveryTask.upsert({merchantId, sessionId}, $setOnInsert: {...})
   │      └─► one task per session; agent state never overwritten on re-runs
   └─► Notification (recovery.cart_pending) to merchant (one per day-bucket)
   │
   ▼
[merchant on /dashboard/recovery]
   │
   ├─► tRPC recovery.list (paginated by status + abandonedAt)
   ├─► tRPC recovery.markContacted(taskId, channel="call"|"sms"|"email")
   ├─► tRPC recovery.markRecovered(taskId, orderId) (links to converted Order)
   └─► tRPC recovery.markDismissed(taskId, note)
```

Lifecycle: `pending → contacted → recovered | dismissed | expired`. Expired sweep removes tasks past their window.

---

## 10. Admin step-up flow

```
[admin signed in]
   │
   ▼
[admin attempts a destructive action — e.g. force-suspend a merchant]
   │
   ▼
scopedAdminProcedure detects "step-up required"
   ├─► returns FORBIDDEN with code="STEPUP_REQUIRED"
   └─► UI opens step-up dialog
   │
   ▼
tRPC adminAccess.requestStepUp(action, reason)
   ├─► mint 32-byte token, hash, store with 5-min TTL + permission scope
   ├─► AuditLog: admin.stepup_requested
   └─► return token (plaintext)
   │
   ▼
[admin retries action with x-stepup-token header]
   ├─► verify token: not consumed, not expired, scope matches
   ├─► mark consumed (single-use)
   ├─► AuditLog: admin.stepup_consumed
   └─► proceed with action
```

Verbatim from `lib/admin-stepup.ts` design intent: tokens are scoped to a *specific permission*, not a session-level "I'm sure". A token minted for "approve_payment" cannot be used to "change_plan".

---

## 11. Public tracking page (customer)

```
[customer follows tracking link]
   │
   ▼
GET /track/{code} (Next.js server component)
   ├─► resolve code → Order (no auth; sparse-unique on tracking number)
   ├─► load Merchant.branding (display name, logo, primaryColor, supportPhone, supportEmail)
   ├─► load tracked timeline: Order.logistics.trackingEvents (sliced -N)
   └─► render branded page (no PII, no internal fields)
```

Surfaces:
- Estimated delivery, current status (normalized), event timeline.
- Branded header (merchant logo + color).
- Support contact CTA (per-merchant phone/email).

---

## 12. Operational recovery (admin)

```
[on-call admin opens /admin/system]
   │
   ▼
adminObservability.snapshot
   ├─► BullMQ counts per queue (waiting/active/completed/failed/delayed/paused)
   ├─► snapshotEnqueueCounters() (failures, retryRecovered, deadLettered, replayed, exhausted)
   ├─► WebhookInbox failures (recent failed/needs_attention)
   ├─► PendingJob backlog
   └─► Anomaly stream (last 24h alerts)
   │
   ▼
[admin clicks "Replay PendingJob" on row]
   │
   ▼
tRPC adminObservability.forceReplay(pendingJobId)
   ├─► step-up gate
   ├─► reset row to status=pending, nextAttemptAt=now
   └─► next sweeper tick replays it
```

All admin remediation flows write `AuditLog` rows; tamper chain protects against retroactive log clean-up.

---

## 13. Failure-state matrix (cross-flow)

| Failure                                     | Symptom                                      | Recovery surface                                          |
| ------------------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Webhook with bad HMAC                       | 401 returned to upstream                     | Merchant fixes credentials; upstream replays               |
| Webhook with missing phone                  | `WebhookInbox.needs_attention`               | `/dashboard/integrations/issues` manual replay             |
| Order create double-click                   | `(merchantId, clientRequestId)` collide      | UI gets the prior `Order` reference                        |
| Stripe webhook delivered twice              | `Payment.providerEventId` collide            | second insert ignored                                      |
| BullMQ enqueue fails (Redis blip)           | `safeEnqueue` retries 3× (50/200/500 ms)     | recovers transparently                                     |
| BullMQ enqueue fails (Redis down)           | `PendingJob` row + merchant alert            | `pendingJobReplay` drains when Redis returns               |
| BullMQ enqueue fails (Mongo also down)      | `ok: false`                                  | merchant alert + ops page                                  |
| Booking call crashes mid-flight             | `PendingAwb` left pending + `bookingInFlight`| `awbReconcile` releases lock at 90s                        |
| Trial expires without payment               | `trialEndsAt < now AND status=trial`         | Merchant gets warning email at TRIAL_WARNING_DAYS         |
| Stripe invoice fails                        | `subscription.status=past_due`               | grace period → `subscriptionGrace` flips suspended         |
| Customer doesn't reply to confirmation SMS  | `automation.state=pending_confirmation` stale| `automationStale` 24h notify, 72h auto-cancel              |
| Wrong reject decision                       | merchant cancelled by mistake                | `restoreOrder` reverses via `preActionSnapshot`            |
| Webhook delivery silently breaks            | new orders missing                           | `orderSync` re-discovers from cursor                       |
| Tracking poll misses events                 | stale `lastPolledAt`                         | next poll catches up; events idempotent via `dedupeKey`    |

Every recovery path above is real code. None require human intervention beyond the explicitly-merchant-facing replay surfaces.
