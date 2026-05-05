@echo off
REM =======================================================================
REM  push-fix-6.bat — comprehensive missing-symbol audit + recovery
REM
REM  Fix-5 went ACTIVE then crashed at boot with:
REM    SyntaxError: '@ecom/types' does not provide an export named
REM    'WOO_SITE_URL_ERROR'
REM
REM  Rather than push narrow fixes that surface the next missing symbol,
REM  ran a static auditor over every named import in apps/api/src that
REM  resolves to a workspace package. AUDIT result before this commit:
REM    isAllowedWooSiteUrl   from "@ecom/types"
REM    WOO_SITE_URL_ERROR    from "@ecom/types"
REM    deleteWooWebhooks     from "../../lib/integrations/woocommerce.js"
REM
REM  All three are now implemented:
REM    - packages/types/src/index.ts: WOO_SITE_URL_ERROR + isAllowedWooSiteUrl
REM      (https any host; http only for localhost / *.local / *.test
REM      / *.localhost / 127.0.0.1 / ::1).
REM    - apps/api/src/lib/integrations/woocommerce.ts: deleteWooWebhooks
REM      mirroring registerWooWebhooks. Per-id outcome:
REM        200/204 -> deleted; 404 -> alreadyGone; 401/403 -> retry once
REM        with querystring auth (matches the persisted authStrategy
REM        contract). Returns the discriminated union the caller expects:
REM          { ok: true, deleted, alreadyGone }
REM          { ok: false, kind, detail }
REM
REM  Re-ran the auditor afterward: AUDIT PASS — every named import in
REM  apps/api/src resolves to an export. So this push should not surface
REM  a fresh SyntaxError on the next deploy.
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-6.bat
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

git add -f "packages/types/src/index.ts" "apps/api/src/lib/integrations/woocommerce.ts"

git commit -m "fix(api,types): close 3 missing-export gaps that crashed api at boot" -m "Fix-5 emitted JS that imported symbols which weren't exported, so Node's module linker threw SyntaxError before the server bound a port. Static audit over every named import in apps/api/src that resolves to a workspace package found exactly three gaps; all three are now closed: 1) packages/types: export const WOO_SITE_URL_ERROR + export function isAllowedWooSiteUrl (single source of truth shared by web form + tRPC connect mutation; https any host, http only for local-dev hosts). 2) apps/api/src/lib/integrations/woocommerce: export async function deleteWooWebhooks (mirrors registerWooWebhooks; per-id 200/204=deleted, 404=alreadyGone, 401/403=retry once with querystring auth; returns the { ok: true, deleted, alreadyGone } | { ok: false, kind, detail } shape the disconnect flow already consumes). Re-ran the auditor: PASS — no further unresolved imports. Local typecheck still gates main branch."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS - push-fix-6 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 6" and it'll watch the new build.

endlocal
