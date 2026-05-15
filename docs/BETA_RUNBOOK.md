# ConfirmX — Private Beta Runbook

Scope: 10–20 hand-picked Bangladeshi COD merchants, real traffic, no
public Shopify App Store listing, no paid ads. The goal of the beta is
**operational confidence**, not feature completeness.

This is the single operational document for the beta. Keep it short
enough to read at 2am.

---

## 1. Beta readiness checklist (pre-deploy gates)

Run/verify these before onboarding the first merchant.

- [ ] Deploy is from a **clean checkout of `main`** (or a tag off it),
      not anyone's working tree. `git status` must be clean.
- [ ] `npm --workspace apps/api run build:strict` passes (exit 0).
- [ ] `npm --workspace apps/web run typecheck` passes (exit 0).
- [ ] `npm --workspace packages/db run build` and
      `npm --workspace packages/types run build` have run (the known
      clean-checkout footgun — apps fail to import `@ecom/*` otherwise).
- [ ] `npm --workspace apps/api run verify:prod-readiness` is green
      (env + infra + index checks).
- [ ] Branch protection on `main` configured with the three required
      checks (`API strict build`, `Web typecheck`, `API tests`) and
      squash-only merge — see `docs/CI.md`. (Closes the "no CI gate"
      risk: PR #2 auto-merged instantly because none existed.)
- [ ] Required env vars set in prod: `JWT_SECRET`, `COURIER_ENC_KEY`,
      `MONGODB_URI`, `REDIS_URL`, `SHOPIFY_API_SECRET`,
      `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
      `SMS_WEBHOOK_SHARED_SECRET`, SSL Wireless creds.
- [ ] Recommended for beta: `SENTRY_DSN` (error capture — see §4),
      `RESEND_WEBHOOK_SECRET` (else the Resend webhook 503s by design),
      `NEXT_PUBLIC_SUPPORT_WHATSAPP` (else the dashboard support footer
      falls back to the support URL).
- [ ] Mongo + Redis backups confirmed on by the provider.
- [ ] `wip/sms-migration` branch is **not** merged and not in the
      deploy artifact (see §2).
- [ ] Each beta merchant has signed the feedback side-letter and been
      told the data-retention window + that they must re-authorise
      Shopify with the `read_customers_private_data` scope.

---

## 2. Known limitations (state these to merchants honestly)

- **No IVR / voice confirmation.** The voice subsystem is a stub and
  is quarantined on `wip/sms-migration`. The UI degrades honestly
  (the Call button explains the manual fallback). Do **not** market
  call confirmation.
- **No WhatsApp channel.** Not built. Confirmation is SMS only.
- **Shopify embedded app is off.** Merchants use the standalone web
  app (hand-onboarded). CSP intentionally blocks the iframe.
- **SMS provider migration is incomplete and isolated** on branch
  `wip/sms-migration` (Twilio → SSL Wireless + BulkSMSBD, plus the
  voice scaffold and `confirmation-outcome.ts`). Beta runs on the
  pre-migration SMS path that is on `main`. Do not cherry-pick from
  the wip branch piecemeal — finish and review it as one atomic PR.
- **Sentry is opt-in.** Error capture only runs if `SENTRY_DSN` is
  set; otherwise capture is a silent no-op (dependency-free by
  design — see `apps/api/src/lib/telemetry.ts`).
- **Courier history backfill is aggregate-only** (BDCourier); native
  per-courier historical import is stubbed.
- **One login per workspace.** No team seats / roles in beta.

---

## 3. Deployment notes

- API: `node dist/index.js` (build with `npm --workspace apps/api run
  build`). Do not ship `tsx` to the runtime.
- Boot order is strict (env → DB → Redis → seeds → queues → workers →
  HTTP). Raw-body webhook parsers must stay mounted before
  `express.json` — do not reorder middleware.
- Process hooks (`installProcessHooks`) and the Express last-resort
  handler both route to telemetry; failures return a `requestId` in
  the 500 body — ask merchants for it when they report a bug.
- New since the hardening branch: `RESEND_WEBHOOK_SECRET` is now a
  declared optional env var (a clean checkout previously failed
  `build:strict` without it because the declaration lived only in the
  quarantined WIP).

## 4. Operational runbook (incident → action)

First move for almost anything: **`npm --workspace apps/api run
ops:triage`** (read-only). Add `--json` for alerting, `--stuck-hours=N`
to tune the stuck-order window.

| Symptom | Triage shows | Action |
|---|---|---|
| Orders not appearing for a merchant | `webhooks.failed`/`needsAttention` > 0 | Check the provider; `needs_attention` means we gave up + alerted the merchant. Re-test the integration from Settings → Integrations. |
| Confirmations not sending / actions lost | `deadLetteredJobs.total` > 0 | These are exhausted (lost) BullMQ jobs. The `pendingJobReplay` worker auto-replays *pending* (not exhausted) rows. For exhausted rows, inspect `lastError`, fix the cause, then replay manually (see below). |
| Replay backlog growing | `replayBacklog.pending` rising, oldest age large | Redis was/is flapping. Confirm `REDIS_URL` reachable; the sweeper drains automatically once Redis is healthy. |
| Orders stuck | `stuckOrders.byState` non-zero | Orders sitting in `pending_confirmation`/`requires_review` past SLA — usually no SMS reply. Work them from the verification queue. |
| Queue backlog | `queues.<name>` waiting/active high | A worker is slow/down. Check worker logs (`evt:"worker.job_failed"` / `"worker.error"` JSON lines) and Redis. |
| A specific merchant error | merchant has a `requestId` | Grep logs / Sentry for that `requestId` (`evt:"api.unhandled"`). |

- **Where the signal is:** structured JSON log lines —
  `evt:"worker.job_failed"` (has `final:true` when work is lost),
  `evt:"worker.error"`, `evt:"api.unhandled"`, `evt:"queue.wait_time"`,
  `evt:"queue.enqueue_failed"`. All also go to Sentry if `SENTRY_DSN`
  is set.
- **Manual replay of an exhausted job:** there is intentionally no
  one-click retry in the triage tool (a mutating 2am tool is a
  foot-gun). Fix the root cause first; then requeue via the normal
  enqueue path / re-trigger the upstream event (e.g. re-test the
  integration, or re-run import from Settings → Integrations).

## 5. Rollback considerations

- The hardening + stabilization work is on `main` as squash
  `f080e71` plus small follow-up commits. To roll back a specific
  change, `git revert <sha>` — every commit is small and atomic by
  design.
- **No destructive DB migrations** were introduced in the beta line.
  All webhooks are idempotent and there is an outbox
  (`PendingJob` + `pendingJobReplay`), so a redeploy/rollback does not
  duplicate orders or double-send SMS.
- `wip/sms-migration` is isolated on its own branch + pushed to
  origin. Rolling back the beta line never touches it; resuming it is
  a separate, deliberate PR.
- Redis is mostly cache, but BullMQ persistence matters during an
  outage window — prefer draining workers (graceful shutdown handles
  this) over hard-killing the process.

---

## 6. Engineering assumptions vs market assumptions

**Engineering assumptions (we can verify these ourselves):**

- Idempotency + outbox prevent duplicate orders / double SMS.
- Risk scoring is deterministic and explainable; the recommended
  action is derived only from visible signals.
- The 19-worker farm is wired and failures are now observable.
- A clean checkout builds and boots.

**Market assumptions (only real merchant usage can validate):**

- That SMS-only confirmation (no IVR yet) meaningfully reduces RTO in
  BD at these merchants' reply rates.
- That the recommended-action heuristic matches what an experienced
  COD operator would actually decide.
- That the customer-history trust bands (`new/trusted/mixed/risky`)
  map to real repurchase/return behaviour for these stores.
- That merchants will act on the verification queue daily rather than
  let it pile up.
- That the support response expectation we set is one we can hold.

## 7. What to learn ONLY from real beta usage

- Do operators trust and follow the recommended action, or override
  it? Where, and why?
- Which empty/error states still cause a support ping (i.e. weren't
  self-explanatory)?
- Real SMS reply rates and the resulting stuck-order volume — this
  sizes the IVR business case.
- Which "unexpected" merchant behaviours actually occur (the Phase 4
  guardrails are hypotheses until a merchant hits them).
- Whether the no-IVR / SMS-only limitation is a dealbreaker for
  higher-AOV merchants.

Capture these in a running notes doc, not in code. The beta exists to
answer the §6 market assumptions and §7 questions — nothing here
should be "fixed" speculatively before a real merchant hits it.
