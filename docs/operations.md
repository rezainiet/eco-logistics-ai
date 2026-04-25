# Operations runbook

Production playbook for the Logistics platform. Pair with the [README](../README.md) for setup; this file is the on-call reference.

## At a glance

| Surface | Where it lives | First place to look |
| --- | --- | --- |
| API | `apps/api` (Express + tRPC, port 4000) | `[api]` lines in stdout, `/health` |
| Web | `apps/web` (Next.js, port 3000) | Next.js stdout, `/_next/data` 5xx rate |
| Workers | Embedded in `apps/api` boot | `[trial-reminder]` / `[webhook-retry]` / `[commerce-import]` log prefixes |
| MongoDB | docker-compose (dev) / replica set (prod) | `mongosh` then `rs.status()` |
| Redis | docker-compose (dev) / managed Redis (prod) | `redis-cli ping` |
| Stripe | webhooks → `/api/webhooks/stripe` | Stripe Dashboard → Developers → Webhooks |
| Email | Resend HTTP API | Resend Dashboard → Logs |
| Errors | Sentry envelope endpoint (server + browser) | Sentry project page (project `ecom-logistics`) |

## Deploy checklist

1. Roll the API + web container.
2. Run `npm run db:sync-indexes` once against the production database (autoIndex is **off** in production — see `apps/api/src/lib/db.ts`). Safe to re-run; idempotent.
3. Verify `/health` returns 200 from the API.
4. Tail the API logs for `[boot] env=production port=4000 telemetry=on`. If `telemetry=off` and you expected Sentry capture, double-check `SENTRY_DSN`.
5. Smoke-test signup → trial → email verify in production.

## Required production env

Beyond the README:

| Var | Why |
| --- | --- |
| `REDIS_URL` | Workers refuse to start without it; queues are the backbone of webhook retry, cart recovery, trial reminder. |
| `ADMIN_SECRET` | Gate for `/admin/*` endpoints. 24+ chars. |
| `COURIER_ENC_KEY` | AES-256 key for at-rest courier credentials. Base64 of 32 bytes (`openssl rand -base64 32`). Rotate quarterly. |
| `STRIPE_SECRET_KEY` | Live secret key — `sk_live_…`. |
| `STRIPE_WEBHOOK_SECRET` | Per-endpoint webhook secret from Stripe → Developers → Webhooks. **Without it, the webhook returns 503**. |
| `RESEND_API_KEY` | Transactional email. Without it, emails are logged to stdout. |
| `EMAIL_FROM` | e.g. `Logistics <onboarding@your-domain.com>`. Domain must be Resend-verified. |
| `SENTRY_DSN` (server) / `NEXT_PUBLIC_SENTRY_DSN` (web) | Error capture; safe to omit (no-op). |
| `PUBLIC_API_URL` / `PUBLIC_WEB_URL` | Used in webhook URLs, OAuth redirects, email links. Must be HTTPS. |

## Backups (MongoDB)

We keep two backup tracks:

1. **Daily archive (cron)** — `scripts/backup-mongo.sh` runs `mongodump --archive --gzip` and optionally uploads the file to S3. Local retention is `BACKUP_RETENTION_DAYS` (default 14). Wire it into cron on the host or a backup VM:

   ```cron
   # Daily 03:15 UTC mongodump → S3
   15 3 * * *  MONGODB_URI=… BACKUP_DIR=/var/backups/ecom \
              BACKUP_S3_URI=s3://my-bucket/ecom/ \
              /opt/ecom/scripts/backup-mongo.sh \
              >> /var/log/ecom-backup.log 2>&1
   ```

2. **Replica set** — production runs Mongo as a 3-node replica set. Reads can be served from secondaries; primary failure auto-fails-over. (Compose file with replica-set bootstrap is intentionally not committed — provision via the cloud provider.)

### Restore drill

```bash
# Pull the latest archive
aws s3 cp s3://my-bucket/ecom/ecom-mongo-20260425T031500Z.archive.gz ./

# Restore into a sandbox cluster first; never restore directly over prod.
mongorestore \
  --uri="mongodb+srv://restore-user@sandbox-cluster/?authSource=admin" \
  --archive=ecom-mongo-20260425T031500Z.archive.gz \
  --gzip \
  --drop
```

Run the restore drill **once a quarter** to keep the muscle memory and verify the archive is readable.

## On-call playbook

### Webhook retry queue is growing

1. Check `[webhook-retry]` log lines — they print picked / succeeded / dlq counts every minute.
2. Open the integrations dashboard for an affected merchant; click "Inspect" on a failed webhook to see the upstream error.
3. If it's a permanent failure (signature mismatch, malformed payload), use the dashboard "Replay" button with caution — repeated failures hit the dead-letter cap (5 attempts) and fire a `integration.webhook_failed` Notification.

### Stripe webhook returning 503

`STRIPE_WEBHOOK_SECRET` is unset. Stripe will retry for 3 days, but new sign-ups can't auto-activate. Set the env var, restart, and replay events from the Stripe Dashboard.

### Trial reminder emails not sending

1. `[trial-reminder]` worker logs `scanned=N sent=N skipped=N` whenever it picks up rows.
2. If `sent=0` while merchants exist with `trialEndsAt` in the next 3 days: check `RESEND_API_KEY`. The worker still claims the row (so re-sweeps don't double-fire), but `sendEmail` is a no-op without the key.

## Stripe Subscriptions

Recurring billing runs as monthly Stripe Subscriptions. The legacy one-shot
`mode=payment` Checkout flow stays around for annual renewals and ad-hoc
upgrades; both flows feed the same `Payment` history.

### One-time setup

1. Run `STRIPE_SECRET_KEY=sk_… npm --workspace @ecom/api run stripe:seed`. It
   provisions one Product + monthly Price per plan tier and prints
   `STRIPE_PRICE_<TIER>=…` lines. Re-running is idempotent.
2. Paste those into the API's `.env`. Without them, `createSubscriptionCheckout`
   returns `FAILED_PRECONDITION`.
3. Configure the **Customer Portal** in the Stripe Dashboard
   (`Settings → Billing → Customer portal`):
   - Enable cancellation, payment-method update, and plan switching.
   - List the four products you seeded under "Products and prices".
   - Set the return URL to `${PUBLIC_WEB_URL}/dashboard/billing`.
   - Save. (Stripe doesn't expose this configuration through the API yet —
     it has to be done by hand once per Stripe account.)
4. Add a webhook endpoint at `${PUBLIC_API_URL}/api/webhooks/stripe`
   subscribed to: `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_succeeded`, `invoice.payment_failed`. Copy the signing
   secret into `STRIPE_WEBHOOK_SECRET`.

### State machine

```
trial ──► active ──► past_due (grace) ──► suspended
                          │                    │
                          ▼                    ▼
                       active              cancelled
                  (invoice.paid)       (sub.deleted)
```

- `invoice.payment_failed` → `past_due` + `gracePeriodEndsAt = now + STRIPE_GRACE_DAYS` (7d default).
- The `subscription-grace` worker (hourly) flips `past_due` → `suspended` once the deadline passes.
- A subsequent `invoice.payment_succeeded` flips back to `active` and clears the grace deadline.
- `customer.subscription.deleted` (or `status=canceled`) → `cancelled`.

### Stuck-state recovery

If a merchant is stuck in `past_due` and you've manually verified payment in
Stripe, use the admin tool to extend their period: `adminBilling.extendSubscription`
(merchantId, days). This is also the path for goodwill credits.

### Subscription stuck in `pending` after Stripe success

1. Check Stripe Dashboard for the event and verify the `metadata.merchantId` / `metadata.paymentId` are present.
2. Check API logs for `payment_row_not_found` or `merchant_missing` — those mean the metadata is wrong (typically the `payment` row was deleted between checkout-session creation and webhook delivery).
3. Manual recovery: open `/admin/billing` → find the pending payment → "Approve" — same end state.

### Reset the test database

The MongoDB Memory Server we use in tests is sandboxed; if a developer's local DB is wedged: `docker compose down -v && docker compose up -d`.

## Incident severity

| Sev | Examples | Response |
| --- | --- | --- |
| 1 | API 5xx > 5% for 5 min, Mongo primary down | Page on-call, post in #ops, declare incident |
| 2 | Stripe webhook 401 sustained, queue depth > 10K, 1 region down | Investigate within 15 min |
| 3 | Email send failures, single-tenant errors, single courier flaky | Investigate within working hours |

Each incident gets a brief post-mortem in the #incidents channel within 48h.
