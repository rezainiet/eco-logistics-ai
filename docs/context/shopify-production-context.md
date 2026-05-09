# Shopify production context — canonical session brief

**Last consolidated:** 2026-05-09 from `shopify-app-distribution.md`,
`shopify-listing-wording.md`, `shopify-go-live-checklist.md`,
`audits/final-production-readiness-report.md`. Source docs are
preserved verbatim — this file is the compact entry point future
sessions read first.

This document captures only what is **non-derivable from code**:
positioning constraints, deployment assumptions, rollout stage, and
the residual gaps blocking Shopify submission. Architecture lives in
`audits/architecture-inventory.md`; per-flag rollout sequencing lives
in `audits/delivery-reliability-rollout-runbook.md`.

---

## 1. Positioning constraint (review-critical)

**ConfirmX = COD operational intelligence + order confirmation
infrastructure for Bangladesh-based Shopify merchants.**

Frame every merchant-facing surface as:
- "Confirm every COD order before it ships"
- "Operator decides; ConfirmX surfaces signals"
- "Audit-logged, threshold-tunable, replay-safe"

NEVER frame as: AI fraud detector, autonomous blocking, customer
surveillance, predictive behavioural AI, fraud accusation. These
phrasings fail Shopify review. Audited 2026-05-09 — see
`packages/branding/src/defaults.ts` doc-comment for the canonical
list.

## 2. Distribution decision

**Public Distribution / Unlisted** (Partner Dashboard → Distribution
→ Update). Chosen over Custom (can't onboard merchants outside the
Partner org) and over App Store Listed (full marketing review +
revenue share). Unlisted gives:
- One-click install for any merchant via direct link
- Technical-only review (HMAC, GDPR webhooks, billing if used)
- No App Store revenue share when billing happens off-platform
  (Stripe + manual bKash/Nagad — our current rails)
- ~3–7 day first review

Path is **largely one-way**: flipping back to Custom would lose every
merchant install. Treat as a serious cutover, not a soft launch
(`shopify-go-live-checklist.md §9`).

## 3. Architecture summary (one paragraph)

Monorepo (npm workspaces): `apps/api` is Express + tRPC + 16 BullMQ
workers on Mongo + Redis (port 4000); `apps/web` is Next.js 14 App
Router with NextAuth + tRPC client (port 3001). Shopify enters via
`/api/integrations/oauth/shopify/callback` (OAuth) and
`/api/integrations/webhook/shopify/:integrationId` (per-merchant
webhooks). All webhook surfaces verify HMAC over raw body, freshness
gate (5min), and dedupe via `WebhookInbox` unique
`(merchantId, provider, externalId)`. Outbound HTTP goes through
SSRF-safe `safeFetch`. Per-merchant access tokens are
AES-256-GCM-encrypted at rest with `COURIER_ENC_KEY`. Index sync runs
fire-and-forget at boot, plus an out-of-band CLI and admin endpoint.
Graceful shutdown sequence preserves in-flight webhooks before SIGKILL.

## 4. Production infra assumptions

| Assumption | Value | Source |
|---|---|---|
| Hosting | Railway (api + web as separate services) | `shopify-go-live-checklist.md §1–2` |
| Mongo | Replica-set capable, `autoIndex: false` | `apps/api/src/lib/db.ts:14` |
| Redis | Required in production (env-validated) | `env.ts` `.refine()` |
| Public hosts | `app.confirmx.ai` (web), `api.confirmx.ai` (api) | `shopify.app.toml`, `.env.example` |
| TLS | Terminated at Railway edge proxy | `TRUSTED_PROXIES` parser in `index.ts:82` |
| Trust-proxy | `TRUSTED_PROXIES` env (CIDR/keyword/int) | `apps/api/src/index.ts:254` |
| CORS | Single allowed origin = `PUBLIC_WEB_URL` | `env.ts` CORS_ORIGIN, trailing-slash strip |
| Health | `GET /health → {ok:true}` (liveness only) | `apps/api/src/index.ts:283` |
| Workers | All 16 wired in `index.ts` boot, registered behind `if (env.REDIS_URL)` | `apps/api/CLAUDE.md` worker checklist |
| Graceful shutdown | server.close → drain queues → disconnect mongo → exit | `apps/api/src/index.ts:364` |

Production env vars are enforced by `env.ts` zod schema with explicit
`.refine()` rules requiring REDIS_URL, ADMIN_SECRET, PUBLIC_API_URL,
PUBLIC_WEB_URL when `NODE_ENV=production`. JWT_SECRET min 16,
ADMIN_SECRET min 24, COURIER_ENC_KEY must be a valid base64-encoded
32-byte key.

## 5. Shopify-readiness status (one row per checkpoint)

| Checkpoint | Status | Anchor |
|---|---|---|
| OAuth install (HMAC pre-check, nonce CSRF, scope diff, hostname canonicalisation, orphan cleanup, audit logs) | COMPLETE | `apps/api/src/server/webhooks/integrations.ts:402` |
| Three GDPR privacy webhooks (real redaction, dual-audit pattern, fresh-install race guard) | COMPLETE | `apps/api/src/server/webhooks/shopify-gdpr.ts` |
| `app/uninstalled` handler (control-plane intercept, integration → disconnected) | COMPLETE | `apps/api/src/server/webhooks/integrations.ts:217` |
| Order webhook HMAC + freshness + idempotency | COMPLETE | `apps/api/src/server/webhooks/integrations.ts:146` |
| Privacy + Terms pages | COMPLETE | `apps/web/src/app/legal/{privacy,terms}/page.tsx` |
| `shopify.app.toml` scope alignment | COMPLETE | `shopify.app.toml` `[access_scopes]` |
| `shopify.app.toml` `application_url` + `redirect_urls` to prod | COMPLETE (toml) | `shopify.app.toml:33,71` |
| `shopify.app.toml` `client_id` populated | BLOCKING — commented out | `shopify.app.toml:28` |
| Listing copy (per-scope justifications, tagline, description) | COMPLETE | `docs/shopify-listing-wording.md` |
| `legalName` replaced with registered legal entity | BLOCKING (TODO[brand]) | `packages/branding/src/defaults.ts:26` |
| Email inboxes (`support@`, `privacy@`) accept mail | BLOCKING (reviewer-tested) | `packages/branding/src/defaults.ts:40-44` |
| Logo assets are ConfirmX (not legacy Cordon) | NEEDS VERIFICATION | `apps/web/public/brand/` |

## 6. Feature-flag status (current rollout stage)

All Phase-1 production-readiness flags are validated by `apps/api/src/env.ts`.

| Flag | Default | Posture | Stage |
|---|---|---|---|
| `DELIVERY_RELIABILITY_WRITE_ENABLED` | 0 | aggregate fan-out off | Phase 0 (deploy + Phase 1 verify ready) |
| `DELIVERY_RELIABILITY_READ_ENABLED` | 0 | merchant UI hidden | Phase 0 |
| `DELIVERY_RELIABILITY_ANALYTICS_ENABLED` | 0 | analytics hidden | Phase 0 |
| `DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED` | 1 | counters/logs ON (fail-safe) | always-on |
| `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS` | "" | no allowlist | empty until Phase 2 |
| `ADDRESS_QUALITY_ENABLED` | 1 | observation-only stamp | live, always-on |
| `INTENT_SCORING_ENABLED` | 1 | observation-only score | live, always-on |
| `ADDRESS_CANONICALIZATION_ENABLED` | 0 | thana extractor off | Phase 2 prerequisite |
| `LANE_INTELLIGENCE_WRITE_ENABLED` | 0 | courier-lane fan-out off | gated on canonicalisation |
| `LANE_INTELLIGENCE_READ_ENABLED` | 0 | read ladder unchanged | gated on writes warming |
| `EXTERNAL_DELIVERY_ENABLED` | 0 | profile fetch dormant | flip after a provider configured |
| `EXTERNAL_DELIVERY_{PATHAO,STEADFAST,REDX}_ENABLED` | 0 | adapters dormant | per-provider opt-in |
| `BDCOURIER_ENABLED` | 0 | platform adapter dormant | needs `BDCOURIER_API_KEY` + payload validation |
| `NETWORK_EVIDENCE_SURFACE_ENABLED` | 0 | merchant surface hidden | post-calibration |
| `NEXT_PUBLIC_EXTERNAL_DELIVERY_UI_ENABLED` | 0 | UI panel hidden | client-side double gate |
| `NEXT_PUBLIC_NETWORK_EVIDENCE_UI_ENABLED` | 0 | UI panel hidden | client-side double gate |
| `FRAUD_NETWORK_ENABLED` | 1 | cross-merchant lookup ON | live, always-on |

**Net: deploy-day posture is observation-only writes (address
quality + intent scoring) plus dormant intelligence-fan-out flags.
No risk of new behaviour landing on first prod boot.**

## 7. Operational intelligence philosophy

Every observation aggregate is **replay-safe and additive**:
- Chokepoint fan-outs read from a single canonical writer
  (`applyTrackingEvents`); replay produces no double-count.
- Reconciliation is **read-only and bounded**
  (`MAX_RECONCILE_SCAN=10000`).
- Repair is **CLI-only, dry-run-by-default, idempotent**, and refuses
  to backfill pre-flag terminal orders.
- Three independent rollback tiers: env flag flip → code revert →
  schema drop. The aggregates are not authoritative state — they're
  recomputable observations.
- The merchant-facing UI panel renders nothing on `tier: "no_data"`
  — cold-start is graceful.

Cancel-path writers (fraud reject, automation-stale, sms-inbound NO)
do **not** instrument the new aggregates by design (deep-audit §3.3).
Buyer-side reliability reflects what the chokepoint sees.

## 8. Replay-safety guarantees

- All commerce webhooks are HMAC-verified over raw bytes BEFORE the
  global JSON parser runs. Middleware ordering regression is caught
  by an explicit `Buffer.isBuffer(req.body)` check that returns 500
  rather than silently 401-ing every delivery.
- Webhook freshness gate: 5-min window with 1-min future-skew
  tolerance. Captured payloads can't be replayed at line speed days
  later.
- `WebhookInbox` unique index on `(merchantId, provider, externalId)`
  collapses duplicate deliveries into idempotent no-ops with `202`
  ACK.
- DLQ floor: `safeEnqueue` writes to `PendingJob` on Redis outage;
  `pending-job-replay` worker drains it.
- Order ingest race protected by partial-unique on
  `(merchantId, source.externalId)` — covered by index sync.
- Webhook signature failures emit structured `webhook.signature_invalid`
  for the security ops feed.

## 9. Current rollout stage

**Pre-submission.** All technical hardening landed; the residual gaps
are organisational (legal entity, email inbox provisioning, logo
assets) and Partner-Dashboard-side (distribution flip, listing
form). No production cutover yet.

Most-recent commits on `claude/staging-deploy`:
- `fce3415` — env P2: PUBLIC_API_URL/PUBLIC_WEB_URL prod-required
- `550c2bf` — security P1: BDCourier through safeFetch
- `da19795` — UI U4: externalDelivery wired + panels behind flags
- `a096ca5` — UI U3: OperationalRecommendationList + recommender
- `8c6f4b7` — UI U2: NetworkEvidencePanel

## 10. Remaining gaps (the punch list)

See `audits/shopify-production-gap-matrix.md` for the global
classification. The Shopify-submission-blocking subset:

1. **`shopify.app.toml` `client_id`** — uncomment + set to the
   Partner-Dashboard Client ID. Public value, safe to commit.
2. **`packages/branding/src/defaults.ts`** — replace `legalName`
   placeholder with the registered legal entity. Reviewers cross-
   check this against privacy/terms.
3. **Email infra** — `support@`, `privacy@` (and the other three
   `@confirmx.ai` mailboxes) must accept mail. Reviewers send a
   delivery test.
4. **Logo + brand assets in `apps/web/public/brand/`** — verify they
   are ConfirmX, not legacy Cordon (per `shopify-go-live-checklist.md
   §5` warning).
5. **Production deploy of api + web** with the env vars in
   `shopify-go-live-checklist.md §1–2`. The hosts must be reachable
   before the Partner-Dashboard flip.
6. **Partner Dashboard form** filled per
   `shopify-listing-wording.md` (per-scope justifications,
   privacy/terms URLs, GDPR webhook endpoints).

The non-blocking polish items, the runtime-stability checks, and the
observability/support-readiness gaps are tracked in the gap matrix
under PARTIAL / NEEDS POLISH.

## 11. Next priorities (in execution order)

1. Land any low-risk remediations identified by the gap matrix
   (production-safe defaults, missing health checks, runtime
   guards).
2. Coordinate the brand-side closeout (logo, emails, legal entity).
3. Production deploy + smoke-test on `app.confirmx.ai` /
   `api.confirmx.ai`.
4. Pre-submit OAuth E2E test against a fresh dev store.
5. Flip Custom → Public Distribution Unlisted.
6. Begin Phase 2 of the delivery-reliability rollout
   (`audits/delivery-reliability-rollout-runbook.md §6`) once
   merchants are real.

## 12. What we are NOT doing for this submission

- App Bridge / embedded experience (deferred — revisit post-approval)
- Embedded session tokens (N/A without App Bridge)
- Shopify Billing API (Stripe + manual bKash/Nagad remains primary)
- App Store listed (separate review — pursue later for top-of-funnel)
- New intelligence layers (positioning constraint — see §1)
- Autonomous fraud blocking, AI claims, aggressive scoring

## 13. Source docs (consult when more detail needed)

- `docs/shopify-app-distribution.md` — distribution-mode rationale
- `docs/shopify-listing-wording.md` — Partner-Dashboard copy + scope
  justifications
- `docs/shopify-go-live-checklist.md` — submission-day operational
  sequence
- `docs/audits/final-production-readiness-report.md` — delivery-
  reliability layer GO recommendation + prerequisite-patch record
- `docs/audits/architecture-inventory.md` — system layout
- `docs/audits/delivery-reliability-rollout-runbook.md` — flag flip
  sequencing
- `apps/api/CLAUDE.md` — worker registration + graceful shutdown
  contract
- `apps/web/CLAUDE.md` — route-group convention + provider placement
