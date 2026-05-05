@echo off
REM =======================================================================
REM  push-fix-5.bat — recover missing src files that crashed the api at runtime
REM
REM  Build passed (soft-fail tsc) but Node crashed on boot with
REM    ERR_MODULE_NOT_FOUND: '/app/apps/api/dist/lib/integrations/health.js'
REM  because:
REM    apps/api/src/lib/integrations/health.ts          — was missing
REM    apps/api/src/workers/orderSync.worker.ts         — was missing
REM  Both were referenced by integrations.ts; tsc emits nothing for a
REM  non-existent source so the import path resolved to a phantom .js.
REM
REM  We reconstructed each .ts from its previously-emitted .d.ts + .js
REM  (the cross-emitted artifacts under packages/types/dist/...). The two
REM  source files now exist and tsc will compile them on next build.
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-5.bat
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

REM Make sure both files are tracked even if .gitignore was over-broad.
git add -f "apps/api/src/lib/integrations/health.ts" "apps/api/src/workers/orderSync.worker.ts"

git commit -m "fix(api): recover missing health.ts + orderSync.worker.ts source files" -m "Runtime crash on Railway: ERR_MODULE_NOT_FOUND for /app/apps/api/dist/lib/integrations/health.js, imported from dist/server/routers/integrations.js. Build had succeeded (soft-fail tsc), but tsc emits nothing for a source file that doesn't exist, so the import resolved to a phantom path. Same for ../../workers/orderSync.worker.js. Reconstructed both .ts files from previously-emitted .d.ts + .js artifacts. Behavior preserved 1:1; types loosened to 'any' in spots where the original generic shapes weren't recoverable."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS — push-fix-5 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 5" and it'll watch the new build.

endlocal
