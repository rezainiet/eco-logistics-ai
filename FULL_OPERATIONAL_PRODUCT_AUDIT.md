# FULL_OPERATIONAL_PRODUCT_AUDIT.md

**Auditor:** principal product engineer + operational auditor + UX systems reviewer
**Date:** 2026-05-07
**Scope:** entire Cordon monorepo (apps/web, apps/api, packages/db, packages/types, packages/config)
**Method:** static code trace + live browser probe against `localhost:3001/4000` + cross-reference of QUEUE_NAMES vs producers vs worker registration vs internal docs.

---

## Verification key

Every finding below carries a tag describing how it was confirmed.

- **VERIFIED-CODE** — confirmed by reading the actual source at named line numbers in this run.
- **VERIFIED-RUNTIME** — confirmed against the running stack (browser probe of `localhost`, JS-level introspection, network reads).
- **INFERRED** — strong inference from code/config but not directly executed (e.g. needs a real Shopify install to confirm end-to-end). Treat as a working hypothesis, not a fact.
- **UNVERIFIED** — flagged as suspected but I could not confirm in this run; needs a human eyeball or a follow-up tool with access I don't have (Railway dashboard, production Mongo, Sentry).

I deliberately did **not** mark anything VERIFIED unless I read the literal code or ran the literal probe.

---

## 1. Executive summary

The reliability story under the hood is **stronger than the docs claim**. The webhook ingestion pipeline (HMAC-before-state, raw-body preservation, freshness gate, idempotent inbox stamp, `safeEnqueue` → `PendingJob` dead-letter, retry-sweep, payload reap), the auth/RBAC layer (HttpOnly cookies, separate access/refresh JWTs with shared `sid`, server-side session store, DB-confirmed admin role, scoped admin permissions with audit), and the Shopify OAuth flow (early-HMAC enumeration-oracle close, install-nonce lookup, hostname canonicalization with E11000-prevention) are all engineered with operational thought. Several inline comments document real production bugs that were caught and fixed. This is not a half-finished prototype.

But the audit surfaced a tight cluster of **operational gaps that would bite a real merchant or operator at exactly the wrong moment**, plus several stale/contradictory artifacts that erode trust in the codebase as documentation of itself:

1. **`orderSync` worker is dead in production.** It exists, the queue exists, the schedule function exists — and `apps/api/src/index.ts` never calls `registerOrderSyncWorker()` or `scheduleOrderSync()`. The polling fallback for upstream order sync, which is supposed to "run alongside webhooks", is not running. (`apps/api/src/workers/orderSync.worker.ts:322,343`)
2. **The internal `apps/api/CLAUDE.md` file is wrong.** It claims `pendingJobReplay` is "not running in production". It actually IS wired (lines 69–71, 160, 173 of `index.ts`). The file warns the reader about a problem that no longer exists and was never updated. This is exactly the kind of stale doc that produces regressions: the next engineer reads it, "fixes" the missing wiring, double-registers, debugs for hours.
3. **Two queue names in `QUEUE_NAMES` have no producer and no consumer**: `verifyOrder` ("verify-order") and `subscription` ("subscription-sweep"). The wired subscription path is `subscriptionGrace`, not `subscription`. Dead code in a config-of-truth object is risky — someone will eventually `getQueue(QUEUE_NAMES.subscription).add(...)` thinking it's wired and the job will sit forever.
4. **Graceful shutdown is incomplete.** `server.close()` is called but **not awaited**, mongoose is **never disconnected**, Redis is not explicitly torn down, and `process.exit(0)` fires immediately after `shutdownQueues()` resolves. On Railway SIGTERM (default 30s drain window), in-flight tRPC mutations and webhook ACKs can be torn mid-response. (`apps/api/src/index.ts:273-282`)
5. **The web app's NextAuth flow bypasses the API's session-store revocation.** `/auth/login` mints a session-id-bound HttpOnly access cookie + an in-store sid that supports server-side revocation. But the web app doesn't use that cookie — `next-auth/providers/credentials.authorize()` server-side-fetches `/auth/login` and stuffs the resulting `apiToken` into the NextAuth JWT, which the SPA sends as `Authorization: Bearer`. **A stolen NextAuth session cookie cannot be revoked server-side** without rotating `NEXTAUTH_SECRET`. The `/auth/logout-all` flow flips the sid in the API's store, which kills the API's HttpOnly cookie path, but the web app's `next-auth.session-token` keeps working until its own JWT expires.
6. **API build runs in TS-tolerant mode in production.** `npm run build` (used by deploy) is `tsc … --noEmitOnError false` so type errors do not block emit. The `:strict` variant exists but is not the default. A "deploy ships even with errors" build script is fine for staging hot-fixes; as the steady-state production build it leaks broken types into runtime.
7. **The fraud-review UI shows numeric scores but no human reasons.** `apps/web/src/app/dashboard/fraud-review/page.tsx` surfaces `riskScore: 82`, `level: "high"`, but the `intent.ts` + `address-intelligence.ts` + `risk.ts` libraries (1,780 LOC combined) compute rich signals that never make it to the merchant. A merchant sees "82" with no answer to "why is it 82". Trust gap: merchants stop trusting numbers they can't interrogate.
8. **`/login` rendered without applied CSS in the Chrome-MCP test session.** Times New Roman, transparent body, both `md:hidden` and `md:flex` proof-bands stacking visibly. The compiled `_next/static/css/app/layout.css` was referenced in the `<link>` tag but `getComputedStyle` returned defaults. **This may be a Chrome-MCP capture artifact rather than a real production issue, but it needs human eyeball verification on a regular tab.** If it reproduces, the marketing/auth surface is shipping unstyled to some real users. (`Task #14`)

The remainder of the report quantifies these and adds the secondary findings.

**Verdict in one sentence:** the system is technically more trustworthy than typical at this stage of life, but its **operational seams** (worker wiring, doc accuracy, shutdown discipline, dual auth, build strictness) are where it would lose merchant trust on a bad day, not where the code is wrong.

---

## 2. Most critical operational risks

### 2.1 `orderSync` worker not registered — polling fallback for order ingest is silent-dead [CRITICAL · VERIFIED-CODE]

**Repro / evidence:**
- `apps/api/src/workers/orderSync.worker.ts:322` defines `registerOrderSyncWorker()`.
- `apps/api/src/workers/orderSync.worker.ts:343` defines `scheduleOrderSync(intervalMs)`.
- `apps/api/src/lib/queue.ts:29` defines `QUEUE_NAMES.orderSync = "order-sync"` with the comment *"Polling fallback for upstream order sync — runs alongside webhooks."*
- `apps/api/src/index.ts` imports 14 worker registration functions and 8 schedule functions. **Neither `registerOrderSyncWorker` nor `scheduleOrderSync` appears anywhere in `index.ts` or anywhere outside the worker file itself.** Confirmed by exhaustive `grep -rn` of `apps/api/src`.
- `apps/api/CLAUDE.md` explicitly warns: *"If a worker exists in `src/workers/` but has no `register*` call in `src/index.ts`, it is dead in production no matter how many tests cover it. Treat that as a bug, not a feature flag."*

**Affected flows:**
- Any merchant whose Shopify webhook delivery breaks (e.g. uninstall + reinstall, expired access scope, store on a Shopify plan whose webhook bridge has a bad day) loses orders silently. The `webhookRetry` worker re-drives `WebhookInbox` rows that *did* arrive, but `orderSync` is the path that pulls orders the api never received a webhook for.
- WooCommerce stores with flaky outbound webhooks (common — Woo's webhook reliability is well-known to be merchant-tier-dependent) similarly miss orders.

**Operational impact:** the merchant sees fewer orders than their store actually received, blames Cordon, churns. Hardest-to-debug class of failure: data missing without an error.

**Merchant impact:** silent revenue hole. By definition, the missing orders never appear in any UI, so the merchant has no breadcrumb except their own reconciliation.

**Recommended fix:** in `apps/api/src/index.ts` after `registerAwbReconcileWorker()` / before the `console.log("[boot] pending-job-replay armed …")` line, add:

```ts
import { registerOrderSyncWorker, scheduleOrderSync } from "./workers/orderSync.worker.js";
// ...
registerOrderSyncWorker();
await scheduleOrderSync(); // default interval per worker file
```

**Regression risk:** low. The worker is concurrency-safe (BullMQ `registerWorker` returns the existing instance if a name collision is detected) and `scheduleOrderSync` removes its repeatable before re-adding it, so multi-instance deploys don't double-schedule. Add an integration test that asserts the queue has at least one repeatable after boot.

---

### 2.2 Dead queue names in `QUEUE_NAMES` ("verify-order", "subscription-sweep") [HIGH · VERIFIED-CODE]

**Repro / evidence:**
- `apps/api/src/lib/queue.ts:12` `verifyOrder: "verify-order"` — `grep -rn 'QUEUE_NAMES.verifyOrder\|"verify-order"'` returns the definition only. Zero producers, zero consumers.
- `apps/api/src/lib/queue.ts:15` `subscription: "subscription-sweep"` — same. Zero producers, zero consumers. (The wired subscription path is `subscriptionGrace`/`"subscription-grace"`.)

**Affected flows:** future engineering work. Today, nobody calls these.

**Operational impact:** future regressions. A new engineer doing a "queue sweep" sees `subscription` and writes `getQueue(QUEUE_NAMES.subscription).add(...)`. Their job sits in Redis forever. Worse: the second name reads as if it might be the canonical one and `subscriptionGrace` reads as a sub-mode of it, but the truth is reversed.

**Merchant impact:** none today.

**Recommended fix:** delete both keys from `QUEUE_NAMES`. If you want to preserve the name reservation, leave a comment-only line. Add `eslint-plugin-import` `no-unused-modules` or a small custom check that asserts every `QUEUE_NAMES.*` key has at least one consumer.

**Regression risk:** zero. Removing unused names cannot affect runtime.

---

### 2.3 Stale internal docs claiming an already-fixed bug [HIGH · VERIFIED-CODE]

**Repro / evidence:**
- `apps/api/CLAUDE.md` line 16: *"Known gap (do not ship as-is) — `pendingJobReplay.ts` exports `startPendingJobReplayWorker()` and `ensureRepeatableSweep()` but `src/index.ts` does not call either. The dead-letter sweeper is therefore not running in production. Wire it before relying on `PendingJob` retries."*
- `apps/api/src/index.ts:69-71` imports both functions.
- `apps/api/src/index.ts:160` calls `startPendingJobReplayWorker()`.
- `apps/api/src/index.ts:173` calls `await ensureRepeatableSweep()`.
- `apps/api/src/index.ts:179` logs `"[boot] pending-job-replay armed (worker concurrency=1, sweep every 30s)"`.

**Operational impact:** trust erosion. The internal CLAUDE.md is the doc Claude / engineers read first. When it lies (even by being out of date), every other claim in it is suspect. This is exactly the failure mode that produces the next regression: someone reads "this is broken" and "fixes" what is no longer broken, possibly double-registering or breaking the actually-correct wiring.

**Merchant impact:** none directly. Indirect: increases the rate of operator mistakes.

**Recommended fix:** remove the "Known gap" subsection. Add a single line to the worker registration checklist: *"`pendingJobReplay` is wired; it MUST stay wired — it's the dead-letter floor."* Add a CI check that diffs `apps/api/src/index.ts` boot calls against the worker files in `src/workers/` and fails if any worker file exports `register*` without a corresponding call site.

**Regression risk:** zero (doc-only).

---

### 2.4 `globalLimiter` is dead code [LOW · VERIFIED-CODE]

`apps/api/src/middleware/rateLimit.ts:55` defines `globalLimiter` (300 req/min per IP). Zero importers anywhere in `apps/api/src`. The `/trpc` mount has no global limiter (deliberately, per the comment in `index.ts`); the per-route limiters cover login, signup, password reset, webhooks, public tracking. So `globalLimiter` is genuinely orphaned.

**Fix:** delete it, or wire it to a route that needs a generic IP cap. Don't leave defined-but-unused middleware.

---

### 2.5 Graceful shutdown does not drain in-flight requests or close DB [HIGH · VERIFIED-CODE]

**Repro / evidence (`apps/api/src/index.ts:273-282`):**

```ts
const shutdown = async (signal: string) => {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();                             // <-- not awaited
  await shutdownQueues().catch(/* … */);
  process.exit(0);                            // <-- fires before in-flight requests drain
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
```

- `server.close()` returns immediately and signals "stop accepting new connections". To **drain** existing requests, you must `await new Promise(resolve => server.close(resolve))`.
- `mongoose.disconnect()` is called in seven `scripts/*.ts` files (e.g. `seed.ts`, `promoteAdmin.ts`) but never in `index.ts`. On SIGTERM, Mongoose's connection is force-closed by the process exit; queued queries die mid-flight.
- Redis: `shutdownQueues()` closes BullMQ queues + workers but the shared `_connection: Redis` from `lib/queue.ts` is not explicitly disconnected (BullMQ may dispose it transitively, but the contract is not explicit).

**Operational impact:** every Railway redeploy has a window where in-flight POSTs (e.g. an order created mid-deploy) can hit `process.exit(0)` before the response writes back. The merchant sees a 502 or hung tab; the order may or may not be in Mongo depending on whether the mongoose buffer flushed. Worst case: the order is in Mongo but the response says "failed", merchant retries, dedup kicks in via `(merchantId, source.externalId)` so we don't duplicate — but the merchant has lost trust during the redeploy window.

**Recommended fix:**

```ts
const shutdown = async (signal: string) => {
  console.log(`[api] ${signal} received, shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await shutdownQueues().catch((err) => console.error("[api] queue shutdown", err));
  await mongoose.disconnect().catch((err) => console.error("[api] mongo shutdown", err));
  process.exit(0);
};
// + a forced-exit watchdog so a stuck connection cannot block forever:
process.on("SIGTERM", () => {
  setTimeout(() => process.exit(1), 25_000).unref();
  void shutdown("SIGTERM");
});
```

The 25s watchdog matches Railway's default 30s drain window with a 5s safety margin.

**Regression risk:** low. Test with a `kill -TERM` against a running dev server with an open `curl` POST to a slow endpoint; observe that the response completes before exit.

---

### 2.6 Web `next-auth` session bypasses API session-store revocation [HIGH · VERIFIED-CODE · INFERRED runtime behaviour]

**Repro / evidence:**
- `apps/api/src/server/auth.ts` mints `access_token` (HttpOnly), `refresh_token` (HttpOnly), `csrf_token` (non-HttpOnly), all carrying the same `sid` claim. `sessionStore` tracks the sid; `protectedProcedure` (`apps/api/src/server/trpc.ts:213`) calls `sessionExists(userId, sid)` to validate, with a 30s LRU cache. `/auth/logout-all` flips the sid → cache miss within 30s → all tokens dead. Solid.
- `apps/web/src/lib/auth.ts` configures NextAuth's `CredentialsProvider` to *server-side fetch* `${apiUrl}/auth/login`. **The `Set-Cookie` headers from that response are dropped** because `fetch()` from a Node.js server-side context doesn't propagate cookies to the browser unless explicitly forwarded. The api's response **also** returns the access token in the JSON body (`data.token`), and that's what NextAuth stuffs into its own JWT as `apiToken`.
- The browser ends up with `next-auth.session-token` (NextAuth's HttpOnly cookie, signed with `NEXTAUTH_SECRET`). The SPA does `useSession()` → reads `session.apiToken` → sends it as `Authorization: Bearer`.

**What this means:**
- The `sid` carried by the embedded apiToken is real, but the user's session in NextAuth's view is keyed off `next-auth.session-token`, not the api's `sid`. NextAuth refresh happens via `useSession().update({ apiToken: newToken })` from `TokenRefreshKeeper`.
- If a merchant calls "log out everywhere" from the dashboard, the api's `revokeAllSessions(merchantId)` flips every sid for that merchant. The merchant's *current* tab loses tRPC access within 30s (cache miss, sid invalid, UNAUTHORIZED). **But**: NextAuth's session cookie is still valid until its own JWT expires (default 30 days), and any cached `getServerSession()` returns the unrevoked NextAuth session. The dashboard layout's SSR check still treats the user as logged in.
- An attacker with a stolen `next-auth.session-token` can keep using it until either NextAuth's own JWT expires or `NEXTAUTH_SECRET` is rotated. The api's beautifully-engineered server-side revocation **does not stop them**.

**Operational impact:** the security posture you'd see written up looks great on paper. The runtime reality is that the headline revocation control is a half-measure for the actual web users.

**Recommended fix:** two paths, pick one.
- **Path A (cleanest):** drop NextAuth entirely. Proxy `/auth/login` from the web to the api with `set-cookie` forwarding (Next.js Route Handler can do this). Use the api's HttpOnly access cookie + CSRF double-submit directly. The dashboard layout's SSR session check becomes a `fetch('/auth/me')` with the cookie. This makes the entire session-store revocation story actually true.
- **Path B (incremental):** keep NextAuth, but in NextAuth's `jwt({ token, trigger })` callback, add a periodic re-validation: when `trigger === "session"`, hit `/auth/me` with the current `apiToken`; if the api returns 401 (sid revoked), throw to invalidate the NextAuth session. Combine with a short NextAuth `session.maxAge` (e.g. 1 hour) so revocation propagates within an hour even if the active-session callback misses.

**Regression risk:**
- Path A: medium. Touches every protected page's auth check. Worth it if you're approaching SOC2.
- Path B: low. Localized change in `apps/web/src/lib/auth.ts`.

**Caveat:** I inferred the cookie-drop behaviour from the NextAuth `authorize()` code. I did not capture a full HTTP trace of the login flow. Confirming this against a real `chrome://devtools` Network tab during sign-in would close the loop and is worth 5 minutes before fixing.

---

### 2.7 API production build is type-error tolerant [MEDIUM · VERIFIED-CODE]

`apps/api/package.json:7`:

```json
"build": "node -e \"const r=require('child_process').spawnSync('npx',['tsc','-p','tsconfig.build.json','--noEmitOnError','false'],{stdio:'inherit',shell:true}); if(r.status&&r.status!==0){console.log('[build] tsc reported type errors but emitted JS — staging deploys tolerate this. Local typecheck still gates main.');} process.exit(0);"
```

The script **always exits 0**, even if tsc reports errors. The `build:strict` variant exists. Inferred Railway behaviour: `npm run build` is the deploy build, which means **a TS regression can ship to production** as long as it emits some JS.

Per `apps/web/CLAUDE.md`-equivalent in `INFRASTRUCTURE_OVERVIEW.md` §1.2: *"consider switching the deploy to `build:strict` once the codebase is at zero type errors (it is, per the design-partner readiness checklist)."* — i.e. the team intends to flip it, hasn't yet.

**Recommended fix:** flip the deploy command to `build:strict` now. CI / pre-push hooks already typecheck, so this is a net no-cost change.

**Regression risk:** low — surfaces existing type errors loudly rather than letting them ship. If anything is currently broken, you'd want to know on PR, not in prod.

---

## 3. Most critical UX problems

### 3.1 Fraud review surfaces numeric scores without human reasons [HIGH · VERIFIED-CODE]

`apps/web/src/app/dashboard/fraud-review/page.tsx`:
- Line 47: `riskScore: number` typed in the row schema.
- Line 355: `{it.riskScore}` rendered as a bare number.
- Line 429: `{detail.data.fraud.riskScore} · {detail.data.fraud.level}` — score and level only.

The library code that *computes* the score is rich: `apps/api/src/server/risk.ts` is 1,102 lines, `apps/api/src/lib/intent.ts` is 462, `apps/api/src/lib/address-intelligence.ts` is 216 — over 1,700 lines of signal computation. The merchant sees `82 · high`. They don't see *which* signals fired, *how strongly*, and *why*.

This is the single largest trust gap in the product. Merchants in Bangladesh's COD economy are explicitly the audience (per the landing copy *"Built for Bangladesh's COD economy"*), and they are accustomed to making the call themselves. Showing a black-box number tells them "trust us"; showing reasons tells them "here's what to look at, you decide". The first eventually loses. The second compounds.

**Fix sketch:** the score computation already emits structured signals (per the file sizes, this is not invented). Surface them. Replace the `82 · high` cell with a stack of human-language pills:
- "New buyer" (first order from this phone)
- "Same-day phone reuse" (the phone placed 4 orders to different addresses today)
- "District/thana mismatch" (city says Dhaka, thana says Sylhet's Jamalganj)
- "Behavioral session not stitched" (customer signal absent — buyer came in via guest checkout from a fresh IP)

Each pill links to a side panel with the underlying numbers. The score becomes a *summary* of the pills, not the only artifact.

**Regression risk:** zero — additive UI surface over existing data.

---

### 3.2 `/login` rendered without applied CSS in Chrome MCP probe [SEVERITY UNKNOWN · VERIFIED-RUNTIME, REPRO UNCONFIRMED]

**Repro / evidence:**
- Loaded `http://localhost:3001/login` via Chrome MCP. Screenshot: black background, white text, all text in `Times New Roman`, no spacing, two stacked copies of the marketing proof-band content (mobile `md:hidden` and desktop `md:flex` variants both visible), login form rendered as raw inputs at the bottom.
- `getComputedStyle(document.body).backgroundColor` returned `rgba(0, 0, 0, 0)` (transparent).
- `getComputedStyle(document.body).fontFamily` returned `"Times New Roman"`.
- `document.querySelectorAll('link[rel=stylesheet]')[0].href` returned `http://localhost:3001/_next/static/css/app/layout.css?v=1778144486334` — the link tag is present.
- `document.styleSheets[0].cssRules` threw `BLOCKED: Cannot access rules` — typically a CORS-missing-`crossorigin=anonymous` issue, but that's a *JS-introspection* block, not a *visual-application* block. Browsers normally still apply same-origin stylesheets that JS can't introspect.
- The **inline** `<style dangerouslySetInnerHTML>` block injected by `CordonAuthShell` did load (32 rules visible).

**What this means:** either (a) there's a real ordering / hydration / CORS issue causing the compiled Tailwind layout.css to fail to apply visually under some condition, and Chrome MCP happens to surface it; or (b) the Chrome MCP CDP injection mechanism interferes with stylesheet application during screenshot capture.

**This needs a human eyeball check on a normal Chrome tab against `localhost:3001/login` before being treated as a real bug.** If it reproduces, the auth surface is FOUC-disasterous on first paint and merchants on slow connections would be the first to feel it. If it doesn't, it's an MCP artifact and can be closed.

**Suggested probe:**
- Open `localhost:3001/login` in a fresh incognito Chrome window. Hard reload (Cmd-Shift-R). Confirm the page renders styled.
- Open DevTools → Network → filter `.css` → reload → confirm `layout.css` returns 200 with `text/css` content-type.
- If both green, mark this as MCP-artifact and close.
- If either is red, escalate.

---

### 3.3 Two distinct `EmptyState` components [LOW · VERIFIED-CODE]

`apps/web/src/components/ui/empty-state.tsx` is the shared one (used by Orders, Analytics, Fraud Review, etc. — 8+ pages). `apps/web/src/app/dashboard/integrations/issues/page.tsx:573` defines its own inline `function EmptyState() { … }` and uses it at line 321.

Two implementations drift over time. The integrations/issues page will look different from the rest of the dashboard's empty states, in subtle ways no one catches until a brand pass.

**Fix:** delete the inline function, import the shared one. 5-minute change.

---

## 4. Merchant trust gaps

### 4.1 Webhook health visibility (positive note) [VERIFIED-CODE]

This is one of the **strongest** parts of the product. The `integrationsRouter` exposes `getHealth`, `recentWebhooks`, `inspectWebhook`, `replayWebhook`, `listIssues`, `bulkReplayIssues`, `resolveIssues`, `systemStatus` (`apps/api/src/server/routers/integrations.ts:1567-2326`). The corresponding UI is `dashboard/integrations` + `dashboard/integrations/issues`. A merchant can see, replay, and resolve webhook problems. This is real operator surface, not a theatre.

The trust-gap risk here is **inverse**: the surface is excellent, which makes merchants assume *all* integration failures show up there. They probably don't — the orderSync polling fallback is the cover for webhooks the platform never delivered, and (per §2.1) it's not running. The dashboard would say "all integrations healthy, last event 3 minutes ago" while a Shopify webhook silently lost the past 6 hours of orders.

**Fix:** wire orderSync (§2.1). Once it's running, surface a "polling-recovered N orders since {ts}" line in the integration health card; that's the signal that proves the polling loop is doing its job.

---

### 4.2 No surfaced "Cordon caught X for you this week" moment [MEDIUM · VERIFIED-CODE]

The product has rich enough data to compute "you would have shipped 42 fraud orders this month, costing you ৳2.1 lakh in COD courier-return fees, if you weren't on Cordon". I see no place in the dashboard that shows this. The closest is `OnboardingChecklist` activation moments (`activation-moments.tsx`) but those are first-touch moments, not weekly value reinforcement.

A merchant who pays ৳5k/month for Cordon needs a recurring reminder that the spend is justified. This is the difference between churn-resistant and churn-vulnerable.

**Fix:** add a weekly digest email + a /dashboard banner: *"This week, Cordon prevented N likely-RTO orders worth ৳X. Detail →"*. Data already exists. UI surface is small. Conversion impact, in my experience, is large.

**Regression risk:** zero — additive.

---

## 5. Onboarding failures (mostly clean)

The onboarding implementation is **better than typical**. Specifically:
- `dashboard/getting-started/page.tsx` SSRs the merchant name to avoid hydration flicker (good — a small thing that reads as polished).
- `OnboardingChecklist` (`onboarding-checklist.tsx`) focuses on one "Up next" step rather than rendering five equal-weight items. The component comment explicitly cites the prior wall-of-options regression. This is hard-won UX wisdom encoded in code.
- Step copy is benefit-first (*"So Cordon sees every order the moment it's placed (Shopify · WooCommerce)"*), not feature-first. Documented intentional choice.
- Each query has its own loading state; failure falls back to "not done". Safe defaults.
- `time estimates per step` ("about 3 minutes") set realistic expectations.

**Gaps I'd still call out:**

- **5.1 [LOW]** No visible "skip for now" or "I'll do this later" affordance. A merchant who can't connect Shopify *right now* (waiting on store admin access) has no graceful exit; they sit on getting-started, return tomorrow, and the same wall greets them. Add a "Remind me tomorrow" that just defers the banner. The data already exists (last-modified-at).
- **5.2 [LOW]** Step `test_sms` is satisfied by *any* booked-by-automation order existing. That conflates "I tested SMS" with "automation has run at least once". A real test-SMS flow that sends a known string to the merchant's own phone and asks them to confirm receipt would be more honest. As written, a merchant could complete the checklist without SMS being verified to actually reach handsets.
- **5.3 [INFERRED]** Connect → first-order activation is the most fragile moment. With `orderSync` unwired (§2.1), a merchant whose first webhook fails sees "store connected" + "0 orders" indefinitely. The polling fallback is the safety net for exactly this scenario.

---

## 6. Reliability issues (worker layer)

| Worker / queue | Wired in `index.ts` | Schedule | Notes |
| --- | --- | --- | --- |
| trackingSync | yes (143) | yes (164) | OK |
| risk | yes (144) | n/a (consumer-only) | OK |
| webhookRetry | yes (145) | yes (165) | OK — covers `received` orphans |
| webhookProcess | yes (146) | n/a (consumer-only) | OK |
| fraudWeightTuning | yes (147) | yes (172) | OK |
| commerceImport | yes (148) | n/a | OK |
| automationBook | yes (149) | n/a | OK |
| automationSms | yes (150) | n/a | OK |
| automationStale | yes (151) | yes (170) | OK |
| automationWatchdog | yes (152) | yes (171) | OK |
| cartRecovery | yes (153) | yes (166) | OK |
| trialReminder | yes (154) | yes (167) | OK |
| subscriptionGrace | yes (155) | yes (168) | OK |
| awbReconcile | yes (156) | yes (169) | OK |
| pendingJobReplay | yes (160) | yes (173, ensureRepeatableSweep) | OK — CLAUDE.md says it isn't, doc is stale |
| **orderSync** | **NO** | **NO** | **§2.1 — DEAD** |
| ~~verifyOrder~~ | n/a | n/a | dead queue name |
| ~~subscription~~ | n/a | n/a | dead queue name |

So 14 of 16 declared *workers* are correctly wired; the dead-letter sweeper is wired (despite the doc); `orderSync` is dead; `verifyOrder`/`subscription` are dead names.

### 6.1 Webhook reliability story (positive note)

The webhook receiver in `apps/api/src/server/webhooks/integrations.ts` is genuinely well-engineered. Specifically:
- Raw body preserved before global JSON parser — HMAC verification works.
- HMAC verified before any DB mutation — can't enumerate via timing oracle.
- Freshness gate (5-minute window, 1-minute future-skew tolerance) for platforms that ship a timestamp — captured payloads can't be replayed hours later.
- Inbox stamp via `enqueueInboundWebhook` returns `duplicate: true` on collision — idempotent ACK.
- ACK-latency log on every accepted delivery (good, makes the "<50ms ACK" claim measurable).
- `safeEnqueue` with three-attempt Redis backoff → `PendingJob` Mongo dead-letter → merchant alert. The only path that loses work is *both* Redis AND Mongo down, simultaneously. (`apps/api/src/lib/queue.ts:328-420`)
- `app/uninstalled` short-circuit is correct: flip integration to disconnected before reaching the order-ingestion pipeline. Idempotent on re-delivery.
- `WebhookInbox` payload reaping (`reapWebhookPayloads` in `webhookRetry.ts:54`) bounds growth — succeeded rows have payload null'd after `payloadReapAt`, dedup keys persist.

Independent verification reads as **production-grade**.

### 6.2 What still concerns me

- **6.2.1 [INFERRED · MEDIUM]** `WebhookInbox` and `webhookRetry` cover post-receive reliability. They do **not** cover never-received: webhooks the platform never sent because the merchant's app integration scope is wrong, the platform is in a partial outage, or the Shopify webhook subscription was rejected during `registerShopifyWebhooks`. The latter is logged but I did not trace whether the failure surfaces in the `getHealth` UI; if not, a merchant whose webhook registration silently 4xx'd at install time looks "connected" but receives nothing.
- **6.2.2 [VERIFIED-CODE · LOW]** The `webhook-process` worker is concurrency 4 (queue.ts default). If a merchant pushes a 500-order Shopify backfill in a burst, the per-merchant token bucket in `safeEnqueue` should fairness-throttle them, but `webhookProcess` is not the producer there — the receive route is. So the back-pressure is on enqueue, not on processing. That's fine until two large merchants burst at the same time and one chokes the other's processing capacity. Worth a load test before the next +5 large merchants land.

---

## 7. Replay/queue concerns

### 7.1 PendingJob → BullMQ replay path (positive note) [VERIFIED-CODE]

`apps/api/src/workers/pendingJobReplay.ts` (238 lines) is wired (per §2.3). The pipeline:
1. `safeEnqueue` fails on Redis after 3 attempts → writes a `PendingJob` row with `(queueName, jobName, data, opts, ctx)`.
2. `pendingJobReplay` worker (concurrency 1, sweep every 30s per the boot log) drains rows where `nextAttemptAt <= now` and re-enqueues them onto BullMQ.
3. On success: row deleted. On failure: backoff bookkeeping, retry cap, dead-letter alert.

This is the "what if Redis dies" floor. The fact that it's wired is great. The doc saying it isn't (§2.3) is the only issue.

### 7.2 Concerns

- **7.2.1 [VERIFIED-CODE · LOW]** Concurrency 1 means a backlog after a long Redis outage drains slowly. If Redis was down for 30 minutes and accumulated 50k PendingJob rows, a sweep-every-30s + concurrency-1 worker will take ~25 minutes per 50k rows just to drain the dead-letter, assuming each replay is <30ms. That's a long tail of inconsistency. Consider concurrency 4 with a job-name-based dedup key, or a one-shot "drain everything once on boot" pass before going to steady-state cadence.
- **7.2.2 [INFERRED · LOW]** The dead-letter alert path goes through `lib/alerts.ts` — I did not trace whether a merchant sees these in the dashboard or only ops. A merchant whose order failed enqueue twice is a stat they should see, not just a Slack ping for ops.

---

## 8. Dashboard UX issues

### 8.1 Sidebar / Topbar / IncidentBanner / MobileBottomNav (positive note)

- `IncidentBanner` is env-driven (`NEXT_PUBLIC_INCIDENT_BANNER_TEXT`). Ops can flip a banner without a deploy. That's a real operational tool.
- `MobileBottomNav` is exact (`<md`) and pairs with the sidebar's `hidden md:flex` so there's no dead breakpoint zone. The `pb-24 md:pb-0` on main content prevents the bottom nav from hiding content. Comments document the math. (`mobile-bottom-nav.tsx:21-23`)
- Sidebar uses logical groupings (Operate / Insights / Connect / Account). Coherent IA.

### 8.2 Findings

- **8.2.1 [LOW · VERIFIED-CODE]** Two `EmptyState` components (§3.3). Same fix.
- **8.2.2 [INFERRED · LOW]** `dashboard/page.tsx` calls three concurrent tRPC queries (`analytics.getDashboard`, `analytics.getOrdersLast7Days`, `fraud.getReviewStats`). On a cold session each is a separate round-trip. tRPC's react-query batching helps if all three fire in the same tick, but I didn't confirm batching is on for this client. Worth a Network-tab check.
- **8.2.3 [INFERRED · LOW]** `MobileBottomNav` only has 5 slots (Home, Orders, Review, Settings, Help). On small screens, a merchant who actually uses Recovery, Call customer, Analytics, Integrations, Billing has to open the hamburger drawer every time. The chosen 5 are defensible (frequency-based) but I'd validate against actual usage data before committing — Recovery and Call customer are *operational* flows that are frequently used in BD COD operations.

### 8.3 Mobile responsiveness

The breakpoint discipline reads correct on inspection (`md:` patterns, `supports-[padding:env(safe-area-inset-bottom)]`, `min-h-[56px]` on tap targets). I did **not** runtime-verify on mobile widths because of the unstyled-render issue (§3.2). Worth a manual pass on 375px/414px before next release.

---

## 9. Mobile UX issues

Tied to §8.3 above. The architecture is right; the runtime is unverified in this audit. The single biggest mobile-specific risk is **the auth surface stacking the value column above the form on small screens** — without the `md:hidden` proof-band working correctly, a fresh signup user sees a wall of marketing copy before the form on a phone. The `CordonAuthShell` does have a mobile proof-band that's specifically `md:hidden`, but if `md:hidden` ever stops applying (the Tailwind issue I observed in §3.2), every auth page becomes a vertical stack of marketing pitch and form. This is exactly what I saw in the MCP probe.

---

## 10. Performance findings

- **10.1 [VERIFIED-CODE · POSITIVE]** Marketing route group ships zero auth/tRPC weight. Providers wrapped at route-group / segment layout, not in `app/layout.tsx`. (`apps/web/CLAUDE.md` documents this; `apps/web/src/app/layout.tsx` confirms — root layout is html/body + fonts only, no `<Providers>`.) This is the right architecture.
- **10.2 [VERIFIED-CODE · POSITIVE]** `next/font/google` is self-hosting fonts (Inter, Instrument_Serif, JetBrains_Mono). No render-blocking external font request.
- **10.3 [VERIFIED-CODE · POSITIVE]** `boot/syncIndexes` runs background-async in `apps/api/src/index.ts:115-141` so the `/health` endpoint binds to its port without waiting for index builds. Railway healthcheck will not flap on cold deploys with new collections.
- **10.4 [VERIFIED-CODE]** tRPC has *no* global IP rate limiter. Per-merchant fairness is via the in-`safeEnqueue` token bucket. Comment in `index.ts:222-234` documents the trade-off explicitly. Reasonable, but means a single misbehaving authenticated merchant can drive the api hot for the duration of one bucket refill (default config in `lib/merchantRateLimit.ts`, not read in this run).
- **10.5 [VERIFIED-CODE · MEDIUM]** `tokenCache` (10k entries, 60s TTL) and `sidValidCache` (20k, 30s TTL) and `subCache` (10k, 30s) and `dbRoleCache` (5k, 60s) — four LRU caches in `trpc.ts`, all process-local. On a multi-instance Railway deploy, every instance has its own. Revocation propagation is bounded by the longest TTL × instances. This is by-design (the comments call it out) and probably correct, but worth re-evaluating once Cordon's instance count grows past ~4.

---

## 11. Railway / deployment findings

- **11.1 [VERIFIED-CODE · LOW]** No `railway.json`, `railway.toml`, `nixpacks.toml`, or `Procfile` in the repo. Deployment relies on Railway's Node auto-detection. Auto-detection works but encodes runtime assumptions (start command, build command, healthcheck path) in the Railway dashboard rather than in source control. If you ever migrate clouds or stand up a parallel staging from a fresh Railway project, you'll re-derive these from memory. Add a `railway.json` with:
  ```json
  {
    "$schema": "https://railway.app/railway.schema.json",
    "build": { "builder": "NIXPACKS", "buildCommand": "npm run build && npm --workspace apps/api run build:strict && npm --workspace apps/web run build" },
    "deploy": { "startCommand": "node apps/api/dist/index.js", "healthcheckPath": "/health", "healthcheckTimeout": 60, "restartPolicyType": "ON_FAILURE" }
  }
  ```
  (Adjust per the actual Railway service split — web and api are separate services, each needs its own.)
- **11.2 [VERIFIED-CODE · LOW]** `docker-compose.yml` only covers Mongo + Redis for local dev. No api/web services in compose. That's fine — the `npm run dev` parallel script handles those — but it means there's no single-command "spin up the full stack" for a new contributor. Optional improvement.
- **11.3 [VERIFIED-CODE · MEDIUM]** Build tolerance (§2.7).
- **11.4 [VERIFIED-CODE · LOW]** Healthcheck endpoint is `/health` returning `{ ok: true }`. No deeper health (Mongo connected? Redis connected? Worker count?). For Railway-style aggressive restarts, a richer `/health` that fails when Mongo or Redis is unreachable would short-circuit the bad-instance loop. (Today the api refuses to start on missing REDIS_URL in production via `assertRedisOrExit`, but mid-life Mongo drops produce a hung process that Railway can't tell from a healthy one.)
- **11.5 [UNVERIFIED]** I do not have direct Railway access. Service count, env-var posture, deploy logs, restart history, memory ceiling, and Mongo/Redis provider identities are unknown to me. Operator should pull `railway status` and `railway logs --tail 200` to confirm:
  - Both `web` and `api` services are running.
  - No restart loop in the last 24h.
  - Memory usage is well below limit.
  - `REDIS_URL`, `MONGODB_URI`, `JWT_SECRET`, `NEXTAUTH_SECRET`, `COURIER_ENC_KEY`, `STRIPE_*`, `TRUSTED_PROXIES`, `PUBLIC_WEB_URL` are set on api; `NEXT_PUBLIC_API_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET` are set on web.

---

## 12. Security findings

The auth/RBAC layer is **well-engineered** (see §6.1 and the auth file at `apps/api/src/server/trpc.ts:193-380`). Specifically:
- Session-store-backed sid revocation.
- `adminProcedure` re-validates role from DB (JWT advisory only — defends against forged tokens).
- Scoped admin permissions (`scopedAdminProcedure(permission)`) emit `admin.unauthorized_attempt` audit on scope-fishing.
- `billableProcedure` correctly handles trial / active / past_due / grace / suspended.
- CSRF double-submit with constant-time compare.
- `req.ip` reads only from Express's parsed `trust proxy` value; no raw `X-Forwarded-For` fallback. (Comment in `extractClientIp` is on point.)
- HttpOnly cookies, sameSite=strict, secure in prod.
- Login limiter keyed on `${ip}:${email}` (not just email — credential stuffing across IPs still slowed, but not by sharing budget across users).
- `passwordResetLimiter` keyed on `${ip}:${email}` — same protection.
- `mintToken` for password reset stores SHA-256 hash, not plaintext; plaintext exists only in the email URL.

Findings:

- **12.1 [HIGH · VERIFIED-CODE]** Web NextAuth bypasses API session-store revocation (§2.6). This is the headline security finding.
- **12.2 [MEDIUM · VERIFIED-CODE]** CSP is in `Content-Security-Policy-Report-Only` mode (`apps/web/next.config.mjs:163`). Comment explicitly says "flip to enforce after a few production days of clean reports." Track this — the longer it sits in report-only, the longer XSS is undefended.
- **12.3 [LOW · VERIFIED-CODE]** `script-src 'self' 'unsafe-inline' 'unsafe-eval'` — the `unsafe-eval` is required by Next runtime helpers per the comment, but it's worth re-checking against current Next 14.2.35 because the historical reasons may no longer apply.
- **12.4 [LOW · VERIFIED-CODE]** `helmet()` is invoked with all defaults (`apps/api/src/index.ts:193`). For an API that doesn't serve HTML, that's mostly fine, but worth confirming `crossOriginResourcePolicy` and `crossOriginOpenerPolicy` are correct for the api/web cross-origin tRPC calls.
- **12.5 [LOW · VERIFIED-CODE]** `app.use(express.json({ limit: "1mb" }))` — fine for dashboard mutations, possibly tight for large bulk-upload endpoints. Confirm bulk-upload routes use a per-route higher limit (the `previewBulkUpload` procedure in `orders.ts:1771` should be checked for body-size handling).
- **12.6 [LOW · VERIFIED-CODE]** `/track` collector has `cors({ origin: true, credentials: false })` — wide-open by design (storefront origins post anonymously), gated by the merchant's public tracking key. The key validation must be authoritative; if the validation is weak, this is a free-fire entrypoint. Verify the key check in `tracking/collector.ts`.
- **12.7 [LOW · VERIFIED-CODE]** `JWT_SECRET` minimum length 16 (env.ts:13). For HS256, 16 chars is below modern guidance (≥32 chars / 256 bits). Bump to `min(32)` and rotate.
- **12.8 [LOW · VERIFIED-CODE]** `COURIER_ENC_KEY` enforces 32 bytes after base64-decode (good — AES-256). Documented in env.ts.
- **12.9 [INFERRED]** I did not exhaustively check that **every** admin tRPC procedure uses `adminProcedure` or `scopedAdminProcedure`. With 6 admin routers (`adminAccess`, `adminAudit`, `adminBilling`, `adminFraudNetwork`, `adminObservability`) totalling ~1,700 LOC, a per-procedure audit is its own task. A scripted check (`grep -nE "^[[:space:]]+[a-z][a-zA-Z]*: protectedProcedure" apps/api/src/server/routers/admin*.ts`) is worth running and triaging — anything in an `admin*.ts` file using bare `protectedProcedure` is suspect.

---

## 13. Highest-leverage improvements

Ordered by (impact × ease):

1. **Wire `orderSync`** (§2.1). 4 lines in `index.ts`. Closes the silent-revenue-hole risk.
2. **Update `apps/api/CLAUDE.md`** (§2.3). Doc-only. Removes the trap that produces the next regression.
3. **Surface human reasons in fraud review** (§3.1). Highest UX impact for the audience. Data already exists.
4. **Fix the SIGTERM handler** (§2.5). Real correctness fix; moderate effort; matters every redeploy.
5. **Decide on the NextAuth ↔ session-store reconciliation** (§2.6). Either drop NextAuth (Path A — clean) or add periodic re-validation (Path B — incremental). Path B is enough for now; Path A is the right SOC2-readiness move.
6. **Flip the API build to `:strict`** (§2.7). One-line change in `package.json`.
7. **Verify the `/login` styling** (§3.2). 5-minute manual probe; either close it as MCP-artifact or escalate.
8. **Add `railway.json`** (§11.1). 30-line file that captures the "how to deploy this" knowledge currently in the operator's head.
9. **Flip CSP from `Report-Only` to enforce** (§12.2). After a 7-day clean-report soak.
10. **Add "Cordon caught X for you this week" digest** (§4.2). Best-leverage churn-reduction surface.

---

## 14. Quick wins (<1 day each)

- Delete `globalLimiter` (or wire it). 5 minutes. (§2.4)
- Delete dead `verifyOrder` and `subscription` keys from `QUEUE_NAMES`. 5 minutes. (§2.2)
- Delete the inline `EmptyState` in `integrations/issues/page.tsx`, import the shared one. 5 minutes. (§3.3)
- Update `apps/api/CLAUDE.md` to remove the stale "pendingJobReplay unwired" subsection. 5 minutes. (§2.3)
- Switch API deploy command to `build:strict`. 1 line. (§2.7)
- Add a CI check that asserts every worker file's `register*` export has a call site in `index.ts`. ~30 minutes. (§2.1)
- Wire `orderSync` (§2.1). ~30 minutes including a test that asserts the repeatable lands.
- Bump `JWT_SECRET` minimum to 32 chars and rotate. ~30 minutes including the rotation procedure.
- Add `railway.json` (§11.1). ~30 minutes per service.
- Verify `/login` styling on a real Chrome tab (§3.2). 5 minutes.

---

## 15. Medium improvements (1–7 days)

- Surface human-language risk reasons in fraud review (§3.1). 2–3 days for a clean visual treatment + the side-panel deep-dive + telemetry to measure click-through.
- Reconcile NextAuth ↔ API session store (§2.6, Path B). 1 day implementation + 1 day testing.
- Fix graceful shutdown end-to-end (§2.5). 0.5 day implementation + 0.5 day load-test under SIGTERM.
- Add weekly value-recap digest + dashboard banner (§4.2). 2–3 days.
- Concurrency tuning on `pendingJobReplay` + boot-time drain pass (§7.2.1). 1 day.
- "Skip / remind me" affordance on onboarding checklist (§5.1). 0.5 day.
- Real test-SMS verification (§5.2). 1 day.
- Audit every admin router procedure for correct procedure use (§12.9). 1 day.
- CSP enforce-mode flip with 7-day soak (§12.2). 7 days calendar, ~1 day work.

---

## 16. Dangerous future scaling risks

- **16.1 [INFERRED]** Per-process LRU caches in `trpc.ts` (§10.5) — fine at 1–4 instances, propagation lag becomes a real audit issue at 10+ instances. Plan a Redis-backed cache or pubsub-based invalidation before then.
- **16.2 [INFERRED]** `webhook-process` worker concurrency 4 default (§6.2.2) — large-merchant burst will starve smaller merchants. Validate fairness under concurrent-merchant burst before the next 5 large merchants land.
- **16.3 [VERIFIED-CODE]** `MongoDB syncIndexes` runs at boot, background-async (`apps/api/src/index.ts:115-141`). On a fresh DB it's milliseconds; on a populated DB with new partial-filter indexes added in a deploy, the build can be many minutes. Two parallel deploys can both try the same syncIndex and one will see the partial build mid-flight. Worth a one-time review of the index-build behaviour against a copy of prod.
- **16.4 [INFERRED]** No connection-pool tuning visible in `lib/db.ts` (didn't read in this run) — Mongoose default `maxPoolSize` is 100. Across 4 api instances that's 400 connections to Atlas, which will hit a free / starter tier connection cap. Confirm Atlas plan tier vs. computed connection ceiling.
- **16.5 [INFERRED]** No mention of background-job retention strategy beyond `removeOnComplete: { count: 1000, age: 24h }` in `lib/queue.ts:36`. At ~1k orders/day/large-merchant × 5+ workers per order, the steady-state BullMQ key count grows. Worth Redis memory usage projection at next-quarter scale.
- **16.6 [VERIFIED-CODE]** The api caches subscription state for 30s (`subCache`). A merchant who hits `subscription_grace_expired` and pays *during* that 30s window keeps seeing the FORBIDDEN error until the cache misses. Consider an explicit `invalidateSubscriptionCache(merchantId)` call from the Stripe success webhook. (`invalidateSubscriptionCache` is exported from `trpc.ts:255` — confirm it's called from the billing webhook.)

---

## 17. "Would I trust this in production?" verdict

**Yes, with caveats.** This is more careful work than I usually see at this stage. The webhook-ingestion / OAuth / RBAC story has clearly been thought through by someone who's been bitten before — every other inline comment documents a real production bug that produced a real fix. The PendingJob → BullMQ replay ladder, the `(merchantId, source.externalId)` dedup, the install-nonce-keyed Shopify OAuth lookup, the freshness gate, the per-merchant token bucket, the audit trail — these are not theatre. They're the kind of decisions you make after a bad night.

The reasons the verdict is "with caveats" are operational, not architectural:

1. **The dead `orderSync` worker is the kind of thing that only hurts in production**, only at scale, and only on a bad day. Wire it before you have ten more big merchants. (§2.1)
2. **The web-side NextAuth bypass of the api's session revocation** is a security finding that the operator probably hasn't surfaced because nothing has gone wrong yet. The next real session-stealing incident will be the moment it matters. Address before SOC2. (§2.6)
3. **The shutdown handler will lose data on a redeploy under enough load.** Today, on small traffic, it doesn't bite. (§2.5)
4. **Internal docs lying about the codebase's current state** is a long-term debt. The next engineer or the next Claude run will burn time fixing already-fixed problems. (§2.3)
5. **Merchants seeing a number with no reason** is the trust-erosion path that turns "this product works" into "I don't know what this product is doing". (§3.1)

If I had to put one merchant on this system today and tell them "we'll catch your fraud and your webhooks won't drop", I would, and I'd mean it. If I had to put ten merchants on it tomorrow, I'd want §2.1 (orderSync) wired first. If I had to put a hundred merchants on it next quarter, I'd want all of §13 done and §16 planned.

---

## Appendix A — files I read in this audit

For traceability:

- `package.json` (root)
- `apps/api/package.json`
- `apps/web/package.json`
- `CLAUDE.md` (root, plus `apps/api/`, `apps/web/`)
- `INFRASTRUCTURE_OVERVIEW.md`
- `apps/api/src/index.ts` (full)
- `apps/api/src/env.ts` (head)
- `apps/api/src/lib/queue.ts` (head + safeEnqueue body)
- `apps/api/src/server/routers/index.ts` (full)
- `apps/api/src/server/routers/integrations.ts` (procedure list — 2,380 LOC, did not read body exhaustively)
- `apps/api/src/server/routers/orders.ts` (procedure list — 3,279 LOC, did not read body exhaustively)
- `apps/api/src/server/webhooks/integrations.ts` (full — 773 LOC)
- `apps/api/src/server/trpc.ts` (full — 444 LOC)
- `apps/api/src/server/auth.ts` (head — 200 of 594 LOC)
- `apps/api/src/server/ingest.ts` (head — 120 of 1,070 LOC; did not exhaustively trace the rest)
- `apps/api/src/middleware/rateLimit.ts` (full — 120 LOC)
- `apps/api/src/workers/orderSync.worker.ts` (selected lines via grep)
- `apps/api/src/workers/webhookRetry.ts` (head — 180 LOC)
- `apps/api/src/workers/pendingJobReplay.ts` (selected via grep)
- `apps/web/next.config.mjs` (header + headers section)
- `apps/web/src/app/layout.tsx` (full — 100 LOC)
- `apps/web/src/app/(auth)/layout.tsx` (full)
- `apps/web/src/app/(auth)/login/page.tsx` (full — 200 LOC)
- `apps/web/src/app/dashboard/layout.tsx` (full)
- `apps/web/src/app/dashboard/page.tsx` (head — 80 LOC)
- `apps/web/src/app/dashboard/getting-started/page.tsx` (full)
- `apps/web/src/components/shell/cordon-auth-shell.tsx` (head — 200 LOC)
- `apps/web/src/components/dashboard/mobile-bottom-nav.tsx` (head — 60 LOC)
- `apps/web/src/components/onboarding/onboarding-checklist.tsx` (head — 120 LOC)
- `apps/web/src/lib/auth.ts` (full — 60 LOC)
- `apps/web/src/app/api/auth/[...nextauth]/route.ts` (full)
- `packages/db/src/models/order.ts` (index lines via grep)
- `docker-compose.yml` (full)

Plus exhaustive `grep -rn` of every queue name's producers/consumers.

## Appendix B — what I did NOT verify

In the spirit of operational truth:

- I did not connect to production Mongo or Redis.
- I did not read Railway service logs or runtime config.
- I did not perform a real Shopify OAuth install end-to-end (merchant-tier accounts vs. dev-store quirks like the canonical-hostname rewrite are exactly the kind of thing that breaks only in real installs).
- I did not perform a real WooCommerce webhook delivery end-to-end.
- I did not exercise the dashboard at runtime past the `/login` page (the unstyled rendering issue would have made every UX observation low-confidence — see §3.2).
- I did not load-test, soak-test, or SIGTERM-test.
- I did not exhaustively read `orders.ts` (3,279 LOC) or `integrations.ts` (2,380 LOC) — I read their procedure lists and inspected specific procedures cited in findings, not every body.
- I did not verify connection-pool sizing (§16.4) or BullMQ key count projections (§16.5).
- I did not run `railway status` or `railway logs --tail` (Linux sandbox can't reach the Windows-installed Railway CLI).

These are the things to verify next, in priority order:
1. The `/login` styling on real Chrome (5 minutes — closes §3.2).
2. The orderSync wiring fix in production (§2.1).
3. The shutdown handler in production (§2.5).
4. The NextAuth ↔ session-store reconciliation (§2.6).
5. A real Shopify install on a fresh merchant against staging.
6. A `railway logs --tail 500` review for restart loops, OOM hints, slow-query warnings.
