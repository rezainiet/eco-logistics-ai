# 03 — Soft-Launch Readiness

> Go / no-go gates. Each axis returns one of: **READY**, **PARTIAL**, **NOT READY**.

## TL;DR

> **Conditionally GO** for a private, limited soft launch (≤ 20 hand-picked
> merchants, signed feedback agreement, no public marketing) **once these
> four gates are closed:**
>
> 1. SMS migration is committed (or fully reverted).
> 2. `admin-rbac.ts.new` / `audit.ts.new` are removed or merged.
> 3. Voice/IVR UI is hidden or clearly labelled "closed beta".
> 4. Each onboarded merchant is told the data retention window and asked to
>    re-authorise Shopify with the new `read_customers_private_data` scope.
>
> **Do not** open a public Shopify App Store listing or run paid ads yet.

---

## Axis 1 — Deployment & infra: **READY (pending git hygiene)**

Evidence:
- `apps/api/src/env.ts` validates required envs (Zod) with strict types
  (JWT_SECRET ≥ 16 chars; `COURIER_ENC_KEY` 32-byte base64). Fail-fast in prod.
- `.env.example` is complete and accurate.
- `docker-compose.yml` is dev-only (no persistence volumes). Production uses
  managed MongoDB + Redis.
- `scripts/deploy-phase-c.sh` exists with typecheck gates, explicit file
  staging (never `git add -A`), and a rollback path.
- `.github/workflows/e2e.yml` runs `npm run build`, typecheck, and Playwright
  e2e on every PR/push. Pipeline is sound.
- Git log shows Phase C (`e91359d feat(shopify): Phase C — embedded bridge +
  auto-provision + integrity fixes`) and polish patches are already merged
  to `main`. `PHASE_D_PRECUTOVER_VERIFICATION.md` is stale on this point.

Gating:
- **Working tree is dirty.** ~12 modified files + ~10 untracked source files.
  None of this can ship until committed or reverted.
- No staging environment audited — confirm Railway / equivalent has a
  staging project with its own DB + Redis before promoting to prod.

## Axis 2 — Security: **READY (one cosmetic fix)**

Evidence (high points only — see `apps/api/src/server/auth.ts` for full):
- Access token TTL 1 h; refresh 14 d; **session rotation on refresh**
  (old `sid` revoked before new one issues) → captured refresh-token replay
  is detected.
- CSRF: double-submit cookie, `SameSite=strict`.
- Password reset / email verify: single-use hash tokens with TTL + consumed
  flag; safe against replay.
- Logout-all revokes all sessions for a merchant.
- Admin RBAC: three scopes (`super_admin`, `finance_admin`, `support_admin`)
  with permission dict, LRU-cached at 30 s TTL.
- Webhook HMAC verification: Stripe (raw body, returns 503 if secret unset),
  Shopify GDPR (constant-time `timingSafeEqual`), SMS DLR + inbound
  (`SMS_WEBHOOK_SHARED_SECRET`), courier webhooks (per-provider signature).
- Rate limiters via Redis: login, signup, password reset, webhook,
  public-tracking. Distributed across the fleet.
- Courier API keys encrypted at rest (AES-256-GCM, IV per message, auth tag).

Gating:
- **`admin-rbac.ts.new` has a duplicate `throw new TRPCError` near L147.**
  Delete the file or merge it. As of audit, the live `admin-rbac.ts` is clean
  — so this is a *housekeeping* gate, not a functional vulnerability.
- No 2FA / WebAuthn for merchant accounts. Acceptable for soft launch given
  the small merchant count; flag for v1.0.

## Axis 3 — Observability: **PARTIAL**

Evidence:
- `lib/observability/` has 5 feature-specific telemetry files
  (courier-webhook, delivery-reliability, external-delivery, fraud-network,
  lane-intelligence). Useful but localised.
- `lib/admin-alerts.ts` (9.8 KB, modified May 13) — admin-alerts pipeline is
  active.
- AuditLog model + admin search is the in-app trace.
- `SENTRY_DSN` is **optional** in env.ts. No active Sentry middleware found
  in `apps/api/src/index.ts`.
- No structured-JSON log emitter; calls to `console.error` are scattered.
- No distributed tracing.

Gating for soft launch:
- Set `SENTRY_DSN` for at least the API process; otherwise you'll be reading
  Railway logs by eye when something breaks at 2 AM.
- Watch BullMQ queue depth manually for the first 2 weeks.
- The two known cold-start issues called out in
  `STABILIZATION_QA_FINDINGS.md` (10 s KPI cold-load on `/dashboard`, 4 s
  on `/dashboard/billing`) are tolerable for a small private cohort but will
  embarrass at scale.

## Axis 4 — Data durability & integrity: **READY**

Evidence:
- Idempotency at every webhook: WebhookInbox unique index, Stripe
  `providerEventId` unique, SMS DLR filtered by current status, courier
  webhooks idempotent on hash(tracking, status, ts).
- **Outbox pattern**: PendingJob model + `pendingJobReplay` worker (cron ~30 s)
  drains any orphans back onto BullMQ.
- BullMQ defaults: 3 attempts, exponential backoff (5 s base),
  `removeOnComplete` 1000/24 h, `removeOnFail` 5000/7 d.
- Compound race-safe indexes on CustomerReliability + AddressReliability.
- TTL index on EmailEvent.

No major concerns. Backups are out of scope of this audit — verify they are
on for both Mongo and Redis (Redis is mostly cache, but BullMQ persistence
matters during outage windows).

## Axis 5 — Compliance: **READY for GDPR, MISSING for Bangladesh DPA**

Evidence:
- `apps/api/src/lib/gdpr/redaction.ts` implements
  `customers/data_request`, `customers/redact`, `shop/redact` with
  pseudonymisation across Order, CallLog, RecoveryTask, TrackingSession,
  WebhookInbox, AuditLog (meta-only).
- `apps/api/src/lib/retention/` + `customerDataRetention.worker.ts` runs
  daily, pseudonymising PII older than `CUSTOMER_DATA_RETENTION_DAYS`
  (default 365, configurable 30–3650).
- Shopify GDPR webhooks: HMAC-verified, constant-time compare.

Gating:
- **Bangladesh PDPA 2023** is invisible. `legal/privacy/page.tsx` does GDPR +
  CCPA boilerplate only.
- **No customer consent log** for SMS dispatch. A merchant cannot prove
  opt-in if challenged.
- **No SMS `Reply STOP` opt-out** wired. Inbound webhook routes confirmation
  replies only.
- **No DPA (Data Processing Addendum) surface** for merchants. Searching
  for "DPA" / "data.processor" returns nothing.

For a private soft launch this is acceptable if you sign a side-letter with
each merchant. For public launch in Bangladesh, the BD-DPA gap is real.

## Axis 6 — Performance & scale: **READY for ≤ 100 merchants**

Evidence:
- Projections (`.select()` + `.lean()`) used in hot read paths in `auth.ts`,
  `risk.ts`, public tracking.
- Worker concurrency is BullMQ default; for soft-launch volumes a single API
  instance per region is plenty.
- Two known cold-start latencies (`/dashboard` 10 s, `/dashboard/billing`
  4 s) — fix with Redis-backed analytics caching post-launch.

Beyond ~500 merchants you will need:
- Redis caching layer in front of analytics aggregations.
- Mongo sharding strategy on Order + TrackingEvent (high write rate).
- Worker concurrency tuning per queue.

## Axis 7 — Known in-flight work that gates deploy

Repeating from `02_UNFINISHED_WORK.md` for convenience:

| Item | Action |
|------|--------|
| SMS migration (Twilio removed, BulkSMSBD added) — uncommitted | Commit as atomic PR or revert |
| `lib/voice/` directory untracked, Twilio is demo-only | Hide IVR UI or label closed-beta |
| `admin-rbac.ts.new`, `audit.ts.new` siblings | Merge or delete |
| Embedded Shopify app — CSP still blocks | Either flip CSP + ship Phase D, or hide `/embedded/` route |
| `dashboard/settings/notifications` + `team` are `<ComingSoon />` | Either implement minimum viable, or remove navigation entries |

## Axis 8 — Things to verify the day before launch

A checklist phrased as commands:

```sh
# 1. Working tree clean?
git status --short

# 2. Required envs present in prod?
grep -E "^(JWT_SECRET|COURIER_ENC_KEY|MONGODB_URI|REDIS_URL|SHOPIFY_API_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SMS_WEBHOOK_SHARED_SECRET|SSL_WIRELESS_SID)" .env.production

# 3. CI green on the deploy SHA?
gh run list --branch main --limit 5

# 4. /ready returns 200 (Mongo + Redis ok)?
curl -fsS https://api.<your-domain>/ready

# 5. Stripe webhook secret matches the live endpoint?
stripe listen --print-secret  # vs prod env

# 6. Backups (Mongo) ran in last 24 h?
# (verify in your provider console)

# 7. Sentry DSN is set + an event has landed?
# trigger a deliberate test error and confirm in Sentry UI

# 8. Worker queue depth at 0?
# inspect via admin observability page
```

## Verdict

| Axis | Verdict | Soft-launch gate |
|------|---------|------------------|
| Deployment / infra | READY | Working tree must be clean |
| Security | READY | Remove `.new` files |
| Observability | PARTIAL | Set Sentry DSN before opening to merchants |
| Data durability | READY | — |
| Compliance | PARTIAL | Side-letter merchants; flag BD-DPA gap |
| Performance | READY (≤100 merchants) | Watch cold-start, add caching post-launch |
| In-flight work | NOT READY until SMS PR closed | Commit or revert; hide voice UI |

**Recommendation:** soft-launch with 5–10 design-partner merchants, all
hand-onboarded by you, with a documented expectation that they are getting
the product *before* it is feature-complete in exchange for input. Do not
list publicly in the Shopify App Store yet. Do not advertise IVR until the
BD-local provider is integrated.
