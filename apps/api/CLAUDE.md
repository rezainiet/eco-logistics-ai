# apps/api — Express + tRPC + BullMQ conventions

Inherits root `CLAUDE.md`.

## Worker registration checklist

Every BullMQ worker file in `src/workers/` must:
1. Define its queue name in `src/lib/queue.ts` `QUEUE_NAMES` (one source of truth — never hardcode strings outside this object).
2. Export a `register<Name>Worker()` function that calls `registerWorker(QUEUE_NAMES.<name>, processor, opts)`.
3. If the worker is on a recurring schedule, also export `schedule<Name>(intervalMs?)` that adds the repeatable job via `getQueue(QUEUE_NAMES.<name>).add(...)`.
4. **Be wired in `src/index.ts`.** Boot order: connect DB → init queues → register every worker → start every schedule → start HTTP server.

If a worker exists in `src/workers/` but has no `register*` call in `src/index.ts`, it is dead in production no matter how many tests cover it. Treat that as a bug, not a feature flag.

### Known gap (do not ship as-is)
- `pendingJobReplay.ts` exports `startPendingJobReplayWorker()` and `ensureRepeatableSweep()` but `src/index.ts` does not call either. The dead-letter sweeper is therefore not running in production. Wire it before relying on `PendingJob` retries.

### Library functions vs worker wrappers
A worker file is a thin BullMQ wrapper around library logic in `src/lib/`. The library is what tests should import — the wrapper exists only so the library runs as a job. Removing an unwired wrapper is safe; removing the library underneath it usually isn't.

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
