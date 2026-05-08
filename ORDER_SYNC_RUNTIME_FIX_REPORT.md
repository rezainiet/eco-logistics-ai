# Order Sync Runtime Fix Report

Date: 2026-05-08

## 1. Root Cause Analysis

The polling fallback worker was operationally wired but could fail functionally.

`apps/api/src/workers/orderSync.worker.ts` called `adapter.fetchSampleOrders(creds, limit, since)` and then read `fetched.rawDeliveries`. Before this fix, the shared `FetchSampleResult` contract only declared `{ ok, count, sample, error }`, and both Shopify and WooCommerce adapters returned normalized `sample` rows only.

Runtime effect: a poll that successfully fetched upstream orders could produce `sample.length > 0` while `rawDeliveries` was `undefined`. The worker then treated the poll as an empty delivery set, wrote sync status `ok`, and returned `{ enqueued: 0, duplicates: 0, failed: 0 }`. That meant webhook outage recovery could silently import zero orders.

A second runtime issue was found during validation: `orderSync.worker.ts` used `integration.lastSyncedAt` as the upstream cursor, but the Integration Mongoose schema only declared `lastSyncAt`. Mongoose strict mode dropped `lastSyncedAt`, so the polling cursor was not durable. This made delayed/backlog recovery less reliable and could cause repeated wide polling windows.

## 2. Runtime Evidence

Verified code path:

- API boot imports and registers `registerOrderSyncWorker()` and schedules `scheduleOrderSync()` when Redis is configured.
- The `order-sync` BullMQ worker runs with concurrency `1`.
- The repeatable sweep is scheduled every 5 minutes by default.
- `runOrderSyncOnce()` scans connected Shopify and WooCommerce integrations.
- `syncOneIntegration()` decrypts integration credentials, passes the `lastSyncedAt` cursor into the adapter, stamps each raw delivery into `WebhookInbox`, then optionally enqueues `webhook-process`.
- `WebhookInbox` replay uses the same adapter normalization and `ingestNormalizedOrder()` path as primary webhooks.

Verified by local tests:

- Shopify polling fetch now sends `created_at_min` and emits `rawDeliveries`.
- WooCommerce polling fetch now sends `after` and emits `rawDeliveries`.
- Polling-created inbox rows replay into real `Order` records.
- A second poll with the same upstream order collapses as a duplicate at the inbox layer.
- Only one `Order` and one `WebhookInbox` row are created per upstream external id.

## 3. Affected Systems

Directly affected:

- `orderSync.worker.ts`
- `IntegrationAdapter.fetchSampleOrders`
- Shopify adapter polling path
- WooCommerce adapter polling path
- Integration schema cursor durability
- `WebhookInbox` recovery ingestion path

Not changed:

- Primary webhook HTTP handlers
- HMAC verification
- `replayWebhookInbox()` semantics
- `PendingJob` dead-letter schema
- Order duplicate guard in `ingestNormalizedOrder()`
- Fraud, address quality, and intent scoring execution order

## 4. Blast-Radius Analysis

The fix is low blast radius because polling now adds data the worker already expected instead of changing the webhook pipeline.

Compatibility notes:

- `rawDeliveries` is optional on `FetchSampleResult`, so preview-only and custom adapters remain source compatible.
- `fetchSampleOrders` now accepts optional `since?: Date`. Existing two-argument call sites continue working.
- The worker now fails loud if an adapter returns preview samples without raw deliveries. This prevents future silent success states.
- The added `lastSyncedAt` field is additive to the Integration schema and does not migrate or rewrite existing rows.

## 5. Exact Fix Implemented

Implemented changes:

- Added optional `rawDeliveries` to `FetchSampleResult`.
- Added optional `since?: Date` to `IntegrationAdapter.fetchSampleOrders`.
- Shopify polling now:
  - requests orders in ascending `created_at` order,
  - applies `created_at_min` when a cursor exists,
  - returns raw webhook-shaped deliveries using topic `orders/create`.
- WooCommerce polling now:
  - requests orders in ascending date order,
  - applies `after` when a cursor exists,
  - returns raw webhook-shaped deliveries using topic `order.created`.
- `orderSync.worker.ts` now logs and marks the integration errored when sample rows exist but raw deliveries are missing.
- `Integration` schema now declares `lastSyncedAt` as the polling fallback cursor.
- Added focused regression tests for Shopify and WooCommerce polling recovery.
- Added the existing `@ecom/branding` source alias to Vitest config so current integration tests can collect in this dirty worktree.

## 6. Local Verification Results

Passed:

```text
npm.cmd --workspace apps/api test -- integrations.test.ts
```

Result:

```text
1 test file passed
32 tests passed
```

This includes the new Shopify and WooCommerce polling recovery tests.

Build verification:

```text
npm.cmd --workspace apps/api run build
```

Result: build command exited `0` and emitted JS, but TypeScript reported unrelated existing errors in branding/admin files:

```text
src/lib/branding-store.ts: Cannot find module '@ecom/branding'
src/lib/email.ts: Cannot find module '@ecom/branding'
src/server/routers/adminBranding.ts: Cannot find module '@ecom/branding'
src/server/routers/adminBranding.ts: writeAdminAudit calls missing subjectId
```

These files were already part of unrelated dirty-worktree branding/admin changes and are not caused by the order-sync fix.

Full local API boot was not run against `.env` because this checkout points at remote staging infrastructure:

```text
NODE_ENV=development
MONGODB_URI=mongodb+srv://.../ecom_staging
REDIS_URL=rediss://...upstash.io:6379/
```

Starting the API locally would register workers and schedules against that shared Redis and could process staging jobs.

## 7. Railway Verification Results

Railway verification is blocked from this machine.

Commands attempted:

```text
railway --version
railway status
```

Result:

```text
railway 4.42.1
Warning: failed to refresh OAuth token: Token refresh failed: invalid_grant
No linked project found. Run railway link to connect to a project
```

No production deploy or production log inspection was performed. Required next step is to refresh Railway auth and link this checkout to the correct project/environment before running deploy/log verification.

## 8. Replay and Idempotency Verification

Passed focused replay/idempotency behavior:

- Polling writes to `WebhookInbox` instead of creating `Order` directly.
- Replay normalizes the raw payload with the same adapter path used by webhooks.
- Duplicate polling delivery returns `{ enqueued: 0, duplicates: 1, failed: 0 }`.
- Duplicate polling delivery does not create a second `Order`.
- Duplicate polling delivery does not create a second `WebhookInbox` row.

Broader replay regression command:

```text
npm.cmd --workspace apps/api test -- queue-reliability.test.ts pending-job-replay.test.ts webhookIdempotencyDurability.test.ts
```

Result:

```text
queue-reliability.test.ts: passed, 6 tests
pending-job-replay.test.ts: passed, 6 tests
webhookIdempotencyDurability.test.ts: 5 passed, 1 failed
```

The failing webhook durability test failed while listing indexes on `test.webhookinboxes` before the collection existed:

```text
MongoServerError: ns does not exist: test.webhookinboxes
```

The behavioral durability tests in that file passed, including replay after payload reap and the second-line `Order.externalId` duplicate guard.

## 9. Remaining Risks

- Railway runtime verification is incomplete until CLI auth/link are restored.
- Current worktree contains broad unrelated changes. Commit staging must include only order-sync-owned hunks.
- Existing TypeScript errors in branding/admin files still block strict typecheck.
- The first poll for existing integrations with no durable `lastSyncedAt` may fetch the first page of recent/all upstream orders depending on provider API behavior. Existing inbox/order idempotency should collapse duplicates, but operators should watch queue backlog and upstream API rate limits after deploy.
- Cursor semantics use upstream `placedAt`. Orders without `placedAt` are captured but do not advance the cursor, causing safe re-fetch rather than data loss.

## 10. Operational Readiness Verdict

Local runtime behavior for the polling recovery path is fixed and verified.

The change is safe for replay durability and webhook idempotency because polled orders now enter through `WebhookInbox` and reuse the existing replay/normalization/order-ingest path. The fix should be considered deploy-ready after Railway auth/link are restored and production boot/log verification confirms:

- API boot healthy
- `order-sync` worker registered
- repeatable order-sync sweep scheduled
- no `order_sync.contract_mismatch` events
- no queue failures or PendingJob replay regressions
- no unexpected duplicate order creation
