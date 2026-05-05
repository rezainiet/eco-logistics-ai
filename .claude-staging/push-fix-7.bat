@echo off
REM =======================================================================
REM  push-fix-7.bat - race-safe ingest + admin sync-indexes endpoint
REM
REM  Bug context (from staging WC webhook test):
REM    - Created WC order #17 -> WC fired BOTH order.created AND order.updated
REM      near-simultaneously
REM    - webhookProcess worker concurrency=N processed both jobs in parallel
REM    - Both ingestNormalizedOrder calls passed the findOne dedup BEFORE
REM      either Order.create committed -> two duplicate Order docs
REM    - Production has autoIndex=false (lib/db.ts), so the partial unique
REM      index on (merchantId, source.externalId) was never built on the
REM      fresh Atlas DB; Mongo accepted both inserts
REM
REM  Fixes:
REM    1) apps/api/src/server/ingest.ts: wrap Order.create in try/catch.
REM       On E11000, refund the quota reservation we made and re-fetch the
REM       winner so the caller still gets a valid orderId. Belt-and-
REM       suspenders to the existing findOne dedup.
REM    2) apps/api/src/server/admin.ts: new POST /admin/sync-indexes
REM       endpoint (X-Admin-Secret guarded) that runs Model.syncIndexes()
REM       across every collection. Idempotent. Lets us build the missing
REM       partial-unique index on Atlas without redeploying or running a
REM       one-off shell.
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-7.bat
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

git add -f "apps/api/src/server/ingest.ts" "apps/api/src/server/admin.ts"

git commit -m "fix(ingest,admin): race-safe Order.create + admin sync-indexes endpoint" -m "WC order.created + order.updated webhooks fire near-simultaneously when an order is POSTed with status=processing. The webhookProcess worker has concurrency >1, so two ingestNormalizedOrder calls passed the findOne dedup before either Order.create committed -> duplicate Orders. Hardened ingest with a try/catch around Order.create that handles E11000 (mongo dup-key) by refunding the quota and re-fetching the winner. Belt-and-suspenders to the existing findOne. Added POST /admin/sync-indexes (X-Admin-Secret) so we can build the partial-unique index on (merchantId, source.externalId) on a fresh Atlas DB without redeploying or shelling in. Required because lib/db.ts disables autoIndex in production."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS - push-fix-7 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 7" and it'll watch the build, run /admin/sync-indexes,
echo  delete the existing duplicate, and create a fresh WC order to verify only one
echo  Order doc lands.

endlocal
