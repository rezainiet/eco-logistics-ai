@echo off
REM =======================================================================
REM  push-fix-9.bat - restore truncated tail of apps/api/src/index.ts
REM
REM  Bug: fix-8's edit accidentally TRUNCATED apps/api/src/index.ts at
REM  line 218 — the file ended mid-comment ("// discriminate") with NO
REM  closing brace for main(), NO app.listen(), and NO main().catch()
REM  invocation. The build still succeeded because tsc is set to
REM  soft-fail on staging deploys (chore(api): soft-fail tsc on staging
REM  deploys, 9026fba), so Railway happily produced JS from broken TS.
REM
REM  Runtime symptom on the deployed container:
REM    - Container "Active/Online" but every HTTP request returns 502
REM    - Deploy logs only show: Starting Container + 2 env warnings
REM      + [redis] connected — and stop there
REM    - Missing logs: "[boot] env=" (first line of main() body),
REM      "[redis] ping ok", "[boot/syncIndexes] ...", "[api] listening"
REM    - Cause: main() function declaration never reached its closing
REM      brace at parse time, so Node never ran it, so app.listen()
REM      never bound a port, so Railway's proxy gets no response
REM
REM  Fix: restore the missing tail (lines 218-235 of the original):
REM    - rest of the /trpc-isolation jsdoc comment
REM    - app.use("/trpc", createExpressMiddleware({...}))
REM    - final error handler
REM    - server = app.listen(env.API_PORT, () => log "listening")
REM    - shutdown handler for SIGINT/SIGTERM
REM    - main()'s closing brace
REM    - main().catch(err => process.exit(1))
REM
REM  Verification plan after deploy:
REM    1. Deploy logs should now show in order:
REM         Starting Container
REM         [env] WARNING ...
REM         [redis] connected
REM         [boot] env=production port=4000 telemetry=...
REM         [redis] ping ok
REM         [boot/syncIndexes] Order ok in <N>ms
REM         [boot/syncIndexes] WebhookInbox ok in <N>ms
REM         ... (per-model)
REM         [api] listening on http://localhost:4000
REM    2. GET /health returns 200 {ok:true}
REM    3. Then create a fresh Shopify order; only ONE Order doc lands
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-9.bat
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

git commit -m "fix(api): restore truncated tail of index.ts (main close + app.listen + main().catch)" -m "fix-8's edit accidentally TRUNCATED apps/api/src/index.ts at line 218. The file ended mid-comment (// discriminate) with no closing brace for main(), no app.listen(), and no main().catch() invocation. The build still passed because tsc is set to soft-fail on staging deploys (9026fba), so Railway produced JS from broken TS. Runtime symptom: container Active/Online but every HTTP request returns 502; deploy logs end at [redis] connected with no [boot] env=, [redis] ping ok, [boot/syncIndexes], or [api] listening lines. Restored the missing tail: rest of /trpc-isolation comment, /trpc mount with createExpressMiddleware, final error handler, app.listen with listening log, SIGINT/SIGTERM shutdown handler, main close + main().catch. After this fix-8's syncIndexes IIFE will actually execute and the api will bind its port."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS - push-fix-9 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 9" and it'll watch the build, confirm the
echo  api binds its port, [boot/syncIndexes] runs for Order, then create
echo  one more Shopify order to verify only a single Order doc lands.

endlocal
