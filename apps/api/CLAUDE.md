# apps/api — Express + tRPC + BullMQ conventions

Inherits root `CLAUDE.md`.

## Worker registration checklist

Every BullMQ worker file in `src/workers/` must:
1. Define its queue name in `src/lib/queue.ts` `QUEUE_NAMES` (one source of truth — never hardcode strings outside this object).
2. Export a `register<Name>Worker()` function that calls `registerWorker(QUEUE_NAMES.<name>, processor, opts)`.
3. If the worker is on a recurring schedule, also export `schedule<Name>(intervalMs?)` that adds the repeatable job via `getQueue(QUEUE_NAMES.<name>).add(...)`.
4. **Be wired in `src/index.ts`.** Boot order: connect DB → init queues → register every worker → start every schedule → start HTTP server.

If a worker exists in `src/workers/` but has no `register*` call in `src/index.ts`, it is dead in production no matter how many tests cover it. Treat that as a bug, not a feature flag.

### Currently wired (runtime truth — last verified 2026-05-07)
Every worker file in `src/workers/` is wired. Verified by grep of every
`register*Worker` and `schedule*` export against `src/index.ts`. The set
boots in this order under `if (env.REDIS_URL)`:

1. `registerTrackingSyncWorker` + `scheduleTrackingSync`
2. `registerRiskRecomputeWorker` (consumer-only)
3. `registerWebhookRetryWorker` + `scheduleWebhookRetry`
4. `registerWebhookProcessWorker` (consumer-only)
5. `registerFraudWeightTuningWorker` + `scheduleFraudWeightTuning`
6. `registerCommerceImportWorker` (consumer-only)
7. `registerAutomationBookWorker` (consumer-only)
8. `registerAutomationSmsWorker` (consumer-only)
9. `registerAutomationStaleWorker` + `scheduleAutomationStaleSweep`
10. `registerAutomationWatchdogWorker` + `scheduleAutomationWatchdog`
11. `registerCartRecoveryWorker` + `scheduleCartRecovery`
12. `registerTrialReminderWorker` + `scheduleTrialReminder`
13. `registerSubscriptionGraceWorker` + `scheduleSubscriptionGrace`
14. `registerAwbReconcileWorker` + `scheduleAwbReconcile`
15. **`registerOrderSyncWorker` + `scheduleOrderSync`** — polling
    fallback for upstream order ingest. Wired 2026-05-07; the comment
    in `lib/queue.ts` saying "runs alongside webhooks" is now true.
16. `startPendingJobReplayWorker` + `ensureRepeatableSweep` — DLQ
    replay sweeper. The dead-letter floor for `safeEnqueue`.

If you're auditing this list against `src/index.ts`, both `register*`
calls and `schedule*` calls must be present for every worker that has
both exported. Adding a worker file without wiring it ships dead code.

### Library functions vs worker wrappers
A worker file is a thin BullMQ wrapper around library logic in `src/lib/`. The library is what tests should import — the wrapper exists only so the library runs as a job. Removing an unwired wrapper is safe; removing the library underneath it usually isn't.

## Graceful shutdown contract

`src/index.ts` registers a single `shutdown(signal)` handler for SIGINT
and SIGTERM. The order is intentional and any new code that touches
shutdown must preserve it:

1. **Stop accepting new connections**: `await new Promise(r =>
   server.close(() => r()))`. Without the await, in-flight requests
   race `process.exit` and respond with TCP RST.
2. **Drain workers + queues**: `await shutdownQueues()`. BullMQ
   `worker.close()` lets the current job finish, then disposes; the
   shared Redis connection is `quit`'d at the end.
3. **Close Mongo**: `await disconnectDb()`. The api server used to
   skip this; SIGTERM left in-flight queries to be force-closed by
   `process.exit`.
4. **`process.exit(0)`** only after 1–3 resolve.

A 25 s watchdog `setTimeout` (`unref`'d) force-exits if any step
deadlocks; this sits inside Railway's default 30 s drain window with
margin. The handler is idempotent — a second SIGTERM during shutdown
is logged and ignored.

## Routers
- tRPC routers live in `src/server/routers/`, composed into `src/server/routers/index.ts` as `appRouter`.
- The router type is re-exported from `packages/types/src/router.ts` so `apps/web` consumes a single `AppRouter` symbol via `@ecom/types`. Don't break this seam — `apps/web` should never import `apps/api/...` directly.
- Express-mounted REST routers (auth, admin, webhooks) live alongside in `src/server/`.

## Webhooks
- All webhook entry points live in `src/server/webhooks/`. Each verifies its own signature (HMAC, JWT, Twilio, Stripe) before doing anything stateful.
- Webhooks enqueue work via `safeEnqueue` (per-merchant rate-limited) rather than processing inline. Inline processing is reserved for low-volume system events (e.g. Stripe billing) where ordering matters.

## Build
- `npm --workspace apps/api run build` runs `tsc -p tsconfig.build.json` in tolerant mode (emits even on type errors). Use `npm run build:strict` to gate on a clean typecheck.
- Production = `node dist/index.js`. Don't add tsx to the production runtime — `tsx` is a dev/test dep.

## Tests
- Vitest + `mongodb-memory-server` (`tests/globalSetup.ts`). Run with `npm --workspace apps/api test`.
- Test files mirror the unit they cover: `tests/<router-or-lib>.test.ts`. Worker tests exercise the library function directly, not the BullMQ wrapper, unless the wrapper has registration/scheduling logic worth covering.

## Stripe redirect URLs
- Success / cancel land on `/dashboard/billing?stripe=...` (see `src/server/routers/billing.ts`). There is no `/payment-success` or `/payment-failed` route in production. If a future flow needs one, add it intentionally — it isn't there now.
