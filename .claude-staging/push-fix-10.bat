@echo off
REM =======================================================================
REM  push-fix-10.bat - admin reset-password + dedupe-orders, fix admin.ts
REM
REM  Three changes to apps/api/src/server/admin.ts:
REM
REM  (a) Restore truncated tail of /admin/sync-indexes handler. Same bug
REM      as fix-9: a previous edit cut the file mid-catch-block at line
REM      202 ("const msg = (err as Error).message;") with no
REM      summary[name]={error:msg}, no res.json(...), and no closing
REM      brace for the route handler. tsc soft-fails on staging so the
REM      build passed, but the endpoint was effectively unusable.
REM
REM  (b) New POST /admin/reset-merchant-password (X-Admin-Secret guarded)
REM      so we can recover login when operator credentials are lost.
REM      Body: { email, newPassword (min 8), actor }. Hashes via bcrypt
REM      cost 10 — matches auth.ts signup + change-password paths so the
REM      login flow validates it identically.
REM
REM  (c) New POST /admin/dedupe-orders (X-Admin-Secret guarded) that:
REM        1. Aggregates Order docs by (merchantId, source.externalId)
REM        2. For each group with count > 1, keeps the OLDEST createdAt
REM           and deleteMany's the rest
REM        3. Calls Order.syncIndexes() so the partial-unique on
REM           (merchantId, source.externalId) and the unique on
REM           (merchantId, orderNumber) finally build cleanly
REM      Idempotent. Returns a summary {dupGroupsFound, docsDeleted,
REM      syncIndexes}. Unblocks the race-fix that fix-7 + fix-8
REM      delivered: the E11000 catch in ingestNormalizedOrder can only
REM      collapse races when the partial-unique exists, and that index
REM      has been refusing to build because old duplicate Order docs
REM      from the very races we're trying to fix violate the existing
REM      (merchantId, orderNumber) unique — classic dependency loop.
REM
REM  Verification plan after deploy:
REM    1. curl POST /admin/dedupe-orders → expect {dupGroupsFound>=1,
REM       docsDeleted>=1, syncIndexes is array or {created:[...]}}
REM    2. curl POST /admin/reset-merchant-password with email +
REM       newPassword → 200 ok
REM    3. Log in to staging dashboard with that credential
REM    4. Delete existing Shopify + WC integrations from /dashboard/integrations
REM    5. Reconnect both, run "Test connection" on each
REM    6. Create a fresh order on each platform
REM    7. Verify exactly ONE Order doc lands per webhook
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-10.bat
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

git add -f "apps/api/src/server/admin.ts"

git commit -m "fix(admin): close truncated /admin/sync-indexes + add reset-password + dedupe-orders" -m "Three changes to apps/api/src/server/admin.ts: (a) restore truncated tail of /admin/sync-indexes handler — fix-7's edit cut the file mid-catch at line 202 with no res.json and no closing brace; tsc soft-fails on staging so the build passed, but the endpoint was unusable. (b) New POST /admin/reset-merchant-password (X-Admin-Secret) to recover login when operator creds are lost — bcrypt cost 10, matches auth.ts. (c) New POST /admin/dedupe-orders (X-Admin-Secret): aggregates Order docs by (merchantId, source.externalId), keeps oldest, deletes the rest, then runs Order.syncIndexes() so the partial-unique finally builds. Unblocks the race-fix from fix-7 + fix-8: the E11000 catch in ingestNormalizedOrder can only collapse races when the partial-unique exists, and that index refused to build because old duplicate orders from those very races violate the existing (merchantId, orderNumber) unique."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS - push-fix-10 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 10" and it'll wait for the build, then
echo  reset masudrezaog3@gmail.com's password to a known value, run
echo  /admin/dedupe-orders to clean state, and give you the login.

endlocal
