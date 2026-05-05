@echo off
REM =======================================================================
REM  push-fix-3.bat — runtime ERR_MODULE_NOT_FOUND for @ecom/db
REM
REM  api built fine, but at runtime Node looks up @ecom/db's main and gets
REM  './src/index.js' which only exists as .ts source. We point main +
REM  exports at the dist/ artifacts (which the build does produce). Adds
REM  a 'build' script to each workspace package so Railway's
REM  --workspace ... run build --if-present line actually runs tsc on
REM  them (without 'build' it was skipping them, leaving dist/ stale).
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-3.bat
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

copy /Y ".claude-staging\db-package.json" "packages\db\package.json" >NUL
copy /Y ".claude-staging\types-package.json" "packages\types\package.json" >NUL
echo [info] packages/db/package.json + packages/types/package.json updated

git add -f "packages/db/package.json" "packages/types/package.json"

git commit -m "fix(workspaces): point @ecom/db + @ecom/types main at dist/" -m "Runtime ERR_MODULE_NOT_FOUND on Railway: api imported '@ecom/db' which Node resolved to './src/index.js' per the package.json main, but src/ only contains .ts source. tsc emits to dist/. Switch main + exports + types to ./dist/ artifacts. Also add a 'build' script to each so 'npm --workspace packages/db run build --if-present' actually compiles them (was previously a no-op since the script was missing)."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS — push-fix-3 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 3" and it'll watch the new build.

endlocal
