@echo off
REM =======================================================================
REM  push-fix-12.bat - log Shopify webhook registration result + fix audit
REM
REM  Two changes to apps/api/src/server/routers/integrations.ts:
REM
REM  (a) Surface registerShopifyWebhooks raw result via console.log so
REM      Railway deploy logs show exactly what Shopify returned. Without
REM      this we couldn't tell whether registration succeeded — the
REM      result was only persisted in integration.webhookStatus.lastError
REM      which isn't shown in the dashboard. After fix-11 + reconnect on
REM      staging, 4 orders (#1003-#1006) created in Shopify produced zero
REM      hits at /api/integrations/webhook on Railway HTTP logs, but the
REM      integration showed Healthy. We need eyes on the actual reg
REM      object {registered: [...], errors: [...]} to figure out why.
REM
REM  (b) Fix the audit action enum bug introduced in fix-11. The new
REM      action value 'integration.shopify_webhooks_registered' isn't
REM      in the AuditLog model's action enum, so writeAudit threw
REM      ValidationError ("is not a valid enum value for path action.").
REM      Because the call is `void writeAudit(...)` it didn't crash
REM      connect — but every connect spammed the deploy log with the
REM      validation stack trace. Reuse the existing enum value
REM      'integration.shopify_webhooks_retried' (originally added for
REM      the manual retry mutation) and put `source: 'connect'` in the
REM      meta so the two call sites stay distinguishable in audit views.
REM
REM  Verification plan after deploy:
REM    1. Disconnect existing Shopify integration on staging dashboard
REM    2. Reconnect via Advanced (paste credentials)
REM    3. Tail Railway deploy logs for "[integrations.connect/shopify]"
REM       — that line will print the integration id, callbackUrl, and
REM       the {registered:[...], errors:[...]} from Shopify
REM    4. If errors[] is non-empty, the message tells us what Shopify
REM       rejected (scope, HMAC, malformed URL, rate limit, etc.)
REM    5. If registered[] has all topics and errors[] is empty, the
REM       subscription DID land — then the issue is elsewhere
REM       (delivery, HMAC, our /api/integrations/webhook handler)
REM
REM  Run from repo root:
REM      .\.claude-staging\push-fix-12.bat
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

git add -f "apps/api/src/server/routers/integrations.ts"

git commit -m "fix(integrations): log Shopify webhook reg result + use valid audit enum" -m "After fix-11 deployed, 4 Shopify orders (#1003-#1006) created on staging produced zero hits at /api/integrations/webhook even though the integration showed Healthy. registerShopifyWebhooks ran but its result was only persisted to webhookStatus.lastError on the Integration doc (not visible in the dashboard). Add console.log of the {registered, errors} object so Railway deploy logs surface exactly what Shopify returned. Also fix the audit enum bug: 'integration.shopify_webhooks_registered' isn't in the AuditLog model's action enum, so every connect threw ValidationError (void-fired so didn't crash, but spammed logs). Reuse the existing 'integration.shopify_webhooks_retried' enum value and tag with source:'connect' in meta to keep the two call sites distinguishable."

if errorlevel 1 exit /b 1

git push origin claude/staging-deploy
if errorlevel 1 exit /b 1

echo.
echo  SUCCESS - push-fix-12 deployed. Railway will auto-redeploy.
echo  Tell Claude "pushed fix 12" and it'll disconnect + reconnect
echo  Shopify, watch the [integrations.connect/shopify] log line, and
echo  diagnose what Shopify is actually returning.

endlocal
