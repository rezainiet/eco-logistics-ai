# Founder Chaos Findings (pre-beta)

Each row: a realistic failure → what the system does **today** (from
code, not hope) → the emotional/trust hit → is it visible? → cheapest
mitigation. Lens: *what would make a Bangladeshi merchant quietly stop
trusting ConfirmX.* No synthetic perfection.

| Scenario | What happens today | Trust hit | Visible? | Mitigation (cheapest) |
|---|---|---|---|---|
| **SSL Wireless doesn't sign DLR/MO** | Webhook 401s, every real reply/receipt silently dropped; orders stall in `pending_confirmation` | **Catastrophic & invisible** — customers confirm, merchant sees nothing, blames ConfirmX | `ops:triage` stuck count + `ops:digest` queue-stale, but root cause not obvious | Resolve signing contract BEFORE onboarding (SMS_FLOW_VERIFICATION.md). Pre-flight one live loop. |
| **Outbound SMS provider down / creds wrong** | `sendSms` returns `{ok:false}`, order stays pending, no crash | High — no confirmations go out, merchant thinks product dead | `worker.job_failed` logs + Sentry (if set) + digest LOW/queue flags | `verify:sentry` + watch digest day 1. Acceptable: fails safe, not loud. |
| **Broken on-install backfill** | One-shot import fails; only `console.warn`; dashboard empty | High — #1 "this is broken" day-one moment | **Now visible**: `ImportJob status=failed` → digest `sync_issues` + onboarding copy reassures | Founder works `sync_issues` lines same day. Adequate for beta. |
| **Slow Shopify sync / webhook lag** | `orderSync` polling rail (~5min) backfills; orders appear late | Medium — merchant sees lag, not loss | Partial — no "last sync" age surfaced to merchant | Accept for beta; tell merchants orders can take minutes. |
| **Stuck queue (operator stops working it)** | Orders age; auto-actions per automation config; RTO rises | High — silent money loss + churn | **Now visible**: queue-aging banner (operator) + digest `queue_neglected` + oldest age | The core P2/P3 win. Founder messages the merchant. |
| **Retry storm / dead-letter** | BullMQ retries w/ backoff; exhausted → PendingJob `exhausted` | Medium — work lost if unattended | `ops:triage` dead-lettered count + `worker.job_failed final=true` + Sentry | Documented manual replay (runbook §4). No auto-mutate tool (deliberate). |
| **Reconnect / disconnect confusion** | Disconnect now behind ConfirmDialog; reconnect has overwrite prompt | Medium — was a 1-click ingestion kill, now guarded | Yes (confirm dialogs) | Already mitigated. |
| **Mobile, cheap Android, slow 3G** | Queue list no longer nested-scroll-trapped; reasons hidden on phone; auto-scroll to detail; cold dashboard load ~slow | Medium — first paint still heavy on `/dashboard` | Not measured | Accept for 3–5 cohort; cold-load is a known post-beta perf item. |
| **Operator fatigue / rubber-stamp** | "Verify & book" + explicit cost line; no modal | Medium — false-confirm ships RTO | Proxy only (verify-without-call rate, not surfaced) | Wording done; measure rubber-stamp manually by observation. |
| **Merchant inactivity / silent churn** | Nothing auto-pings | Was invisible | **Now visible**: digest `inactive` + last-order age | Founder reads digest daily; this is the whole P2 point. |
| **No SENTRY_DSN in prod** | All capture is a silent no-op | **Catastrophic & invisible** — founder thinks they have eyes, doesn't | `verify:sentry` exits non-zero | Hard gate in runbook checklist. |

## Operational panic scenarios (the 2am list)

1. **"Customers say they confirmed but nothing happened."** → almost
   always the DLR/MO signing assumption. First check: are inbound
   webhooks 401ing? (logs). Pre-empt by validating the contract.
2. **"My dashboard is empty / no orders."** → backfill failed
   (`sync_issues` in digest) or store disconnected. Both now visible.
3. **"RTO went UP after I started using this."** → over-trusted
   "Likely reject" cancelling good COD orders, or operators
   rubber-stamping Verify. Only real data + observation reveals which.

## Net

The failure *handling* is sound (fails safe, idempotent, no crashes).
The danger is **silent integration failure** (SMS signing) and
**silent human failure** (queue/inactivity) — the second class is now
visible via `ops:digest`/`ops:triage`/health states. The first class
(SMS contract) is NOT a code problem and must be closed by a live
pre-flight before merchant #1. Everything else is observable enough for
a 3–5 merchant hand-held beta.
