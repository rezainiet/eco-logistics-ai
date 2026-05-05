@echo off
REM =======================================================================
REM  push-fix-8.bat - run Order.syncIndexes() automatically on api boot
REM
REM  Background: fix-7 added a try/catch around Order.create that handles
REM  E11000 (mongo duplicate-key) so concurrent webhooks for the same order
REM  collapse to one Order doc. The catch can only fire when the partial
REM  unique index on (merchantId, source.externalId) actually exists on
REM  Atlas. lib/db.ts disables autoIndex in production, and the on-demand
REM  /admin/sync-indexes endpoint we added is too slow to run through
REM  Railway's HTTP proxy (proxy closes the connection at ~60s, Mongo's
REM  syncIndexes work continues server-side but we lose the ack and
REM  there's no easy way to verify completion).
REM
REM  Fix: run syncIndexes() for the hottest models in a fire-and-forget
REM  block right after connectDb(). The api binds its port immediately
REM  and starts serving — index builds happen in the background and log
REM  per-model timings to deploy logs. Self-healing: every deploy makes
REM  the production db's indexes match the schema definition without
REM  manual operator action.
REM
REM  Verification plan after deploy:
REM    1. Watch deploy logs for "[boot/syncIndexes] Order ok in <N>ms"
REM    2. Create a fresh Shopify order in eco-logistics-test-bd admin
REM    3. Confirm the staging Orders page shows it ONCE, not twice
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-8.bat
REM =======================================================================

setlocal enabledelayedexpansion

cd /d "%~dp0\.."

if exist ".git\index.lock" (
  tasklist /FI "IMAGENAME eq git.exe" 2>NUL | find /I "git.exe" >NUL
  if errorlevel 1 del /Q ".git\index.lock"
)

for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set CURRENT_BRANCH=%%b
if not "%CURRENT_BRANCH%"=="claude/staging-deploy" (
  git checkout claude/staging-deploy
  if errorlevel 1 exit /b 1
)

git add -f "apps/api/src/index.ts"

git commit -m "fix(api): auto-run Order.syncIndexes() on boot to enable race-safe ingest" -m "fix-7's E11000 catch in ingestNormalizedOrder only fires when the partial unique on (merchantId, source.externalId) actually exists on Atlas. autoIndex is OFF in prod (lib/db.ts), and /admin/sync-indexes blocks long enough that Railway's HTTP proxy closes the response before Mongo finishes — no clean ack, brittle to verify. Run syncIndexes() for the hot models (Order, WebhookInbox, Integration, Merchant, ImportJob) in a fire-and-forget block right after connectDb(). The api binds its port immediately; index builds happen in the background with per-model timings logged. Every deploy self-heals: production indexes converge to schema definition without operator action. Verified by creating Shopify order #1002 — currently lands twice (~764ms apart) because the index was never built; after this fix, the catch will collapse the race to one Order doc."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS - push-fix-8 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 8" and it'll watch the build, confirm Order
echo  syncIndexes ran in the deploy log, and create one more Shopify order
echo  to verify only a single Order doc lands.

endlocal
